import { createHash } from "node:crypto";
import { remainingDeadlineTimeoutMs, throwIfDeadlineExceeded, withReconciliationDeadline } from "../deadline.js";
import type { BridgeResult, CommitData } from "../domain/result.js";
import {
  BridgeRejection,
  commitDataSchema,
  HOOK_FAILED_MESSAGE,
} from "../domain/result.js";
import { absoluteRepositoryPath, gitOutputPath } from "../domain/inputs.js";
import { ProvenMutationOutcome } from "../app/mutation-coordinator.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import type { StageRecord } from "../state/records.js";
import { stageRecordHash, type SessionStore } from "../state/session-store.js";
import {
  assertMutationReady,
  inspectRepository,
  readIndexStageMap,
  type IndexStageRecord,
  type RepositorySnapshot,
} from "./repository.js";
import type { GitCommandResult, GitRunner } from "./runner.js";
import { createHookWrappers } from "./hook-wrapper.js";
import {
  COMPLETE_RECORD_MAX_BYTES,
  DelimitedRecordParser,
  RETURNED_PATH_SET_MAX_BYTES,
  RETURNED_PATH_SET_MAX_COUNT,
  STREAM_STDERR_MAX_BYTES,
  utf8Bytes,
} from "./streaming.js";

export interface CommitRequest {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly stageId: string;
  readonly message: string;
}

/** Opaque, one-shot authority returned only after all rejection-capable commit checks succeed. */
export interface PreparedCommit {
  readonly stageId: string;
}

export interface CommitCleanupBinding {
  readonly requestId: string;
  readonly repositoryId: string;
  readonly operation: "git_commit";
  readonly stageId: string;
  readonly expectedBranch: string;
  readonly expectedHead: string;
}

export interface CommitPreflightObservation extends Readonly<Record<string, unknown>> {
  readonly stage_id: string;
  readonly branch: string;
  readonly base_head: string;
  readonly index_tree: string;
  readonly stage_record_hash: string;
}

/** Fully proven in memory; Task 14 postflight must project this value without another caller-cancelable Git read. */
export interface CommitExecutionOutcome {
  readonly data: CommitData;
  readonly warnings: readonly string[];
}

interface PreparedState {
  readonly snapshot: RepositorySnapshot;
  readonly record: StageRecord;
  readonly message: string;
  readonly hooksPath: string;
  readonly preIndexTreeFingerprint: string;
  readonly preOwnedEntries: ReadonlyMap<string, CommitTreeEntry>;
}

interface CommitTreeEntry {
  readonly mode: IndexStageRecord["mode"];
  readonly objectId: string;
  readonly path: string;
}

const MUTATION_OUTPUT_LIMIT = 64_000;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const STAGED_PATH_ARGS = ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"];
const preparedStates = new WeakMap<PreparedCommit, PreparedState>();

function reject(
  code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_MISMATCH" | "SESSION_NOT_FOUND" | "SESSION_MISMATCH",
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new BridgeRejection({ code, message, ...(details === undefined ? {} : { details }) });
}

function assertIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed before commit");
  }
}

function completeRead(result: GitCommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated && result.stderr === "" && !result.stdout.includes("�");
}

interface PathSetProof {
  readonly count: number;
  readonly fingerprint: string;
}

function expectedPathSetProof(paths: readonly string[]): PathSetProof {
  const sorted = [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (new Set(sorted).size !== sorted.length) throw new Error("Persisted staged path set contains duplicates");
  const hash = createHash("sha256").update("git-mcp-server:path-set:v1\0");
  for (const path of sorted) hash.update(path).update("\0");
  return { count: sorted.length, fingerprint: hash.digest("hex") };
}

async function readStagedPathProof(runner: GitRunner, root: string, signal?: AbortSignal): Promise<PathSetProof> {
  const hash = createHash("sha256").update("git-mcp-server:path-set:v1\0");
  let count = 0;
  let previous: Buffer | undefined;
  const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git staged path set", (path) => {
    throwIfDeadlineExceeded(signal);
    if (!gitOutputPath.safeParse(path).success || path.includes("�")) throw new Error("Git returned a malformed staged path set");
    const bytes = Buffer.from(path);
    if (previous !== undefined && Buffer.compare(previous, bytes) >= 0) throw new Error("Git returned a malformed staged path set");
    previous = bytes;
    count += 1;
    hash.update(path).update("\0");
  });
  let result: GitCommandResult;
  try {
    result = await runner.runStreaming({
      cwd: root, args: STAGED_PATH_ARGS, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
      maxStderrBytes: STREAM_STDERR_MAX_BYTES,
    }, (chunk) => parser.write(chunk), signal);
  } catch { throw new Error("Unable to read the complete staged path set"); }
  if (!completeRead(result)) throw new Error("Unable to read the complete staged path set");
  try { parser.finish(); } catch { throw new Error("Unable to read the complete staged path set"); }
  return { count, fingerprint: hash.digest("hex") };
}

function assertStage(record: StageRecord, snapshot: RepositorySnapshot, input: CommitRequest): void {
  if (record.repositoryId !== snapshot.repositoryId || record.stageId !== input.stageId
    || record.branch !== input.expectedBranch || record.baseHead !== input.expectedHead) {
    reject("SESSION_MISMATCH", "Stage session does not match the repository, branch, or base HEAD");
  }
  if (record.ownedPaths.length === 0) reject("SESSION_MISMATCH", "Commit requires a non-empty stage session");
  if (record.currentIndexTree !== snapshot.indexTree) {
    reject("INDEX_MISMATCH", "Repository index does not match the stage session", {
      expectedIndexTree: record.currentIndexTree, observedIndexTree: snapshot.indexTree,
    });
  }
}

function proven<T>(result: BridgeResult<T>): never {
  throw new ProvenMutationOutcome(result);
}

function indeterminate(message = "The commit started but its final repository state could not be confirmed"): never {
  proven<CommitData>({
    status: "indeterminate", operation: "git_commit", warnings: [],
    error: { code: "OPERATION_INDETERMINATE", message },
  });
}

async function inspectAfter(runner: GitRunner, state: PreparedState, signal?: AbortSignal): Promise<RepositorySnapshot> {
  try { return await inspectRepository(runner, state.snapshot.root, signal); }
  catch { indeterminate(); }
}

function finalIdentityMatches(state: PreparedState, after: RepositorySnapshot): boolean {
  return after.repositoryId === state.snapshot.repositoryId && after.root === state.snapshot.root
    && after.gitDir === state.snapshot.gitDir && after.commonGitDir === state.snapshot.commonGitDir
    && after.branch === state.record.branch && after.operationState === "none";
}

function ordinaryGitFailure(result: GitCommandResult): boolean {
  return result.exitCode !== 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated;
}

async function readLine(runner: GitRunner, root: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const result = await runner.run({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: MUTATION_OUTPUT_LIMIT,
  }, signal);
  if (!completeRead(result)) throw new Error("Unable to prove commit metadata");
  const line = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!OBJECT_ID.test(line) || line.includes("\n") || line.includes("\r")) throw new Error("Git returned malformed commit metadata");
  return line;
}

async function readHooksPath(runner: GitRunner, root: string, signal?: AbortSignal): Promise<string> {
  const result = await runner.run({
    cwd: root,
    args: ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxOutputBytes: MUTATION_OUTPUT_LIMIT,
  }, signal);
  if (!completeRead(result) || !result.stdout.endsWith("\n")) throw new Error("Unable to resolve native hooks");
  const path = result.stdout.slice(0, -1);
  if (path.includes("\n") || path.includes("\r") || !absoluteRepositoryPath.safeParse(path).success) {
    throw new Error("Git returned a malformed hooks path");
  }
  return path;
}

interface CommitTreeProof {
  readonly fingerprint: string;
  readonly capturedEntries: ReadonlyMap<string, CommitTreeEntry>;
}

async function readCommitTreeProof(
  runner: GitRunner,
  root: string,
  commit: string,
  capturePaths: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<CommitTreeProof> {
  const hash = createHash("sha256").update("git-mcp-server:stage-zero-tree:v1\0");
  const captured = new Map<string, CommitTreeEntry>();
  let previous: Buffer | undefined;
  const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git commit tree", (record) => {
    throwIfDeadlineExceeded(signal);
    const tab = record.indexOf("\t");
    const header = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(record.slice(0, tab));
    const path = record.slice(tab + 1);
    if (tab <= 0 || header === null || !gitOutputPath.safeParse(path).success || path.includes("�")) {
      throw new Error("Git returned a malformed commit tree");
    }
    const [, mode, type, objectId] = header as unknown as [string, CommitTreeEntry["mode"], "blob" | "commit", string];
    if ((mode === "160000") !== (type === "commit")) throw new Error("Git returned a malformed commit tree");
    const bytes = Buffer.from(path);
    if (previous !== undefined && Buffer.compare(previous, bytes) >= 0) throw new Error("Git returned a malformed commit tree");
    previous = bytes;
    hash.update(mode).update("\0").update(objectId).update("\0").update(path).update("\0");
    if (capturePaths.has(path)) captured.set(path, { mode, objectId, path });
  });
  const args = ["ls-tree", "-r", "-z", "--full-tree", commit];
  let result: GitCommandResult;
  try {
    result = await runner.runStreaming({
      cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
      maxStderrBytes: STREAM_STDERR_MAX_BYTES,
    }, (chunk) => parser.write(chunk), signal);
  } catch { throw new Error("Unable to read the complete commit tree"); }
  if (!completeRead(result)) throw new Error("Unable to read the complete commit tree");
  try { parser.finish(); } catch { throw new Error("Unable to read the complete commit tree"); }
  return { fingerprint: hash.digest("hex"), capturedEntries: captured };
}

async function hookChangedPaths(
  runner: GitRunner,
  root: string,
  baseHead: string,
  preIndexTreeFingerprint: string,
  preOwnedEntries: ReadonlyMap<string, CommitTreeEntry>,
  ownedPaths: readonly string[],
  commit: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const owned = new Set(ownedPaths);
  const tree = await readCommitTreeProof(runner, root, commit, owned, signal);
  if (tree.fingerprint === preIndexTreeFingerprint) return [];
  const changed = new Set<string>();
  let changedBytes = 0;
  const addChanged = (path: string): void => {
    if (changed.has(path)) return;
    const nextBytes = changedBytes + utf8Bytes(path);
    if (changed.size + 1 > RETURNED_PATH_SET_MAX_COUNT || nextBytes > RETURNED_PATH_SET_MAX_BYTES) {
      throw new Error("Hook-changed path result exceeds its explicit output boundary");
    }
    changed.add(path);
    changedBytes = nextBytes;
  };
  for (const path of ownedPaths) {
    throwIfDeadlineExceeded(signal);
    const before = preOwnedEntries.get(path);
    const after = tree.capturedEntries.get(path);
    if (before?.mode !== after?.mode || before?.objectId !== after?.objectId) addChanged(path);
  }

  let previous: Buffer | undefined;
  const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git committed path delta", (path) => {
    throwIfDeadlineExceeded(signal);
    if (!gitOutputPath.safeParse(path).success || path.includes("�")) throw new Error("Git returned malformed committed paths");
    const bytes = Buffer.from(path);
    if (previous !== undefined && Buffer.compare(previous, bytes) >= 0) throw new Error("Git returned malformed committed paths");
    previous = bytes;
    if (!owned.has(path)) addChanged(path);
  });
  const args = ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", baseHead, commit, "--"];
  let result: GitCommandResult;
  try {
    result = await runner.runStreaming({
      cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
      maxStderrBytes: STREAM_STDERR_MAX_BYTES,
    }, (chunk) => parser.write(chunk), signal);
  } catch { throw new Error("Unable to read complete committed paths"); }
  if (!completeRead(result)) throw new Error("Unable to read complete committed paths");
  try { parser.finish(); } catch { throw new Error("Unable to read complete committed paths"); }
  return [...changed].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

/** Performs every rejection-capable repository/session check before coordinator mutationStarted. */
export async function prepareCommit(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: CommitRequest,
  signal?: AbortSignal,
): Promise<PreparedCommit> {
  if (input.message.length === 0 || input.message.length > 100_000) reject("INVALID_INPUT", "Commit message length is invalid");
  const record = await sessions.getStage(input.stageId);
  if (record === null) reject("SESSION_NOT_FOUND", "Stage session was not found", { stageId: input.stageId });

  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  assertStage(record, before, input);
  await sessions.assertActiveStage(record);
  const expectedPaths = expectedPathSetProof(record.ownedPaths);
  const stagedPaths = await readStagedPathProof(runner, before.root, signal);
  if (stagedPaths.count !== expectedPaths.count || stagedPaths.fingerprint !== expectedPaths.fingerprint) {
    reject("SESSION_MISMATCH", "Persisted stage ownership does not match the complete staged path set");
  }

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  assertStage(record, finalBefore, input);
  const finalPaths = await readStagedPathProof(runner, finalBefore.root, signal);
  if (finalPaths.count !== expectedPaths.count || finalPaths.fingerprint !== expectedPaths.fingerprint) {
    reject("SESSION_MISMATCH", "Stage ownership changed while preparing the commit");
  }
  const preIndex = await readIndexStageMap(runner, finalBefore.root, signal, new Set(record.ownedPaths));
  if (preIndex.fingerprint !== finalBefore.indexTree || preIndex.hasUnmergedEntries) {
    reject("INDEX_MISMATCH", "Repository index changed while preparing the commit");
  }
  const preOwnedEntries = new Map<string, CommitTreeEntry>();
  for (const [path, entries] of preIndex.capturedEntries) {
    const entry = entries[0];
    if (entries.length !== 1 || entry === undefined || entry.stage !== "0") {
      reject("INDEX_MISMATCH", "Repository index changed while preparing the commit");
    }
    preOwnedEntries.set(path, { mode: entry.mode, objectId: entry.objectId, path });
  }
  const finalRecord = await sessions.getStage(record.stageId);
  if (finalRecord === null || stageRecordHash(finalRecord) !== stageRecordHash(record)) {
    reject("SESSION_MISMATCH", "Stage record changed while preparing the commit");
  }
  await sessions.assertActiveStage(finalRecord);
  const hooksPath = await readHooksPath(runner, finalBefore.root, signal);

  const prepared = Object.freeze({ stageId: record.stageId });
  preparedStates.set(prepared, {
    snapshot: Object.freeze({ ...finalBefore }), record: Object.freeze({ ...record, ownedPaths: Object.freeze([...record.ownedPaths]) }),
    message: input.message,
    hooksPath,
    preIndexTreeFingerprint: preIndex.stageZeroTreeFingerprint,
    preOwnedEntries,
  });
  return prepared;
}

/** Runs the one allowed Git commit and proves the resulting HEAD, parent, tree, and index state. */
export async function executePreparedCommit(
  runner: GitRunner,
  prepared: PreparedCommit,
  signal?: AbortSignal,
): Promise<CommitExecutionOutcome> {
  const state = preparedStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared commit authority is invalid or already consumed");
  preparedStates.delete(prepared);

  let command: GitCommandResult | undefined;
  let wrappers: Awaited<ReturnType<typeof createHookWrappers>> | undefined;
  try {
    wrappers = await createHookWrappers(state.hooksPath);
    command = await runner.run({
      cwd: state.snapshot.root,
      args: ["commit", "--no-gpg-sign", "--file=-"],
      stdin: state.message,
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.commit),
      maxOutputBytes: MUTATION_OUTPUT_LIMIT,
      hookExecution: {
        wrappersDirectory: wrappers.directory,
        failureConsumer: wrappers.failureConsumer,
      },
    }, signal);
  } catch {
    command = undefined;
  } finally {
    try { await wrappers?.cleanup(); }
    catch { /* A private wrapper cleanup failure cannot alter the proven Git outcome. */ }
  }

  return withReconciliationDeadline(async () => {
    // Classification must finish under its own budget after Git termination.
    const after = await inspectAfter(runner, state);
    if (!finalIdentityMatches(state, after)) indeterminate();

    if (after.head === state.record.baseHead) {
      if (command?.timedOut) {
        proven<CommitData>({
          status: "failed", operation: "git_commit", warnings: [],
          error: { code: "GIT_TIMEOUT", message: "The commit timed out and no commit was created" },
        });
      }
      if (command !== undefined && ordinaryGitFailure(command)) {
        const hook = wrappers?.rejectedHook();
        if (hook !== undefined) {
          proven<CommitData>({
            status: "failed", operation: "git_commit", warnings: [],
            error: { code: "HOOK_FAILED", message: HOOK_FAILED_MESSAGE, details: { hook } },
          });
        }
        proven<CommitData>({
          status: "failed", operation: "git_commit", warnings: [],
          error: { code: "GIT_FAILED", message: "Git did not create a commit" },
        });
      }
      if (command?.stdoutTruncated || command?.stderrTruncated) {
        proven<CommitData>({
          status: "failed", operation: "git_commit", warnings: [],
          error: { code: "OUTPUT_TRUNCATED", message: "Git output was truncated, but no commit was created" },
        });
      }
      proven<CommitData>({
        status: "failed", operation: "git_commit", warnings: [],
        error: { code: "GIT_FAILED", message: "Git did not create a commit" },
      });
    }

    let parent: string;
    let changedPaths: readonly string[];
    try {
      parent = await readLine(runner, after.root, ["rev-parse", "--verify", `${after.head}^`]);
      if (parent !== state.record.baseHead) indeterminate();
      changedPaths = await hookChangedPaths(
        runner,
        after.root,
        state.record.baseHead,
        state.preIndexTreeFingerprint,
        state.preOwnedEntries,
        state.record.ownedPaths,
        after.head,
      );
    } catch (error) {
      if (error instanceof ProvenMutationOutcome) throw error;
      indeterminate();
    }

    const data: CommitData = {
      commit: after.head,
      tree: after.headTree,
      hook_changed_paths: [...changedPaths],
      signing: "disabled_by_policy",
    };
    const warnings: string[] = [];
    if (command === undefined || command.exitCode !== 0 || command.signal !== null || command.timedOut || command.aborted
      || command.stdoutTruncated || command.stderrTruncated) {
      warnings.push("Git command completion diagnostics were incomplete after the commit was created");
    } else if (command.stderr !== "") {
      warnings.push("Git emitted diagnostics after the commit was created");
    }
    if (!after.indexMatchesHead) {
      warnings.push("The repository index differs from the created commit after native hooks ran");
    }
    return { data, warnings: Object.freeze(warnings) };
  });
}

/** Durable observation Task 14 must persist from preflight before consuming the authority. */
export function preparedCommitObservation(prepared: PreparedCommit): CommitPreflightObservation {
  const state = preparedStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared commit authority is invalid or already consumed");
  return Object.freeze({
    stage_id: state.record.stageId,
    branch: state.record.branch,
    base_head: state.record.baseHead,
    index_tree: state.record.currentIndexTree,
    stage_record_hash: stageRecordHash(state.record),
  });
}

/** Convenience wrapper for direct callers; coordinator adapters must use prepare/execute separately. */
export async function commitStage(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: CommitRequest,
  signal?: AbortSignal,
): Promise<CommitExecutionOutcome> {
  const prepared = await prepareCommit(runner, sessions, snapshot, input, signal);
  return executePreparedCommit(runner, prepared, signal);
}

/** Restart-safe afterPersist adapter; its inputs come from the durable request and persisted stage record. */
export function createCommitAfterPersistCleanup(
  sessions: SessionStore,
  binding: CommitCleanupBinding,
): (result: BridgeResult<CommitData>) => Promise<void> {
  return async (result): Promise<void> => {
    if (result.status !== "succeeded") return;
    if (result.request_id !== binding.requestId || result.repository_id !== binding.repositoryId
      || result.operation !== binding.operation) {
      throw new Error("Durable commit success does not match the cleanup binding");
    }
    const parsed = commitDataSchema.safeParse(result.data);
    if (!parsed.success || parsed.data.commit === binding.expectedHead) {
      throw new Error("Durable commit success does not contain the expected commit context");
    }
    const observed = result.observed_before;
    if (observed === undefined || observed.stage_id !== binding.stageId || observed.branch !== binding.expectedBranch
      || observed.base_head !== binding.expectedHead || typeof observed.index_tree !== "string"
      || typeof observed.stage_record_hash !== "string" || !/^[0-9a-f]{64}$/.test(observed.stage_record_hash)) {
      throw new Error("Durable commit success does not match the stage cleanup context");
    }
    await sessions.deleteStageSessionByIdentity({
      repositoryId: binding.repositoryId,
      stageId: binding.stageId,
      recordHash: observed.stage_record_hash,
    });
  };
}
