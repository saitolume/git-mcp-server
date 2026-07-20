import { isAbsolute } from "node:path";
import { throwIfDeadlineExceeded, withOperationDeadline } from "../deadline.js";
import type { BridgeResult } from "../domain/result.js";
import { assertWellFormedGitText } from "../domain/git-text.js";
import {
  inspectRepository,
  resolveRepositoryIdentity,
  type RepositoryIdentity,
  type RepositorySnapshot,
} from "../git/repository.js";
import type { GitRunner } from "../git/runner.js";
import type { AuditLog } from "../state/audit.js";
import type { BeginResult, OperationJournal } from "../state/journal.js";
import type { RepositoryLock } from "../state/repository-lock.js";
import type { RepositoryRegistry } from "../state/repository-registry.js";
import type { OperationRequestRecord, OperationResultRecord } from "../state/records.js";

export interface MutationCallbacks<T> {
  preflight(snapshot: RepositorySnapshot): Promise<Readonly<Record<string, unknown>>>;
  mutate(): Promise<T>;
  postflight(value: T): Promise<Readonly<Record<string, unknown>>>;
  classify(error: unknown): BridgeResult<T>;
  warnings?(value: T): readonly string[] | Promise<readonly string[]>;
  afterPersist?(result: BridgeResult<T>): Promise<void>;
}

export type OperationProgressPhase = "preflight" | "executing" | "postflight";
export type OperationProgress = (phase: OperationProgressPhase) => void | Promise<void>;

/** Typed control flow for a mutation that proved a non-success terminal outcome after Git started. */
export class ProvenMutationOutcome<T> extends Error {
  readonly result: BridgeResult<T>;

  constructor(result: BridgeResult<T>) {
    if (result.status !== "failed" && result.status !== "conflicted" && result.status !== "indeterminate") {
      throw new TypeError("A proven mutation outcome must be failed, conflicted, or indeterminate");
    }
    super(result.error?.message ?? "Mutation completed with a proven non-success outcome");
    this.name = "ProvenMutationOutcome";
    this.result = result;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Protocol-level failure used when no terminal operation result can be proven durable. */
export class TerminalResultUnavailable extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super("No terminal operation result could be durably verified");
    this.name = "TerminalResultUnavailable";
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Terminal publication failed and releasing the repository lock failed as well. */
export class TerminalResultUnavailableAfterReleaseFailure extends TerminalResultUnavailable {
  constructor(requestId: string) {
    super(requestId);
    this.name = "TerminalResultUnavailableAfterReleaseFailure";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface MutationExecution<T> {
  request: OperationRequestRecord;
  callbacks: MutationCallbacks<T>;
  progress?: OperationProgress;
}

export interface MutationCoordinatorDependencies {
  runner: GitRunner;
  lock: RepositoryLock;
  journal: OperationJournal;
  audit: AuditLog;
  registry: RepositoryRegistry;
  resolveIdentity?: (runner: GitRunner, repository: string, signal?: AbortSignal) => Promise<RepositoryIdentity>;
  inspect?: (runner: GitRunner, repository: string, signal?: AbortSignal) => Promise<RepositorySnapshot>;
  now?: () => string;
  monotonicNow?: () => number;
  onLockReleaseFailure?: (requestId: string) => void | Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  throwIfDeadlineExceeded(signal);
}

function repositoryPath(request: OperationRequestRecord): string {
  const input = request.input;
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Mutation request input must be an object");
  }
  const repository = (input as Record<string, unknown>).repository;
  if (typeof repository !== "string" || repository.length === 0 || !isAbsolute(repository)) {
    throw new TypeError("Mutation request repository must be a non-empty absolute path");
  }
  return assertWellFormedGitText(repository, "Mutation request repository");
}

function assertSameIdentity(selected: RepositoryIdentity, observed: RepositoryIdentity, expectedRepositoryId: string): void {
  if (selected.repositoryId !== expectedRepositoryId) throw new Error("Resolved repository identity does not match the operation request");
  if (observed.repositoryId !== selected.repositoryId || observed.commonGitDir !== selected.commonGitDir
    || observed.root !== selected.root || observed.gitDir !== selected.gitDir) {
    throw new Error("Repository identity changed while acquiring the mutation lock");
  }
}

function bindResult<T>(request: OperationRequestRecord, result: BridgeResult<T>): BridgeResult<T> {
  return {
    ...result,
    request_id: request.requestId,
    repository_id: request.repositoryId,
    operation: request.operation,
  };
}

function indeterminate<T>(request: OperationRequestRecord, observedBefore?: Readonly<Record<string, unknown>>): BridgeResult<T> {
  return {
    status: "indeterminate",
    request_id: request.requestId,
    repository_id: request.repositoryId,
    operation: request.operation,
    ...(observedBefore === undefined ? {} : { observed_before: observedBefore }),
    warnings: [],
    error: {
      code: "OPERATION_INDETERMINATE",
      message: "The mutation started but its final repository state could not be confirmed",
    },
  };
}

function warning<T>(result: BridgeResult<T>, message: string): BridgeResult<T> {
  return { ...result, warnings: [...result.warnings, message] };
}

function emitProgress(progress: OperationProgress | undefined, phase: OperationProgressPhase): void {
  try {
    const delivery = progress?.(phase);
    if (delivery !== undefined) void Promise.resolve(delivery).catch(() => undefined);
  }
  catch { /* Progress transport cannot alter the mutation result. */ }
}

function resultFromRecord<T>(record: OperationResultRecord): BridgeResult<T> {
  return record.result as BridgeResult<T>;
}

function hookChangedPaths(result: BridgeResult<unknown>): readonly string[] | undefined {
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) return undefined;
  const value = (result.data as Record<string, unknown>).hook_changed_paths;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

export class MutationCoordinator {
  private readonly resolveIdentity: NonNullable<MutationCoordinatorDependencies["resolveIdentity"]>;
  private readonly inspect: NonNullable<MutationCoordinatorDependencies["inspect"]>;
  private readonly now: () => string;
  private readonly monotonicNow: () => number;

  constructor(private readonly dependencies: MutationCoordinatorDependencies) {
    this.resolveIdentity = dependencies.resolveIdentity ?? resolveRepositoryIdentity;
    this.inspect = dependencies.inspect ?? inspectRepository;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.monotonicNow = dependencies.monotonicNow ?? Date.now;
  }

  async execute<T>(execution: MutationExecution<T>, signal?: AbortSignal): Promise<BridgeResult<T>>;
  async execute<T>(request: OperationRequestRecord, callbacks: MutationCallbacks<T>, signal?: AbortSignal): Promise<BridgeResult<T>>;
  async execute<T>(
    requestOrExecution: OperationRequestRecord | MutationExecution<T>,
    callbacksOrSignal?: MutationCallbacks<T> | AbortSignal,
    explicitSignal?: AbortSignal,
  ): Promise<BridgeResult<T>> {
    const isExecution = Object.hasOwn(requestOrExecution, "callbacks");
    const execution = isExecution
      ? requestOrExecution as MutationExecution<T>
      : { request: requestOrExecution as OperationRequestRecord, callbacks: callbacksOrSignal as MutationCallbacks<T> };
    const signal = isExecution ? callbacksOrSignal as AbortSignal | undefined : explicitSignal;
    if (execution.callbacks === undefined) throw new TypeError("Mutation callbacks are required");
    return withOperationDeadline(execution.request.operation, signal, (deadlineSignal) =>
      this.executeWithinDeadline(execution, deadlineSignal));
  }

  private async executeWithinDeadline<T>(
    execution: MutationExecution<T>,
    signal: AbortSignal,
  ): Promise<BridgeResult<T>> {
    const startedAt = this.monotonicNow();
    const repository = repositoryPath(execution.request);
    throwIfAborted(signal);
    const selected = await this.resolveIdentity(this.dependencies.runner, repository, signal);
    if (selected.repositoryId !== execution.request.repositoryId) {
      throw new Error("Resolved repository identity does not match the operation request");
    }
    const lockHandle = await this.dependencies.lock.acquire(selected.repositoryId, signal);
    let result: BridgeResult<T>;
    try {
      throwIfAborted(signal);
      const snapshot = await this.inspect(this.dependencies.runner, selected.root, signal);
      assertSameIdentity(selected, snapshot, execution.request.repositoryId);
      throwIfAborted(signal);
      const begin = await this.dependencies.journal.begin({
        requestId: execution.request.requestId,
        operation: execution.request.operation,
        repositoryId: execution.request.repositoryId,
        input: execution.request.input,
      });
      result = begin.kind !== "execute"
        ? await this.replay(begin, execution.callbacks)
        : await this.executeFirst(execution, snapshot, startedAt, signal);
    } catch (error) {
      try {
        await lockHandle.release();
      } catch (releaseError) {
        if (error instanceof TerminalResultUnavailable) {
          throw new TerminalResultUnavailableAfterReleaseFailure(error.requestId);
        }
        throw new AggregateError([error, releaseError], "Mutation failed and its repository lock could not be released");
      }
      throw error;
    }
    try {
      await lockHandle.release();
    } catch {
      try { await this.dependencies.onLockReleaseFailure?.(execution.request.requestId); }
      catch { /* A diagnostic sink cannot alter an already durable terminal result. */ }
    }
    return result;
  }

  private async replay<T>(begin: Exclude<BeginResult, { kind: "execute" }>, callbacks: MutationCallbacks<T>): Promise<BridgeResult<T>> {
    let result = resultFromRecord<T>(begin.result);
    if (callbacks.afterPersist !== undefined) {
      try { await callbacks.afterPersist(result); }
      catch { result = warning(result, "Post-persistence cleanup failed"); }
    }
    return result;
  }

  private async executeFirst<T>(
    execution: MutationExecution<T>,
    snapshot: RepositorySnapshot,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<BridgeResult<T>> {
    const { request, callbacks } = execution;
    let observedBefore: Readonly<Record<string, unknown>> | undefined;
    let mutationStarted = false;
    let candidate: BridgeResult<T>;
    try {
      await this.dependencies.registry.put({
        repositoryId: snapshot.repositoryId,
        root: snapshot.root,
        gitDir: snapshot.gitDir,
        commonGitDir: snapshot.commonGitDir,
        lastSeenAt: this.now(),
      });
      throwIfAborted(signal);
      emitProgress(execution.progress, "preflight");
      throwIfAborted(signal);
      observedBefore = await callbacks.preflight(snapshot);
      throwIfAborted(signal);
      emitProgress(execution.progress, "executing");
      throwIfAborted(signal);
      mutationStarted = true;
      const value = await callbacks.mutate();
      const observedAfter = await callbacks.postflight(value);
      emitProgress(execution.progress, "postflight");
      let warnings: readonly string[] = [];
      if (callbacks.warnings !== undefined) {
        try {
          const supplied = await callbacks.warnings(value);
          if (!Array.isArray(supplied) || supplied.some((entry) => typeof entry !== "string" || entry.length === 0)) {
            throw new TypeError("Mutation warnings must be non-empty strings");
          }
          warnings = [...supplied];
        } catch {
          warnings = ["Mutation diagnostics could not be collected after success was proven"];
        }
      }
      candidate = {
        status: "succeeded",
        operation: request.operation,
        observed_before: observedBefore,
        observed_after: observedAfter,
        data: value,
        warnings,
      };
    } catch (error) {
      if (mutationStarted) {
        candidate = error instanceof ProvenMutationOutcome ? error.result : indeterminate(request, observedBefore);
        if (observedBefore !== undefined) {
          candidate = { ...candidate, observed_before: observedBefore };
        }
      }
      else {
        try { candidate = callbacks.classify(error); }
        catch {
          candidate = {
            status: "failed", operation: request.operation, warnings: [],
            error: { code: "INVALID_INPUT", message: "The mutation failed before execution and could not be classified" },
          };
        }
        if (observedBefore !== undefined && candidate.observed_before === undefined) {
          candidate = { ...candidate, observed_before: observedBefore };
        }
      }
    }

    const bound = bindResult(request, candidate);
    let persisted: OperationResultRecord;
    try {
      persisted = await this.dependencies.journal.complete(request.requestId, bound);
    } catch {
      try {
        const fallback = await this.dependencies.journal.completeIndeterminate(request.requestId);
        return resultFromRecord<T>(fallback);
      } catch {
        throw new TerminalResultUnavailable(request.requestId);
      }
    }
    let durable = resultFromRecord<T>(persisted);
    if (callbacks.afterPersist !== undefined) {
      try { await callbacks.afterPersist(durable); }
      catch { durable = warning(durable, "Post-persistence cleanup failed"); }
    }
    try {
      const durationMs = Math.max(0, Math.floor(this.monotonicNow() - startedAt));
      const changedPaths = hookChangedPaths(durable);
      await this.dependencies.audit.append({
        timestamp: this.now(),
        requestId: request.requestId,
        operation: request.operation,
        repositoryId: request.repositoryId,
        status: durable.status,
        durationMs,
        ...(durable.error === undefined ? {} : { errorCode: durable.error.code, errorMessage: durable.error.message }),
        ...(changedPaths === undefined ? {} : { hookChangedPaths: changedPaths }),
      });
    } catch {
      durable = warning(durable, "Audit append failed after the terminal result was persisted");
    }
    return durable;
  }
}
