import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BridgeRejection, type BridgeResult } from "../domain/result.js";
import {
  AtomicJsonDurabilityError, atomicCreateJson, atomicWriteJson, canonicalStringify, readJson,
  type AtomicCreateJsonOutcome,
} from "./atomic-json.js";
import type { StatePaths } from "./paths.js";
import {
  sanitizeAndValidateBridgeResult, sanitizePersistentJson, validateOperationRequestRecord,
  migrateLegacyHookFailureRecord, validateOperationResultRecord, validateOperationStartedRecord, validateRepositoryId,
  validateSafeId, type OperationRequestRecord, type OperationResultRecord,
} from "./records.js";

export interface BeginOperation {
  requestId: string;
  operation: string;
  repositoryId: string;
  input: unknown;
}

export type BeginResult =
  | { kind: "execute" }
  | { kind: "replay"; result: OperationResultRecord }
  | { kind: "indeterminate"; result: OperationResultRecord };

export type RecoveryCandidate =
  | { kind: "candidate"; requestId: string; repositoryId: string }
  | { kind: "corrupt"; requestId: string; error: string };

export type RecoveryResult =
  | { kind: "recovered"; requestId: string; result: OperationResultRecord }
  | { kind: "terminal"; requestId: string; result: OperationResultRecord };

export type ResultPublicationKind = "terminal" | "indeterminate-fallback" | "durability-fallback";

export interface ResultPublication {
  readonly kind: ResultPublicationKind;
  readonly path: string;
  readonly record: OperationResultRecord;
}

export interface OperationJournalOptions {
  now?: () => string;
  pid?: number;
  onOperationsDirectorySynced?: (directory: string) => void | Promise<void>;
  publishResult?: (publication: ResultPublication) => Promise<AtomicCreateJsonOutcome | void>;
  syncOperationDirectory?: (directory: string) => Promise<void>;
  onResultPublicationWarning?: (requestId: string) => void | Promise<void>;
}

export const COMMIT_MESSAGE_PLACEHOLDER = "[COMMIT_MESSAGE_REDACTED]";
const INDETERMINATE_MESSAGE = "The operation started but no terminal result was durably recorded";

function sanitizeOperationInput(operation: string, input: unknown): unknown {
  const sanitized = sanitizePersistentJson(input);
  if (operation !== "git_commit" || sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)
    || Object.getPrototypeOf(sanitized) !== Object.prototype || !Object.hasOwn(sanitized, "message")) {
    return sanitized;
  }
  return { ...(sanitized as Record<string, unknown>), message: COMMIT_MESSAGE_PLACEHOLDER };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function existsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isRequestPublicationTemp(entry: { name: string; isFile(): boolean }): boolean {
  return entry.isFile() && /^\.request\.json\.[1-9][0-9]*\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/.test(entry.name);
}

export class OperationJournal {
  private readonly now: () => string;
  private readonly pid: number;
  private readonly onOperationsDirectorySynced: (directory: string) => void | Promise<void>;
  private readonly publishResult: NonNullable<OperationJournalOptions["publishResult"]>;
  private readonly syncOperationDirectory: NonNullable<OperationJournalOptions["syncOperationDirectory"]>;
  private readonly onResultPublicationWarning: NonNullable<OperationJournalOptions["onResultPublicationWarning"]>;

  constructor(private readonly paths: StatePaths, options: OperationJournalOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.pid = options.pid ?? process.pid;
    this.onOperationsDirectorySynced = options.onOperationsDirectorySynced ?? (() => undefined);
    this.publishResult = options.publishResult ?? (async ({ path, record }) => atomicCreateJson(path, record));
    this.syncOperationDirectory = options.syncOperationDirectory ?? syncDirectory;
    this.onResultPublicationWarning = options.onResultPublicationWarning ?? (() => undefined);
  }

  async begin(operation: BeginOperation): Promise<BeginResult> {
    const requestId = validateSafeId(operation.requestId, "Request ID");
    validateRepositoryId(operation.repositoryId);
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(operation.operation)) throw new TypeError("operation is invalid");
    const canonicalInput = canonicalStringify(operation.input);
    const requestHash = createHash("sha256").update(canonicalInput).digest("hex");
    const ensured = await this.ensureOperationDirectory(requestId);
    const directory = ensured.directory;
    const requestPath = join(directory, "request.json");
    let storedRequest = await this.loadRequest(requestId);
    if (storedRequest === null) {
      if (!ensured.created) {
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.some((entry) => entry.name === "request.json")) {
          storedRequest = await this.loadRequest(requestId);
          if (storedRequest === null) throw new Error(`Corrupt orphan operation directory: ${requestId}`);
        } else if (!entries.every(isRequestPublicationTemp)) {
          throw new Error(`Corrupt orphan operation directory: ${requestId}`);
        }
      }
      if (storedRequest === null) {
        await syncDirectory(this.paths.operations);
        await this.onOperationsDirectorySynced(this.paths.operations);
        const candidate = validateOperationRequestRecord({
          requestId, requestHash, operation: operation.operation, repositoryId: operation.repositoryId,
          input: sanitizeOperationInput(operation.operation, operation.input), createdAt: this.now(),
        }, requestId);
        try {
          await atomicCreateJson(requestPath, candidate);
          storedRequest = candidate;
        } catch (error) {
          if (!existsError(error)) throw error;
          storedRequest = await this.loadRequest(requestId);
          if (storedRequest === null) throw new Error(`Operation request disappeared: ${requestId}`);
        }
      }
    }
    if (storedRequest.requestHash !== requestHash || storedRequest.operation !== operation.operation || storedRequest.repositoryId !== operation.repositoryId) {
      throw new BridgeRejection({ code: "REQUEST_ID_REUSED", message: `Request ID already belongs to a different request: ${requestId}` });
    }

    const startedPath = join(directory, "started.json");
    const existingStarted = await readJson(startedPath);
    if (existingStarted !== null) validateOperationStartedRecord(existingStarted, requestId);
    const existingResult = await this.loadEffectiveResult(storedRequest);
    if (existingResult !== null) {
      if (existingStarted === null) throw new Error(`Operation started record is missing: ${requestId}`);
      return { kind: "replay", result: existingResult };
    }
    if (existingStarted !== null) {
      return { kind: "indeterminate", result: await this.completeIndeterminate(requestId) };
    }
    const started = validateOperationStartedRecord({ requestId, startedAt: this.now(), pid: this.pid }, requestId);
    try {
      await atomicCreateJson(startedPath, started);
      return { kind: "execute" };
    } catch (error) {
      if (!existsError(error)) throw error;
      const raced = await readJson(startedPath);
      validateOperationStartedRecord(raced, requestId);
      return { kind: "indeterminate", result: await this.completeIndeterminate(requestId) };
    }
  }

  async complete(requestIdValue: string, result: BridgeResult<unknown>): Promise<OperationResultRecord> {
    const requestId = validateSafeId(requestIdValue, "Request ID");
    const request = await this.loadRequest(requestId);
    if (request === null) throw new Error(`Operation request does not exist: ${requestId}`);
    const started = await readJson(join(this.operationDirectory(requestId), "started.json"));
    if (started === null) throw new Error(`Operation has not started: ${requestId}`);
    validateOperationStartedRecord(started, requestId);
    if (result.request_id !== requestId) throw new TypeError("Terminal result request ID must exactly match the operation request");
    if (result.repository_id !== request.repositoryId) throw new TypeError("Terminal result repository ID must exactly match the operation request");
    if (result.operation !== request.operation) throw new TypeError("Terminal result operation must exactly match the operation request");
    const record = validateOperationResultRecord({
      requestId, completedAt: this.now(), result: sanitizeAndValidateBridgeResult(result, requestId),
    }, requestId);
    try {
      const outcome = await this.publishResult({ kind: "terminal", path: join(this.operationDirectory(requestId), "result.json"), record });
      const persisted = await this.loadResult(request);
      if (persisted === null || canonicalStringify(persisted) !== canonicalStringify(record)) {
        throw new Error(`Terminal result publication could not be verified: ${requestId}`);
      }
      await this.reportPublicationCleanup(requestId, outcome);
      return persisted;
    } catch (error) {
      if (existsError(error)) throw new Error(`Operation result already exists: ${requestId}`);
      if (error instanceof AtomicJsonDurabilityError) return this.publishDurabilityFallback(request);
      throw error;
    }
  }

  /** Publishes a generic terminal result derived only from the durable request identity. */
  async completeIndeterminate(requestIdValue: string): Promise<OperationResultRecord> {
    const requestId = validateSafeId(requestIdValue, "Request ID");
    const request = await this.loadRequest(requestId);
    if (request === null) throw new Error(`Operation request does not exist: ${requestId}`);
    const started = await readJson(join(this.operationDirectory(requestId), "started.json"));
    if (started === null) throw new Error(`Operation has not started: ${requestId}`);
    validateOperationStartedRecord(started, requestId);
    const durabilityFallback = await this.loadDurabilityFallback(request);
    if (durabilityFallback !== null) return durabilityFallback;
    return this.publishIndeterminate(request);
  }

  async get(requestIdValue: string): Promise<OperationResultRecord | null> {
    const requestId = validateSafeId(requestIdValue, "Request ID");
    const request = await this.loadRequest(requestId);
    if (request === null) return null;
    const started = await readJson(join(this.operationDirectory(requestId), "started.json"));
    if (started !== null) validateOperationStartedRecord(started, requestId);
    const result = await this.loadEffectiveResult(request);
    if (result !== null && started === null) throw new Error(`Operation started record is missing: ${requestId}`);
    return result;
  }

  /** Enumerates started-only records without publishing or otherwise changing operation state. */
  async findRecoveryCandidates(): Promise<readonly RecoveryCandidate[]> {
    const candidates: RecoveryCandidate[] = [];
    const entries = await readdir(this.paths.operations, { withFileTypes: true });
    for (const entry of entries) {
      const requestId = entry.name;
      if (!entry.isDirectory()) {
        candidates.push({ kind: "corrupt", requestId, error: "Operation entry is not a real directory" });
        continue;
      }
      try {
        validateSafeId(requestId, "Request ID");
        const request = await this.loadRequest(requestId);
        if (request === null) throw new Error("Operation request record is missing");
        const startedValue = await readJson(join(this.operationDirectory(requestId), "started.json"));
        const result = await this.loadEffectiveResult(request);
        if (startedValue === null) {
          if (result !== null) throw new Error("Operation started record is missing");
          continue;
        }
        validateOperationStartedRecord(startedValue, requestId);
        if (result !== null) continue;
        candidates.push({ kind: "candidate", requestId, repositoryId: request.repositoryId });
      } catch (error) {
        candidates.push({ kind: "corrupt", requestId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return candidates;
  }

  /** Re-reads and finalizes one candidate. The caller must hold its canonical repository lock. */
  async recoverStarted(requestIdValue: string): Promise<RecoveryResult> {
    const requestId = validateSafeId(requestIdValue, "Request ID");
    const request = await this.loadRequest(requestId);
    if (request === null) throw new Error(`Operation request does not exist: ${requestId}`);
    const startedValue = await readJson(join(this.operationDirectory(requestId), "started.json"));
    if (startedValue === null) throw new Error(`Operation has not started: ${requestId}`);
    validateOperationStartedRecord(startedValue, requestId);
    const result = await this.loadEffectiveResult(request);
    if (result !== null) return { kind: "terminal", requestId, result };
    return { kind: "recovered", requestId, result: await this.completeIndeterminate(requestId) };
  }

  private operationDirectory(requestId: string): string { return join(this.paths.operations, requestId); }

  private async ensureOperationDirectory(requestId: string): Promise<{ directory: string; created: boolean }> {
    const directory = this.operationDirectory(requestId);
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if (!existsError(error)) throw error; }
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`Operation path is not a real directory: ${requestId}`);
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error(`Operation directory is not owned by this user: ${requestId}`);
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const details = await handle.stat();
      if (!details.isDirectory() || details.dev !== before.dev || details.ino !== before.ino) throw new Error(`Operation directory changed while opening: ${requestId}`);
      if (typeof process.getuid === "function" && details.uid !== process.getuid()) throw new Error(`Operation directory is not owned by this user: ${requestId}`);
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    return { directory, created };
  }

  private async loadRequest(requestId: string): Promise<OperationRequestRecord | null> {
    const value = await readJson(join(this.operationDirectory(requestId), "request.json"));
    return value === null ? null : validateOperationRequestRecord(value, requestId);
  }

  private async loadResult(request: OperationRequestRecord): Promise<OperationResultRecord | null> {
    const path = join(this.operationDirectory(request.requestId), "result.json");
    const value = await readJson(path);
    if (value === null) return null;
    let record: OperationResultRecord;
    try {
      record = validateOperationResultRecord(value, request.requestId);
    } catch (error) {
      const migrated = migrateLegacyHookFailureRecord(value, request.requestId);
      if (migrated === null) throw error;
      this.assertResultIdentity(migrated, request);
      await atomicWriteJson(path, migrated);
      const persisted = await readJson(path);
      record = validateOperationResultRecord(persisted, request.requestId);
      if (canonicalStringify(record) !== canonicalStringify(migrated)) {
        throw new Error(`Legacy result migration could not be verified: ${request.requestId}`);
      }
    }
    this.assertResultIdentity(record, request);
    return record;
  }

  private assertResultIdentity(record: OperationResultRecord, request: OperationRequestRecord): void {
    if (record.result.request_id !== request.requestId) throw new TypeError("Persisted result request ID does not match its operation request");
    if (record.result.repository_id !== request.repositoryId) throw new TypeError("Persisted result repository ID does not match its operation request");
    if (record.result.operation !== request.operation) throw new TypeError("Persisted result operation does not match its operation request");
  }

  private async loadDurabilityFallback(request: OperationRequestRecord): Promise<OperationResultRecord | null> {
    const value = await readJson(join(this.operationDirectory(request.requestId), "result-uncertain.json"));
    if (value === null) return null;
    const record = this.validateIndeterminateRecord(value, request, "Durability fallback");
    await this.syncOperationDirectory(this.operationDirectory(request.requestId));
    return record;
  }

  private async loadEffectiveResult(request: OperationRequestRecord): Promise<OperationResultRecord | null> {
    return (await this.loadDurabilityFallback(request)) ?? this.loadResult(request);
  }

  private indeterminateRecord(request: OperationRequestRecord): OperationResultRecord {
    return validateOperationResultRecord({
      requestId: request.requestId,
      completedAt: this.now(),
      result: {
        status: "indeterminate", request_id: request.requestId, repository_id: request.repositoryId,
        operation: request.operation, warnings: [],
        error: { code: "OPERATION_INDETERMINATE", message: INDETERMINATE_MESSAGE },
      },
    }, request.requestId);
  }

  private validateIndeterminateRecord(
    value: unknown,
    request: OperationRequestRecord,
    label: string,
  ): OperationResultRecord {
    const record = validateOperationResultRecord(value, request.requestId);
    if (record.result.request_id !== request.requestId || record.result.repository_id !== request.repositoryId
      || record.result.operation !== request.operation || record.result.status !== "indeterminate"
      || record.result.error?.code !== "OPERATION_INDETERMINATE"
      || record.result.error.message !== INDETERMINATE_MESSAGE
      || record.result.error.details !== undefined || record.result.warnings.length !== 0
      || record.result.data !== undefined || record.result.observed_before !== undefined
      || record.result.observed_after !== undefined) {
      throw new Error(`${label} publication could not be verified: ${request.requestId}`);
    }
    return record;
  }

  /**
   * Publishes an independent generic marker after a terminal link whose directory sync failed.
   * A successful sync of this later link also makes the preceding terminal link durable; readers
   * therefore prioritize the marker and never expose the more optimistic result.
   */
  private async publishDurabilityFallback(request: OperationRequestRecord): Promise<OperationResultRecord> {
    const record = this.indeterminateRecord(request);
    let outcome: AtomicCreateJsonOutcome | void = undefined;
    try {
      outcome = await this.publishResult({
        kind: "durability-fallback",
        path: join(this.operationDirectory(request.requestId), "result-uncertain.json"),
        record,
      });
    } catch (error) {
      if (!existsError(error) && !(error instanceof AtomicJsonDurabilityError)) throw error;
    }
    const persisted = await this.loadDurabilityFallback(request);
    if (persisted === null || canonicalStringify(persisted) !== canonicalStringify(record)) {
      throw new Error(`Durability fallback publication could not be verified: ${request.requestId}`);
    }
    await this.reportPublicationCleanup(request.requestId, outcome);
    return persisted;
  }

  private async publishIndeterminate(request: OperationRequestRecord): Promise<OperationResultRecord> {
    const durabilityFallback = await this.loadDurabilityFallback(request);
    if (durabilityFallback !== null) return durabilityFallback;
    const record = this.indeterminateRecord(request);
    let outcome: AtomicCreateJsonOutcome | void = undefined;
    try {
      outcome = await this.publishResult({
        kind: "indeterminate-fallback",
        path: join(this.operationDirectory(request.requestId), "result.json"),
        record,
      });
    } catch (error) {
      if (error instanceof AtomicJsonDurabilityError) return this.publishDurabilityFallback(request);
      if (!existsError(error)) throw error;
    }
    const persistedValue = await readJson(join(this.operationDirectory(request.requestId), "result.json"));
    if (persistedValue === null) throw new Error(`Indeterminate result publication could not be verified: ${request.requestId}`);
    const persisted = this.validateIndeterminateRecord(persistedValue, request, "Indeterminate result");
    await this.reportPublicationCleanup(request.requestId, outcome);
    return persisted;
  }

  private async reportPublicationCleanup(requestId: string, outcome: AtomicCreateJsonOutcome | void): Promise<void> {
    if (outcome?.cleanup !== "incomplete") return;
    try { await this.onResultPublicationWarning(requestId); }
    catch { /* A generic diagnostic sink cannot alter an immutable terminal result. */ }
  }
}
