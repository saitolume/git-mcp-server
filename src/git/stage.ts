import { randomUUID } from "node:crypto";
import { remainingDeadlineTimeoutMs, throwIfDeadlineExceeded, withReconciliationDeadline } from "../deadline.js";
import { gitOutputPath } from "../domain/inputs.js";
import { BridgeRejection, type AddData, type RestoreStagedData } from "../domain/result.js";
import { RETURNED_PATH_SET_MAX_BYTES, RETURNED_PATH_SET_MAX_COUNT } from "../limits.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import type { StageRecord } from "../state/records.js";
import type { SessionStore } from "../state/session-store.js";
import { assertTrackedPathConfined, validatePaths } from "./path-policy.js";
import { literalPathChunks, literalPathspecTransport } from "./pathspec.js";
import {
  assertMutationReady,
  inspectRepository,
  readIndexStageMap,
  type IndexStageMap,
  type RepositorySnapshot,
} from "./repository.js";
import type { GitCommandResult, GitRunner } from "./runner.js";
import { COMPLETE_RECORD_MAX_BYTES, DelimitedRecordParser, STREAM_STDERR_MAX_BYTES, utf8Bytes } from "./streaming.js";

type AddRequest = {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly paths: readonly string[];
  readonly stageId?: string;
  readonly mergeSessionId?: string;
};

type RestoreRequest = {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly stageId: string;
  readonly paths: readonly string[];
};

export interface PreparedAddPaths {
  readonly paths: readonly string[];
}

export interface PreparedRestoreStaged {
  readonly paths: readonly string[];
}

interface PreparedAddState {
  readonly snapshot: RepositorySnapshot;
  readonly input: AddRequest;
  readonly record: StageRecord | null;
  readonly stagedBefore: readonly string[];
  readonly initialIndexTree: string;
  readonly outsideIndexFingerprint: string;
}

interface PreparedRestoreState {
  readonly snapshot: RepositorySnapshot;
  readonly input: RestoreRequest;
  readonly record: StageRecord;
  readonly stagedBefore: readonly string[];
  readonly outsideIndexFingerprint: string;
}

const preparedAdds = new WeakMap<PreparedAddPaths, PreparedAddState>();
const preparedRestores = new WeakMap<PreparedRestoreStaged, PreparedRestoreState>();

const MUTATION_OUTPUT_LIMIT = 32_768;
const STAGED_PATH_ARGS = ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"];

function reject(
  code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_MISMATCH" | "INDEX_NOT_EMPTY" | "SESSION_NOT_FOUND" | "SESSION_MISMATCH",
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new BridgeRejection({ code, message, ...(details === undefined ? {} : { details }) });
}

function assertIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed before staging");
  }
}

function deduplicate(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

async function safePaths(runner: GitRunner, snapshot: RepositorySnapshot, paths: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
  const unique = deduplicate(paths);
  if (unique.length === 0) reject("INVALID_INPUT", "At least one explicit path is required");
  return validatePaths(runner, snapshot.root, unique, signal, {
    allowHeadTrackedMissing: true,
    allowIndexedGitlink: true,
  });
}

function assertRecord(record: StageRecord, snapshot: RepositorySnapshot, input: AddRequest | RestoreRequest): void {
  if (record.repositoryId !== snapshot.repositoryId || record.branch !== input.expectedBranch || record.baseHead !== input.expectedHead) {
    reject("SESSION_MISMATCH", "Stage session does not match the repository, branch, or base HEAD");
  }
  if (snapshot.indexTree !== record.currentIndexTree) {
    reject("INDEX_MISMATCH", "Repository index does not match the stage session", {
      expectedIndexTree: record.currentIndexTree, observedIndexTree: snapshot.indexTree,
    });
  }
}

async function runMutation(
  runner: GitRunner,
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
  stdin?: string,
): Promise<GitCommandResult> {
  return runner.run({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.stage), maxOutputBytes: MUTATION_OUTPUT_LIMIT,
    ...(stdin === undefined ? {} : { stdin }),
  }, signal);
}

async function readStagedPaths(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const paths: string[] = [];
  let bytes = 0;
  let previous: Buffer | undefined;
  const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git staged path set", (path) => {
    throwIfDeadlineExceeded(signal);
    const pathBytes = Buffer.from(path);
    const nextBytes = bytes + utf8Bytes(path);
    if (!gitOutputPath.safeParse(path).success || path.includes("�")
      || (previous !== undefined && Buffer.compare(previous, pathBytes) >= 0)) {
      throw new Error("Malformed staged path output");
    }
    if (paths.length + 1 > RETURNED_PATH_SET_MAX_COUNT || nextBytes > RETURNED_PATH_SET_MAX_BYTES) {
      throw new BridgeRejection({
        code: "UNSUPPORTED_REPOSITORY_STATE",
        message: "Staged path result exceeds its explicit returned-set limit",
      });
    }
    previous = pathBytes;
    paths.push(path);
    bytes = nextBytes;
  });
  const result = await runner.runStreaming({
    cwd: snapshot.root, args: STAGED_PATH_ARGS, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxStderrBytes: STREAM_STDERR_MAX_BYTES,
  }, (chunk) => parser.write(chunk), signal);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.aborted
    || result.stdoutTruncated || result.stderrTruncated || result.stderr !== "") {
    throw new Error("Unable to read the complete staged path set");
  }
  try { parser.finish(); } catch { throw new Error("Malformed staged path output"); }
  for (const path of paths) {
    throwIfDeadlineExceeded(signal);
    await assertTrackedPathConfined(snapshot.root, path);
  }
  return paths;
}

function completeQuietDiff(result: GitCommandResult): boolean | null {
  if (result.signal !== null || result.timedOut || result.aborted || result.stdoutTruncated || result.stderrTruncated
    || result.stdout !== "" || result.stderr !== "") return null;
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
}

async function requestedRepresentationsMatchIndex(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  paths: readonly string[],
  stagedAfter: ReadonlySet<string>,
  indexProof: IndexStageMap,
): Promise<boolean> {
  for (const chunk of literalPathChunks(paths)) {
    const args = ["diff-files", "--quiet", "--no-ext-diff", "--ignore-submodules=dirty", "--", ...chunk];
    const comparison = completeQuietDiff(await runner.run({
      cwd: snapshot.root,
      args,
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
      maxOutputBytes: MUTATION_OUTPUT_LIMIT,
    }));
    if (comparison === null) throw new Error("Unable to prove requested worktree representations against the index");
    if (!comparison) return false;
  }
  return paths.every((path) => {
    const entries = indexProof.capturedEntries.get(path) ?? [];
    return (entries.length === 1 && entries[0]?.stage === "0")
      || (entries.length === 0 && stagedAfter.has(path));
  });
}

async function reconcileStageOwnership(
  sessions: SessionStore,
  record: StageRecord | null,
  snapshot: RepositorySnapshot,
  input: AddRequest,
  initialIndexTree: string,
  ownedPaths: readonly string[],
): Promise<StageRecord | null> {
  if (record === null && ownedPaths.length === 0) return null;
  if (record !== null && ownedPaths.length === 0) {
    await sessions.deleteStageSession(record);
    return null;
  }
  const now = new Date().toISOString();
  if (record === null) {
    const created: StageRecord = {
      kind: "stage", stageId: randomUUID(), repositoryId: snapshot.repositoryId, branch: input.expectedBranch,
      baseHead: input.expectedHead, initialIndexTree, currentIndexTree: snapshot.indexTree,
      ownedPaths, createdAt: now, updatedAt: now,
    };
    await sessions.createStageSession(created);
    return created;
  }
  const updated: StageRecord = { ...record, currentIndexTree: snapshot.indexTree, ownedPaths, updatedAt: now };
  await sessions.updateStageSession(updated);
  return updated;
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((path) => expected.has(path));
}

function assertIndexMatchesPaths(snapshot: RepositorySnapshot, paths: readonly string[]): void {
  if (snapshot.indexMatchesHead !== (paths.length === 0)) {
    throw new Error("Repository index tree does not match its complete staged path set");
  }
}

export async function prepareAddPaths(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: AddRequest,
  signal?: AbortSignal,
): Promise<PreparedAddPaths> {
  if (input.stageId !== undefined && input.mergeSessionId !== undefined) reject("INVALID_INPUT", "Stage and merge session IDs are mutually exclusive");
  if (input.mergeSessionId !== undefined) reject("UNSUPPORTED_REPOSITORY_STATE", "Merge-session add is not implemented by normal stage mode");
  const paths = await safePaths(runner, snapshot, input.paths, signal);
  let record: StageRecord | null = null;
  if (input.stageId !== undefined) {
    record = await sessions.getStage(input.stageId);
    if (record === null) reject("SESSION_NOT_FOUND", "Stage session was not found", { stageId: input.stageId });
  }

  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  if (record === null) {
    if (!before.indexMatchesHead) reject("INDEX_NOT_EMPTY", "A new stage session requires an empty index");
    await sessions.assertNoActiveSession(before.repositoryId);
  } else {
    assertRecord(record, before, input);
    await sessions.assertActiveStage(record);
  }

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  if (finalBefore.indexTree !== before.indexTree) reject("INDEX_MISMATCH", "Repository index changed immediately before staging");
  const stagedBefore = await readStagedPaths(runner, finalBefore, signal);
  assertIndexMatchesPaths(finalBefore, stagedBefore);
  if (record === null ? stagedBefore.length !== 0 : !samePathSet(stagedBefore, record.ownedPaths)) {
    reject("SESSION_MISMATCH", "Persisted stage ownership does not match the complete staged path set");
  }
  const allowed = new Set([...(record?.ownedPaths ?? []), ...paths]);
  const indexProof = await readIndexStageMap(runner, finalBefore.root, signal, allowed);
  if (indexProof.fingerprint !== finalBefore.indexTree) {
    reject("INDEX_MISMATCH", "Repository index changed while preparing complete add proof");
  }

  const prepared = Object.freeze({ paths: Object.freeze([...paths]) });
  preparedAdds.set(prepared, {
    snapshot: finalBefore,
    input: Object.freeze({ ...input, paths: Object.freeze([...paths]) }),
    record: record === null ? null : Object.freeze({ ...record, ownedPaths: Object.freeze([...record.ownedPaths]) }),
    stagedBefore: Object.freeze([...stagedBefore]),
    initialIndexTree: before.indexTree,
    outsideIndexFingerprint: indexProof.uncapturedFingerprint,
  });
  return prepared;
}

export function preparedAddObservation(prepared: PreparedAddPaths): Readonly<Record<string, unknown>> {
  const state = preparedAdds.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared add authority is invalid or already consumed");
  return Object.freeze({
    mode: "stage",
    branch: state.snapshot.branch,
    head: state.snapshot.head,
    index_tree: state.snapshot.indexTree,
    stage_id: state.record?.stageId ?? null,
    paths: [...state.input.paths],
    staged_paths: [...state.stagedBefore],
  });
}

export async function executePreparedAddPaths(
  runner: GitRunner,
  sessions: SessionStore,
  prepared: PreparedAddPaths,
  signal?: AbortSignal,
): Promise<AddData> {
  const state = preparedAdds.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared add authority is invalid or already consumed");
  preparedAdds.delete(prepared);
  const { snapshot: finalBefore, input, record, initialIndexTree, outsideIndexFingerprint } = state;
  const paths = input.paths;
  const pathspec = literalPathspecTransport(paths);
  try {
    await runMutation(runner, finalBefore.root, ["add", ...pathspec.args], signal, pathspec.stdin);
  }
  catch { /* The complete post-state proof below decides success. */ }
  return withReconciliationDeadline(async () => {
    const after = await inspectRepository(runner, finalBefore.root);
    assertIdentity(finalBefore, after);
    assertMutationReady(after, input.expectedBranch, input.expectedHead);
    const stagedAfter = await readStagedPaths(runner, after);
    assertIndexMatchesPaths(after, stagedAfter);
    const allowed = new Set([...(record?.ownedPaths ?? []), ...paths]);
    const postIndexProof = await readIndexStageMap(runner, after.root, undefined, allowed);
    if (postIndexProof.fingerprint !== after.indexTree) {
      throw new Error("Repository index changed while proving the Git add result");
    }
    const ownershipConfined = stagedAfter.every((path) => allowed.has(path));
    const outsideIndexUnchanged = postIndexProof.uncapturedFingerprint === outsideIndexFingerprint;
    if (!ownershipConfined || !outsideIndexUnchanged) {
      throw new Error("Git add changed a staged path outside the stage session request");
    }
    const reconciled = await reconcileStageOwnership(
      sessions,
      record,
      after,
      input,
      initialIndexTree,
      stagedAfter,
    );
    const requestedExact = await requestedRepresentationsMatchIndex(
      runner,
      after,
      paths,
      new Set(stagedAfter),
      postIndexProof,
    );
    if (!requestedExact) {
      throw new Error("Git add did not make every requested path exactly match its post-index representation");
    }
    return {
      mode: "stage", stage_id: reconciled?.stageId ?? null, merge_session_id: null, index_tree: after.indexTree,
      staged_paths: reconciled === null ? [] : [...reconciled.ownedPaths], unresolved_paths: [],
    };
  });
}

export async function addPaths(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: AddRequest,
  signal?: AbortSignal,
): Promise<AddData> {
  const prepared = await prepareAddPaths(runner, sessions, snapshot, input, signal);
  return executePreparedAddPaths(runner, sessions, prepared, signal);
}

export async function prepareRestoreStaged(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: RestoreRequest,
  signal?: AbortSignal,
): Promise<PreparedRestoreStaged> {
  const paths = await safePaths(runner, snapshot, input.paths, signal);
  const record = await sessions.getStage(input.stageId);
  if (record === null) reject("SESSION_NOT_FOUND", "Stage session was not found", { stageId: input.stageId });

  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  assertRecord(record, before, input);
  await sessions.assertActiveStage(record);
  const owned = new Set(record.ownedPaths);
  if (paths.some((path) => !owned.has(path))) {
    reject("SESSION_MISMATCH", "Restore-staged paths must all be owned by the stage session");
  }

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  if (finalBefore.indexTree !== before.indexTree) reject("INDEX_MISMATCH", "Repository index changed immediately before restore-staged");
  const stagedBefore = await readStagedPaths(runner, finalBefore, signal);
  assertIndexMatchesPaths(finalBefore, stagedBefore);
  if (!samePathSet(stagedBefore, record.ownedPaths)) {
    reject("SESSION_MISMATCH", "Persisted stage ownership does not match the complete staged path set");
  }
  const indexProof = await readIndexStageMap(runner, finalBefore.root, signal, new Set(paths));
  if (indexProof.fingerprint !== finalBefore.indexTree) {
    reject("INDEX_MISMATCH", "Repository index changed while preparing complete restore-staged proof");
  }

  const prepared = Object.freeze({ paths: Object.freeze([...paths]) });
  preparedRestores.set(prepared, {
    snapshot: finalBefore,
    input: Object.freeze({ ...input, paths: Object.freeze([...paths]) }),
    record: Object.freeze({ ...record, ownedPaths: Object.freeze([...record.ownedPaths]) }),
    stagedBefore: Object.freeze([...stagedBefore]),
    outsideIndexFingerprint: indexProof.uncapturedFingerprint,
  });
  return prepared;
}

export function preparedRestoreStagedObservation(prepared: PreparedRestoreStaged): Readonly<Record<string, unknown>> {
  const state = preparedRestores.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared restore-staged authority is invalid or already consumed");
  return Object.freeze({
    branch: state.snapshot.branch,
    head: state.snapshot.head,
    index_tree: state.snapshot.indexTree,
    stage_id: state.record.stageId,
    paths: [...state.input.paths],
    staged_paths: [...state.stagedBefore],
  });
}

export async function executePreparedRestoreStaged(
  runner: GitRunner,
  sessions: SessionStore,
  prepared: PreparedRestoreStaged,
  signal?: AbortSignal,
): Promise<RestoreStagedData> {
  const state = preparedRestores.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared restore-staged authority is invalid or already consumed");
  preparedRestores.delete(prepared);
  const { snapshot: finalBefore, input, record, outsideIndexFingerprint } = state;
  const paths = input.paths;
  const pathspec = literalPathspecTransport(paths);
  try {
    await runMutation(
      runner,
      finalBefore.root,
      ["restore", "--staged", "--source=HEAD", ...pathspec.args],
      signal,
      pathspec.stdin,
    );
  } catch { /* The complete post-state proof below decides success. */ }
  return withReconciliationDeadline(async () => {
    const after = await inspectRepository(runner, finalBefore.root);
    assertIdentity(finalBefore, after);
    assertMutationReady(after, input.expectedBranch, input.expectedHead);
    const remaining = await readStagedPaths(runner, after);
    assertIndexMatchesPaths(after, remaining);
    const postIndexProof = await readIndexStageMap(runner, after.root, undefined, new Set(paths));
    if (postIndexProof.fingerprint !== after.indexTree) {
      throw new Error("Repository index changed while proving the restore-staged result");
    }
    const previouslyOwned = new Set(record.ownedPaths);
    if (remaining.some((path) => !previouslyOwned.has(path))) {
      throw new Error("Restore-staged produced paths outside the exact remaining stage ownership");
    }
    const expectedRemaining = record.ownedPaths.filter((path) => !paths.includes(path));
    const noOwnedPaths = remaining.length === 0;
    const emptyIndex = after.indexMatchesHead;
    if (noOwnedPaths !== emptyIndex) {
      throw new Error("Restore-staged produced an index inconsistent with stage-session ownership");
    }
    const exactRemaining = samePathSet(remaining, expectedRemaining);
    let reconciled: StageRecord | null;
    if (!exactRemaining) {
      if (noOwnedPaths) await sessions.deleteStageSession(record);
      throw new Error("Restore-staged did not produce the exact remaining stage ownership");
    }
    if (postIndexProof.uncapturedFingerprint !== outsideIndexFingerprint) {
      throw new Error("Restore-staged changed an unrequested owned index representation");
    }
    if (noOwnedPaths) {
      await sessions.deleteStageSession(record);
      reconciled = null;
    } else {
      const updated: StageRecord = {
        ...record, currentIndexTree: after.indexTree, ownedPaths: remaining, updatedAt: new Date().toISOString(),
      };
      await sessions.updateStageSession(updated);
      reconciled = updated;
    }
    return {
      stage_id: reconciled?.stageId ?? null,
      index_tree: after.indexTree,
      remaining_paths: reconciled === null ? [] : [...reconciled.ownedPaths],
    };
  });
}

export async function restoreStaged(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: RestoreRequest,
  signal?: AbortSignal,
): Promise<RestoreStagedData> {
  const prepared = await prepareRestoreStaged(runner, sessions, snapshot, input, signal);
  return executePreparedRestoreStaged(runner, sessions, prepared, signal);
}
