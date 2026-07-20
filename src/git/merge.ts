import { createHash, randomUUID } from "node:crypto";
import { ProvenMutationOutcome } from "../app/mutation-coordinator.js";
import { remainingDeadlineTimeoutMs, throwIfDeadlineExceeded, withReconciliationDeadline } from "../deadline.js";
import { gitOutputPath, relativeGitPath } from "../domain/inputs.js";
import {
  BridgeRejection, mergeAbortDataSchema, mergeContinueDataSchema,
  type AddData, type BridgeResult, type MergeAbortData, type MergeContinueData, type MergeData, type StatusData,
} from "../domain/result.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import { RETURNED_PATH_SET_MAX_BYTES, RETURNED_PATH_SET_MAX_COUNT } from "../limits.js";
import { validateOriginRemoteRef, type FetchRecord, type MergeRecord } from "../state/records.js";
import { mergeRecordHash, type SessionStore } from "../state/session-store.js";
import { validatePaths } from "./path-policy.js";
import { literalPathspecTransport } from "./pathspec.js";
import { readStatus } from "./read.js";
import { listOriginRefs, readOriginIdentity, type RemoteIdentity } from "./remote.js";
import {
  assertMutationReady,
  inspectRepository,
  readIndexStageMap as readRepositoryIndexStageMap,
  type RepositorySnapshot,
} from "./repository.js";
import type { GitCommandResult, GitRunner } from "./runner.js";
import { COMPLETE_RECORD_MAX_BYTES, DelimitedRecordParser, STREAM_STDERR_MAX_BYTES, utf8Bytes } from "./streaming.js";

export interface MergeRequest {
  readonly expectedBranch: string; readonly expectedHead: string; readonly fetchId: string;
  readonly remoteRef: string; readonly expectedRemoteObject: string;
}
export interface MergeSessionRequest {
  readonly expectedBranch: string; readonly expectedHead: string; readonly mergeSessionId: string;
}
export interface ConflictAddRequest extends MergeSessionRequest { readonly paths: readonly string[] }
export interface MergePreparationOptions { readonly generateId?: () => string; readonly now?: () => string }
export interface PreparedMerge { readonly mergeSessionId: string }
export interface PreparedConflictAdd { readonly mergeSessionId: string }
export interface PreparedMergeContinue { readonly mergeSessionId: string }
export interface PreparedMergeAbort { readonly mergeSessionId: string }
export interface MergeExecutionOutcome { readonly data: MergeData; readonly warnings: readonly string[] }
export interface MergeContinueExecutionOutcome { readonly data: MergeContinueData; readonly warnings: readonly string[] }
export interface MergeAbortExecutionOutcome { readonly data: MergeAbortData; readonly warnings: readonly string[] }

export interface MergePreflightObservation extends Readonly<Record<string, unknown>> {
  readonly merge_session_id: string; readonly branch: string; readonly original_head: string;
  readonly target_object: string; readonly fetch_id: string; readonly index_tree: string;
}
export interface ActiveMergePreflightObservation extends MergePreflightObservation { readonly merge_record_hash: string }
export interface ConflictAddPreflightObservation extends ActiveMergePreflightObservation { readonly paths: readonly string[] }

export interface MergeCleanupBinding {
  readonly requestId: string; readonly repositoryId: string;
  readonly operation: "git_merge_continue" | "git_merge_abort";
  readonly mergeSessionId: string; readonly expectedBranch: string; readonly expectedHead: string;
}

interface StartState { snapshot: RepositorySnapshot; status: StatusData; fetch: FetchRecord; target: string; mergeSessionId: string; now: () => string }
interface SessionState { snapshot: RepositorySnapshot; status: StatusData; record: MergeRecord; unresolved: readonly string[] }
interface IndexStageEntry { readonly mode: string; readonly object: string; readonly stage: string }
interface ConflictIndexProof {
  readonly fingerprint: string;
  readonly uncapturedFingerprint: string;
  readonly entries: ReadonlyMap<string, readonly IndexStageEntry[]>;
}
interface AddState extends SessionState { paths: readonly string[]; indexProof: ConflictIndexProof }
const startStates = new WeakMap<PreparedMerge, StartState>();
const addStates = new WeakMap<PreparedConflictAdd, AddState>();
const continueStates = new WeakMap<PreparedMergeContinue, SessionState>();
const abortStates = new WeakMap<PreparedMergeAbort, SessionState>();
const OUTPUT_LIMIT = 64_000;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** Domain-separated exact merge index-state ID; never a Git object name. */
export function mergeIndexStateId(snapshotIndexTree: string): string {
  if (!OBJECT_ID.test(snapshotIndexTree)) throw new TypeError("Repository index state is invalid");
  return createHash("sha256").update("merge-index-state\0").update(snapshotIndexTree).digest("hex");
}

function reject(
  code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "BRANCH_MISMATCH" | "HEAD_MISMATCH" | "INDEX_MISMATCH" | "INDEX_NOT_EMPTY" | "SESSION_NOT_FOUND" | "SESSION_MISMATCH" | "REMOTE_HEAD_MISMATCH" | "REMOTE_URL_REJECTED",
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never { throw new BridgeRejection({ code, message, ...(details === undefined ? {} : { details }) }); }

function proven<T>(result: BridgeResult<T>): never { throw new ProvenMutationOutcome(result); }
function indeterminate<T>(operation: string, message: string): never {
  proven<T>({ status: "indeterminate", operation, warnings: [], error: { code: "OPERATION_INDETERMINATE", message } });
}
function sameIdentity(a: RepositorySnapshot, b: RepositorySnapshot): boolean {
  return a.repositoryId === b.repositoryId && a.root === b.root && a.gitDir === b.gitDir && a.commonGitDir === b.commonGitDir;
}
function assertIdentity(a: RepositorySnapshot, b: RepositorySnapshot): void {
  if (!sameIdentity(a, b)) reject("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed while preparing merge operation");
}
function sameRemote(a: RemoteIdentity, b: RemoteIdentity): boolean {
  return a.scheme === b.scheme && a.host === b.host && a.pathHash === b.pathHash;
}
function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && b.every((path) => a.includes(path));
}
function cleanStatus(entries: readonly { index: string; worktree: string }[]): boolean {
  return entries.length === 0;
}

async function availableMergeId(sessions: SessionStore, generateId: () => string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateId();
    if (await sessions.getMerge(candidate) === null) return candidate;
  }
  reject("SESSION_MISMATCH", "Unable to allocate a unique merge session ID");
}
function commandSucceeded(command: GitCommandResult | undefined): boolean {
  return command !== undefined && command.exitCode === 0 && command.signal === null && !command.timedOut && !command.aborted
    && !command.stdoutTruncated && !command.stderrTruncated;
}
function failedCode(command: GitCommandResult | undefined): "GIT_TIMEOUT" | "OUTPUT_TRUNCATED" | "GIT_FAILED" {
  if (command?.timedOut) return "GIT_TIMEOUT";
  if (command?.stdoutTruncated || command?.stderrTruncated) return "OUTPUT_TRUNCATED";
  return "GIT_FAILED";
}
function failed<T>(operation: string, command: GitCommandResult | undefined, message: string): never {
  proven<T>({ status: "failed", operation, warnings: [], error: { code: failedCode(command), message } });
}
async function commandLine(runner: GitRunner, root: string, args: readonly string[]): Promise<string> {
  const result = await runner.run({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: OUTPUT_LIMIT,
  });
  if (!commandSucceeded(result) || result.stderr !== "" || result.stdout.includes("�")) throw new Error("Unable to prove Git metadata");
  const line = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) throw new Error("Unable to prove Git metadata");
  return line;
}
async function mergeHead(runner: GitRunner, root: string): Promise<string> {
  const value = await commandLine(runner, root, ["rev-parse", "--verify", "MERGE_HEAD"]);
  if (!OBJECT_ID.test(value)) throw new Error("Unable to prove MERGE_HEAD");
  return value;
}
async function parents(runner: GitRunner, root: string, head: string): Promise<readonly string[]> {
  const line = await commandLine(runner, root, ["rev-list", "--parents", "-n", "1", head]);
  const values = line.split(" ");
  if (values[0] !== head || values.length < 2 || values.some((value) => !OBJECT_ID.test(value))) throw new Error("Unable to prove commit parents");
  return values.slice(1);
}

async function isAncestor(runner: GitRunner, root: string, ancestor: string, descendant: string): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", ancestor, descendant];
  const result = await runner.run({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: OUTPUT_LIMIT,
  });
  if (result.signal !== null || result.timedOut || result.aborted || result.stdoutTruncated || result.stderrTruncated
    || result.stdout !== "" || result.stderr !== "" || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new Error("Unable to prove commit ancestry");
  }
  return result.exitCode === 0;
}
async function unresolvedPaths(runner: GitRunner, root: string): Promise<readonly string[]> {
  const args = ["diff", "--name-only", "--diff-filter=U", "-z", "--no-renames", "--"];
  const paths: string[] = [];
  let bytes = 0;
  let previous: Buffer | undefined;
  const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git unmerged paths", (path) => {
    throwIfDeadlineExceeded();
    const pathBytes = Buffer.from(path);
    const nextBytes = bytes + utf8Bytes(path);
    if (!gitOutputPath.safeParse(path).success || path.includes("�")
      || (previous !== undefined && Buffer.compare(previous, pathBytes) >= 0)) {
      throw new Error("Git returned malformed unmerged paths");
    }
    if (paths.length + 1 > RETURNED_PATH_SET_MAX_COUNT || nextBytes > RETURNED_PATH_SET_MAX_BYTES) {
      throw new BridgeRejection({
        code: "UNSUPPORTED_REPOSITORY_STATE",
        message: "Unmerged path result exceeds its explicit returned-set limit",
      });
    }
    previous = pathBytes;
    paths.push(path);
    bytes = nextBytes;
  });
  const result = await runner.runStreaming({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxStderrBytes: STREAM_STDERR_MAX_BYTES,
  }, (chunk) => parser.write(chunk));
  if (!commandSucceeded(result) || result.stderr !== "") throw new Error("Unable to read exact unmerged paths");
  try { parser.finish(); } catch { throw new Error("Unable to read exact unmerged paths"); }
  return paths;
}

async function readConflictIndexProof(
  runner: GitRunner,
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ConflictIndexProof> {
  const proof = await readRepositoryIndexStageMap(runner, root, signal, new Set(paths));
  return {
    fingerprint: proof.fingerprint,
    uncapturedFingerprint: proof.uncapturedFingerprint,
    entries: new Map([...proof.capturedEntries].map(([path, entries]) => [
      path,
      entries.map(({ mode, objectId, stage }) => ({ mode, object: objectId, stage })),
    ])),
  };
}

function exactAddEffect(state: AddState, after: ConflictIndexProof, unresolved: readonly string[]): boolean {
  const expectedUnresolved = state.unresolved.filter((path) => !state.paths.includes(path));
  if (!samePaths(expectedUnresolved, unresolved)) return false;
  if (state.indexProof.uncapturedFingerprint !== after.uncapturedFingerprint) return false;
  for (const path of state.paths) {
    const afterEntries = after.entries.get(path);
    if (afterEntries !== undefined && (afterEntries.length !== 1 || afterEntries[0]?.stage !== "0")) return false;
  }
  return true;
}

async function statusSnapshot(runner: GitRunner, snapshot: RepositorySnapshot): Promise<StatusData | undefined> {
  try { return await readStatus(runner, snapshot); } catch { return undefined; }
}

async function unchangedActiveState(runner: GitRunner, state: SessionState, after: RepositorySnapshot): Promise<boolean> {
  if (!sameIdentity(state.snapshot, after) || after.branch !== state.record.branch || after.head !== state.record.originalHead
    || after.operationState !== "merge" || mergeIndexStateId(after.indexTree) !== state.record.currentIndexTree) return false;
  try {
    const [target, unresolved, status] = await Promise.all([mergeHead(runner, after.root), unresolvedPaths(runner, after.root), readStatus(runner, after)]);
    return target === state.record.targetObject && samePaths(unresolved, state.unresolved)
      && status.worktree_snapshot_id === state.status.worktree_snapshot_id;
  } catch { return false; }
}

async function assertActiveState(
  runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: MergeSessionRequest, signal?: AbortSignal,
): Promise<SessionState> {
  const record = await sessions.getMerge(input.mergeSessionId);
  if (record === null) reject("SESSION_NOT_FOUND", "Merge session was not found", { mergeSessionId: input.mergeSessionId });
  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  if (before.branch !== input.expectedBranch || record.branch !== input.expectedBranch) reject("BRANCH_MISMATCH", "Merge session branch does not match");
  if (input.expectedHead !== record.originalHead || before.head !== record.originalHead) reject("HEAD_MISMATCH", "Merge session original HEAD does not match");
  if (before.operationState !== "merge") reject("SESSION_MISMATCH", "Repository does not contain the bridge merge operation");
  if (before.repositoryId !== record.repositoryId || record.mergeSessionId !== input.mergeSessionId) reject("SESSION_MISMATCH", "Merge session repository binding does not match");
  if (mergeIndexStateId(before.indexTree) !== record.currentIndexTree) reject("INDEX_MISMATCH", "Repository index changed outside the merge session");
  await sessions.assertActiveMerge(record);
  if (await mergeHead(runner, before.root) !== record.targetObject) reject("SESSION_MISMATCH", "MERGE_HEAD does not match the bridge merge target");
  const unresolved = await unresolvedPaths(runner, before.root);
  if (!samePaths(unresolved, record.conflictedPaths)) reject("SESSION_MISMATCH", "Unresolved paths do not match the merge record");
  const finalRecord = await sessions.getMerge(record.mergeSessionId);
  if (finalRecord === null || mergeRecordHash(finalRecord) !== mergeRecordHash(record)) reject("SESSION_MISMATCH", "Merge record changed while preparing operation");
  await sessions.assertActiveMerge(finalRecord);
  const final = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, final);
  if (final.branch !== record.branch || final.head !== record.originalHead || final.operationState !== "merge"
    || mergeIndexStateId(final.indexTree) !== record.currentIndexTree || await mergeHead(runner, final.root) !== record.targetObject) {
    reject("SESSION_MISMATCH", "Merge state changed while preparing operation");
  }
  const finalUnresolved = await unresolvedPaths(runner, final.root);
  if (!samePaths(finalUnresolved, unresolved)) reject("SESSION_MISMATCH", "Unresolved paths changed while preparing operation");
  const finalStatus = await readStatus(runner, final, signal);
  const confirmed = await inspectRepository(runner, final.root, signal);
  if (!sameIdentity(final, confirmed) || confirmed.branch !== final.branch || confirmed.head !== final.head
    || confirmed.operationState !== "merge" || confirmed.indexTree !== final.indexTree
    || await mergeHead(runner, confirmed.root) !== record.targetObject
    || !samePaths(await unresolvedPaths(runner, confirmed.root), finalUnresolved)) {
    reject("SESSION_MISMATCH", "Merge state changed while capturing its worktree snapshot");
  }
  return { snapshot: confirmed, status: finalStatus, record: finalRecord, unresolved: finalUnresolved };
}

export async function prepareMergeFetchedRef(
  runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: MergeRequest,
  signal?: AbortSignal, options: MergePreparationOptions = {},
): Promise<PreparedMerge> {
  try { validateOriginRemoteRef(input.remoteRef); } catch { reject("INVALID_INPUT", "Remote ref is not an allowed origin tracking ref"); }
  const fetch = await sessions.getFetch(input.fetchId);
  if (fetch === null) reject("SESSION_NOT_FOUND", "Fetch record was not found", { fetchId: input.fetchId });
  if (fetch.repositoryId !== snapshot.repositoryId || fetch.branch !== input.expectedBranch || fetch.head !== input.expectedHead) {
    reject("SESSION_MISMATCH", "Fetch record does not match repository, branch, and HEAD");
  }
  if (fetch.refsAfter[input.remoteRef] !== input.expectedRemoteObject) reject("REMOTE_HEAD_MISMATCH", "Requested object was not observed by the fetch");
  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before); assertMutationReady(before, input.expectedBranch, input.expectedHead);
  if (!before.indexMatchesHead) reject("INDEX_NOT_EMPTY", "Merge requires an empty index");
  const status = await readStatus(runner, before, signal);
  if (!cleanStatus(status.entries)) reject("UNSUPPORTED_REPOSITORY_STATE", "Merge requires a completely clean worktree");
  await sessions.assertNoActiveSession(before.repositoryId);
  const refs = await listOriginRefs(runner, before.root, signal);
  if (refs[input.remoteRef] !== input.expectedRemoteObject) reject("REMOTE_HEAD_MISMATCH", "Origin ref moved after the fetch");
  const origin = await readOriginIdentity(runner, before.root, signal);
  if (!sameRemote(origin, fetch.remoteIdentity)) reject("REMOTE_URL_REJECTED", "Origin identity changed after the fetch");

  const final = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, final); assertMutationReady(final, input.expectedBranch, input.expectedHead);
  const finalStatus = await readStatus(runner, final, signal);
  if (!final.indexMatchesHead || !cleanStatus(finalStatus.entries)) reject("INDEX_NOT_EMPTY", "Repository changed while preparing merge");
  await sessions.assertNoActiveSession(final.repositoryId);
  if ((await listOriginRefs(runner, final.root, signal))[input.remoteRef] !== input.expectedRemoteObject
    || !sameRemote(await readOriginIdentity(runner, final.root, signal), fetch.remoteIdentity)) {
    reject("REMOTE_HEAD_MISMATCH", "Remote identity or ref changed while preparing merge");
  }
  const mergeSessionId = await availableMergeId(sessions, options.generateId ?? randomUUID);
  const prepared = Object.freeze({ mergeSessionId });
  startStates.set(prepared, { snapshot: Object.freeze({ ...final }), status: finalStatus, fetch, target: input.expectedRemoteObject, mergeSessionId, now: options.now ?? (() => new Date().toISOString()) });
  return prepared;
}

export function preparedMergeObservation(prepared: PreparedMerge): MergePreflightObservation {
  const state = startStates.get(prepared); if (state === undefined) reject("INVALID_INPUT", "Prepared merge authority is invalid or consumed");
  return { merge_session_id: state.mergeSessionId, branch: state.snapshot.branch!, original_head: state.snapshot.head,
    target_object: state.target,
    fetch_id: state.fetch.fetchId, index_tree: state.snapshot.indexTree };
}

export async function executePreparedMerge(runner: GitRunner, sessions: SessionStore, prepared: PreparedMerge, signal?: AbortSignal): Promise<MergeExecutionOutcome> {
  const state = startStates.get(prepared); if (state === undefined) reject("INVALID_INPUT", "Prepared merge authority is invalid or consumed"); startStates.delete(prepared);
  const target = state.target;
  let command: GitCommandResult | undefined;
  try {
    command = await runner.run({
      cwd: state.snapshot.root, args: ["merge", "--no-gpg-sign", target],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.merge), maxOutputBytes: OUTPUT_LIMIT,
    }, signal);
  }
  catch { command = undefined; }
  return withReconciliationDeadline(async () => {
  let after: RepositorySnapshot;
  try { after = await inspectRepository(runner, state.snapshot.root); } catch { indeterminate<MergeData>("git_merge", "Merge started but repository state could not be confirmed"); }
  if (!sameIdentity(state.snapshot, after) || after.branch !== state.snapshot.branch) indeterminate<MergeData>("git_merge", "Merge changed repository identity or branch unexpectedly");
  if (after.operationState === "merge" && after.head === state.snapshot.head) {
    let conflicts: readonly string[]; let observedTarget: string;
    try { [conflicts, observedTarget] = await Promise.all([unresolvedPaths(runner, after.root), mergeHead(runner, after.root)]); }
    catch { indeterminate<MergeData>("git_merge", "Merge conflict metadata could not be confirmed"); }
    if (observedTarget !== target || conflicts.length === 0 || commandSucceeded(command)) indeterminate<MergeData>("git_merge", "Merge conflict state did not match the requested target");
    const now = state.now();
    const record: MergeRecord = { kind: "merge", mergeSessionId: state.mergeSessionId, repositoryId: after.repositoryId, branch: after.branch!,
      originalHead: state.snapshot.head, targetObject: target, fetchId: state.fetch.fetchId, currentIndexTree: mergeIndexStateId(after.indexTree),
      conflictedPaths: conflicts, resolvedPaths: [], createdAt: now, updatedAt: now };
    try { await sessions.createMergeSession(record); } catch { indeterminate<MergeData>("git_merge", "Merge conflicted but its bridge session could not be persisted"); }
    proven<MergeData>({ status: "conflicted", operation: "git_merge", warnings: [], data: { head: after.head, merge_session_id: record.mergeSessionId, conflicted_paths: [...conflicts] } });
  }
  if (after.operationState !== "none") indeterminate<MergeData>("git_merge", "Merge left unrecognized operation state");
  let exactFastForward = false;
  let exactAlreadyUpToDate = false;
  let exactMergeCommit = false;
  try {
    if (after.head === target && target !== state.snapshot.head) exactFastForward = await isAncestor(runner, after.root, state.snapshot.head, target);
    else if (after.head === state.snapshot.head && commandSucceeded(command)) {
      const afterStatus = await readStatus(runner, after);
      exactAlreadyUpToDate = after.indexTree === state.snapshot.indexTree
        && afterStatus.worktree_snapshot_id === state.status.worktree_snapshot_id
        && await isAncestor(runner, after.root, target, state.snapshot.head);
    } else if (after.head !== state.snapshot.head) {
      const topology = await parents(runner, after.root, after.head);
      exactMergeCommit = topology.length === 2 && topology[0] === state.snapshot.head && topology[1] === target;
    }
  } catch { /* classified below */ }
  if (exactFastForward || exactAlreadyUpToDate || exactMergeCommit) {
    const warnings: string[] = [];
    if (!commandSucceeded(command) || command?.stderr !== "") warnings.push("Git emitted incomplete diagnostics after the merge result was proven");
    if (!exactAlreadyUpToDate && !after.indexMatchesHead) warnings.push("The repository index differs from the created merge result after native hooks ran");
    return { data: { head: after.head, merge_session_id: null, conflicted_paths: [] }, warnings };
  }
  if (after.head === state.snapshot.head && after.indexTree === state.snapshot.indexTree && !commandSucceeded(command)) {
    const afterStatus = await statusSnapshot(runner, after);
    if (afterStatus !== undefined && afterStatus.worktree_snapshot_id === state.status.worktree_snapshot_id) {
      failed<MergeData>("git_merge", command, "Git merge failed without changing the repository");
    }
  }
  indeterminate<MergeData>("git_merge", "Merge changed state without a provable requested result");
  });
}

export async function mergeFetchedRef(runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: MergeRequest, signal?: AbortSignal, options: MergePreparationOptions = {}): Promise<MergeExecutionOutcome> {
  const prepared = await prepareMergeFetchedRef(runner, sessions, snapshot, input, signal, options);
  return executePreparedMerge(runner, sessions, prepared, signal);
}

export async function prepareConflictAdd(runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: ConflictAddRequest, signal?: AbortSignal): Promise<PreparedConflictAdd> {
  if (input.paths.length === 0 || new Set(input.paths).size !== input.paths.length || input.paths.some((path) => !relativeGitPath.safeParse(path).success)) reject("INVALID_INPUT", "Conflict add paths must be non-empty unique safe input paths");
  const safe = await validatePaths(runner, snapshot.root, input.paths, signal, { allowIndexedGitlink: true });
  const state = await assertActiveState(runner, sessions, snapshot, input, signal);
  if (safe.some((path) => !state.record.conflictedPaths.includes(path))) reject("SESSION_MISMATCH", "Conflict add path is not unresolved in this merge session");
  const indexProof = await readConflictIndexProof(runner, state.snapshot.root, safe, signal);
  const confirmed = await inspectRepository(runner, state.snapshot.root, signal);
  if (!sameIdentity(state.snapshot, confirmed) || confirmed.branch !== state.snapshot.branch || confirmed.head !== state.snapshot.head
    || confirmed.operationState !== "merge" || confirmed.indexTree !== state.snapshot.indexTree
    || await mergeHead(runner, confirmed.root) !== state.record.targetObject
    || !samePaths(await unresolvedPaths(runner, confirmed.root), state.unresolved)) reject("SESSION_MISMATCH", "Merge index changed while preparing conflict add");
  const prepared = Object.freeze({ mergeSessionId: input.mergeSessionId });
  addStates.set(prepared, { ...state, snapshot: confirmed, paths: safe, indexProof });
  return prepared;
}

export async function executePreparedConflictAdd(runner: GitRunner, sessions: SessionStore, prepared: PreparedConflictAdd, signal?: AbortSignal): Promise<AddData> {
  const state = addStates.get(prepared); if (state === undefined) reject("INVALID_INPUT", "Prepared conflict add authority is invalid or consumed"); addStates.delete(prepared);
  let command: GitCommandResult | undefined;
  const pathspec = literalPathspecTransport(state.paths);
  try {
    command = await runner.run({
      cwd: state.snapshot.root,
      args: ["add", ...pathspec.args],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.stage),
      maxOutputBytes: OUTPUT_LIMIT,
      ...(pathspec.stdin === undefined ? {} : { stdin: pathspec.stdin }),
    }, signal);
  }
  catch { command = undefined; }
  return withReconciliationDeadline(async () => {
  let after: RepositorySnapshot; let unresolved: readonly string[]; let target: string; let indexProof: ConflictIndexProof;
  try {
    after = await inspectRepository(runner, state.snapshot.root);
    [unresolved, target, indexProof] = await Promise.all([
      unresolvedPaths(runner, state.snapshot.root),
      mergeHead(runner, state.snapshot.root),
      readConflictIndexProof(runner, state.snapshot.root, state.paths),
    ]);
  }
  catch { indeterminate<AddData>("git_add", "Conflict add started but final merge state could not be confirmed"); }
  const validMerge = sameIdentity(state.snapshot, after) && after.branch === state.record.branch && after.head === state.record.originalHead
    && after.operationState === "merge" && target === state.record.targetObject;
  if (!validMerge) indeterminate<AddData>("git_add", "Conflict add changed unrecognized merge state");
  if (!exactAddEffect(state, indexProof, unresolved)) {
    if (!commandSucceeded(command) && after.indexTree === state.snapshot.indexTree && samePaths(unresolved, state.unresolved)
      && state.indexProof.fingerprint === indexProof.fingerprint) {
      failed<AddData>("git_add", command, "Git add failed without changing the merge index");
    }
    indeterminate<AddData>("git_add", "Conflict add effects were not confined to the requested paths");
  }
  const updated: MergeRecord = { ...state.record, currentIndexTree: mergeIndexStateId(after.indexTree), conflictedPaths: unresolved,
    resolvedPaths: [...new Set([...state.record.resolvedPaths, ...state.paths])].sort(), updatedAt: new Date().toISOString() };
  try { await sessions.updateMergeSession(updated, mergeRecordHash(state.record)); } catch { indeterminate<AddData>("git_add", "Conflict paths were staged but session update could not be persisted"); }
  return { mode: "merge", stage_id: null, merge_session_id: updated.mergeSessionId, index_tree: updated.currentIndexTree,
    staged_paths: [...state.paths], unresolved_paths: [...unresolved] };
  });
}

export function preparedConflictAddObservation(prepared: PreparedConflictAdd): ConflictAddPreflightObservation {
  const state = addStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared conflict add authority is invalid or consumed");
  return { merge_session_id: state.record.mergeSessionId, branch: state.record.branch, original_head: state.record.originalHead,
    target_object: state.record.targetObject, fetch_id: state.record.fetchId, index_tree: state.record.currentIndexTree,
    merge_record_hash: mergeRecordHash(state.record), paths: [...state.paths] };
}

export async function addConflictPaths(runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: ConflictAddRequest, signal?: AbortSignal): Promise<AddData> {
  return executePreparedConflictAdd(runner, sessions, await prepareConflictAdd(runner, sessions, snapshot, input, signal), signal);
}

export async function prepareContinueMerge(runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: MergeSessionRequest, signal?: AbortSignal): Promise<PreparedMergeContinue> {
  const state = await assertActiveState(runner, sessions, snapshot, input, signal);
  if (state.unresolved.length !== 0 || state.record.conflictedPaths.length !== 0) reject("SESSION_MISMATCH", "Merge cannot continue with unresolved paths");
  const prepared = Object.freeze({ mergeSessionId: input.mergeSessionId }); continueStates.set(prepared, state); return prepared;
}

export function preparedActiveMergeObservation(prepared: PreparedMergeContinue | PreparedMergeAbort): ActiveMergePreflightObservation {
  const state = continueStates.get(prepared as PreparedMergeContinue) ?? abortStates.get(prepared as PreparedMergeAbort);
  if (state === undefined) reject("INVALID_INPUT", "Prepared merge-session authority is invalid or consumed");
  return { merge_session_id: state.record.mergeSessionId, branch: state.record.branch, original_head: state.record.originalHead,
    target_object: state.record.targetObject, fetch_id: state.record.fetchId, index_tree: state.record.currentIndexTree,
    merge_record_hash: mergeRecordHash(state.record) };
}

function mergeSuccessWarnings(command: GitCommandResult | undefined, indexDiffers: boolean): readonly string[] {
  const warnings: string[] = [];
  if (!commandSucceeded(command) || command?.stderr !== "") warnings.push("Git emitted incomplete diagnostics after the merge commit was proven");
  if (indexDiffers) warnings.push("The repository index differs from the created merge commit after native hooks ran");
  return warnings;
}

export async function executePreparedContinue(runner: GitRunner, prepared: PreparedMergeContinue, signal?: AbortSignal): Promise<MergeContinueExecutionOutcome> {
  const state = continueStates.get(prepared); if (state === undefined) reject("INVALID_INPUT", "Prepared merge continue authority is invalid or consumed"); continueStates.delete(prepared);
  let command: GitCommandResult | undefined;
  try {
    command = await runner.run({
      cwd: state.snapshot.root, args: ["-c", "commit.gpgSign=false", "merge", "--continue"],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.merge), maxOutputBytes: OUTPUT_LIMIT,
    }, signal);
  }
  catch { command = undefined; }
  return withReconciliationDeadline(async () => {
  let after: RepositorySnapshot;
  try { after = await inspectRepository(runner, state.snapshot.root); } catch { indeterminate<MergeContinueData>("git_merge_continue", "Merge continue started but final state could not be confirmed"); }
  if (!sameIdentity(state.snapshot, after) || after.branch !== state.record.branch) indeterminate<MergeContinueData>("git_merge_continue", "Merge continue changed repository identity or branch");
  if (after.operationState === "none" && after.head !== state.record.originalHead) {
    try {
      const topology = await parents(runner, after.root, after.head);
      if (topology.length === 2 && topology[0] === state.record.originalHead && topology[1] === state.record.targetObject) {
        return { data: { head: after.head, commit: after.head }, warnings: mergeSuccessWarnings(command, !after.indexMatchesHead) };
      }
    } catch { /* classified below */ }
    indeterminate<MergeContinueData>("git_merge_continue", "Created merge commit topology could not be proven");
  }
  if (!commandSucceeded(command) && await unchangedActiveState(runner, state, after)) {
    failed<MergeContinueData>("git_merge_continue", command, "Git merge continue did not create a commit");
  }
  indeterminate<MergeContinueData>("git_merge_continue", "Merge continue left unrecognized state");
  });
}

export async function continueMerge(runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: MergeSessionRequest, signal?: AbortSignal): Promise<MergeContinueExecutionOutcome> {
  return executePreparedContinue(runner, await prepareContinueMerge(runner, sessions, snapshot, input, signal), signal);
}

export async function prepareAbortMerge(runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: MergeSessionRequest, signal?: AbortSignal): Promise<PreparedMergeAbort> {
  const state = await assertActiveState(runner, sessions, snapshot, input, signal);
  const prepared = Object.freeze({ mergeSessionId: input.mergeSessionId }); abortStates.set(prepared, state); return prepared;
}

export async function executePreparedAbort(runner: GitRunner, prepared: PreparedMergeAbort, signal?: AbortSignal): Promise<MergeAbortExecutionOutcome> {
  const state = abortStates.get(prepared); if (state === undefined) reject("INVALID_INPUT", "Prepared merge abort authority is invalid or consumed"); abortStates.delete(prepared);
  let command: GitCommandResult | undefined;
  try {
    command = await runner.run({
      cwd: state.snapshot.root, args: ["merge", "--abort"],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.merge), maxOutputBytes: OUTPUT_LIMIT,
    }, signal);
  }
  catch { command = undefined; }
  return withReconciliationDeadline(async () => {
  let after: RepositorySnapshot;
  try { after = await inspectRepository(runner, state.snapshot.root); } catch { indeterminate<MergeAbortData>("git_merge_abort", "Merge abort started but final state could not be confirmed"); }
  if (!sameIdentity(state.snapshot, after) || after.branch !== state.record.branch || after.head !== state.record.originalHead) indeterminate<MergeAbortData>("git_merge_abort", "Merge abort changed repository identity, branch, or HEAD");
  if (after.operationState === "none") {
    let status;
    try { status = await readStatus(runner, after); } catch { indeterminate<MergeAbortData>("git_merge_abort", "Aborted merge worktree could not be proven clean"); }
    if (!after.indexMatchesHead || status.entries.length !== 0) indeterminate<MergeAbortData>("git_merge_abort", "Merge abort did not restore the clean pre-merge state");
    return { data: { head: after.head }, warnings: commandSucceeded(command) && command?.stderr === "" ? [] : ["Git emitted incomplete diagnostics after merge abort was proven"] };
  }
  if (!commandSucceeded(command) && await unchangedActiveState(runner, state, after)) {
    failed<MergeAbortData>("git_merge_abort", command, "Git merge abort failed without changing merge state");
  }
  indeterminate<MergeAbortData>("git_merge_abort", "Merge abort left partial or unrecognized state");
  });
}

export async function abortMerge(runner: GitRunner, sessions: SessionStore, snapshot: RepositorySnapshot, input: MergeSessionRequest, signal?: AbortSignal): Promise<MergeAbortExecutionOutcome> {
  return executePreparedAbort(runner, await prepareAbortMerge(runner, sessions, snapshot, input, signal), signal);
}

export function createMergeAfterPersistCleanup(
  sessions: SessionStore, binding: MergeCleanupBinding,
): (result: BridgeResult<MergeContinueData | MergeAbortData>) => Promise<void> {
  return async (result): Promise<void> => {
    if (result.status !== "succeeded") return;
    if (result.request_id !== binding.requestId || result.repository_id !== binding.repositoryId || result.operation !== binding.operation) throw new Error("Durable merge success does not match cleanup binding");
    const parsed = binding.operation === "git_merge_continue" ? mergeContinueDataSchema.safeParse(result.data) : mergeAbortDataSchema.safeParse(result.data);
    if (!parsed.success) throw new Error("Durable merge success data is invalid");
    const observed = result.observed_before;
    if (observed === undefined || observed.merge_session_id !== binding.mergeSessionId || observed.branch !== binding.expectedBranch
      || observed.original_head !== binding.expectedHead || typeof observed.merge_record_hash !== "string" || !/^[0-9a-f]{64}$/.test(observed.merge_record_hash)) throw new Error("Durable merge success does not match cleanup context");
    await sessions.deleteMergeSessionByIdentity({ repositoryId: binding.repositoryId, mergeSessionId: binding.mergeSessionId, recordHash: observed.merge_record_hash });
  };
}
