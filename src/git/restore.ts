import type { RestoreWorktreeData, StatusData } from "../domain/result.js";
import { remainingDeadlineTimeoutMs, withReconciliationDeadline } from "../deadline.js";
import { BridgeRejection } from "../domain/result.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import { validatePaths } from "./path-policy.js";
import { literalPathChunks, literalPathspecTransport } from "./pathspec.js";
import { readStatusWithTrackedWorktreeProof } from "./read.js";
import { assertMutationReady, inspectRepository, type RepositorySnapshot } from "./repository.js";
import type { GitCommandResult, GitRunner } from "./runner.js";
import { COMPLETE_RECORD_MAX_BYTES, DelimitedRecordParser, STREAM_STDERR_MAX_BYTES } from "./streaming.js";

export interface RestoreWorktreeRequest {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly worktreeSnapshotId: string;
  readonly paths: readonly string[];
}

/** Opaque, one-shot authority returned only after every non-mutating check succeeds. */
export interface PreparedWorktreeRestore {
  readonly paths: readonly string[];
}

interface PreparedState {
  readonly snapshot: RepositorySnapshot;
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly paths: readonly string[];
  readonly outsideWorktreeSnapshotId: string;
}

const MUTATION_OUTPUT_LIMIT = 32_768;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const RESTORABLE_INDEX_MODES = new Set(["100644", "100755", "120000"]);
const preparedStates = new WeakMap<PreparedWorktreeRestore, PreparedState>();

function reject(
  code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_MISMATCH",
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new BridgeRejection({ code, message, ...(details === undefined ? {} : { details }) });
}

function assertIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed before worktree restore");
  }
}

async function safePaths(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) reject("INVALID_INPUT", "At least one explicit path is required");
  return validatePaths(runner, snapshot.root, unique, signal, { allowHeadTrackedMissing: true });
}

function completeIndexMetadata(result: GitCommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated && result.stderr === "" && !result.stdout.includes("�");
}

async function assertRestorableIndexModes(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const requested = new Set(paths);
  const records = new Map<string, { readonly mode: string; readonly stage: string }[]>();
  for (const chunk of literalPathChunks(paths)) {
    const args = ["ls-files", "--stage", "-z", "--", ...chunk];
    const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git restore index metadata", (record) => {
      const match = /^(100644|100755|120000|160000) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/s.exec(record);
      if (!match || !match[1] || !match[2] || !match[3] || !match[4] || !OBJECT_ID.test(match[2])
        || !requested.has(match[4])) {
        reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned malformed or unexpected index metadata");
      }
      const entries = records.get(match[4]) ?? [];
      if (entries.some(({ stage }) => stage === match[3])) {
        reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned duplicate index metadata");
      }
      entries.push({ mode: match[1], stage: match[3] });
      records.set(match[4], entries);
    });
    const result = await runner.runStreaming({
      cwd: snapshot.root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
      maxStderrBytes: STREAM_STDERR_MAX_BYTES,
    }, (data) => parser.write(data), signal);
    if (!completeIndexMetadata(result)) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to read complete index metadata before worktree restore");
    }
    try { parser.finish(); } catch {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to read complete index metadata before worktree restore");
    }
  }

  for (const path of paths) {
    const entries = records.get(path);
    if (entries === undefined || entries.length === 0) {
      reject("INVALID_INPUT", "Restore path must be tracked by the current index", { path });
    }
    if (entries.length !== 1 || entries[0]?.stage !== "0") {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Restore path has ambiguous index stages", { path });
    }
    if (!RESTORABLE_INDEX_MODES.has(entries[0].mode)) {
      reject("INVALID_INPUT", "Restore path must be an index blob or symbolic link", { path });
    }
  }
}

function assertSnapshotMatches(status: StatusData, worktreeSnapshotId: string): void {
  if (status.worktree_snapshot_id !== worktreeSnapshotId) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Worktree snapshot changed before restore");
  }
}

function assertPathsAreTrackedWorktreeChanges(status: StatusData, paths: readonly string[]): void {
  for (const path of paths) {
    const entries = status.entries.filter((entry) => entry.path === path);
    if (entries.length !== 1 || entries[0]?.kind !== "ordinary" || !["M", "T", "D"].includes(entries[0].worktree)) {
      reject("INVALID_INPUT", "Restore path must be an unambiguous tracked worktree modification", { path });
    }
  }
}

function assertPathsRestored(status: StatusData, paths: readonly string[]): void {
  for (const path of paths) {
    const entries = status.entries.filter((entry) => entry.path === path);
    if (entries.length === 0) continue;
    if (entries.length === 1 && entries[0]?.kind === "ordinary" && entries[0].worktree === ".") continue;
    throw new Error("Unable to prove that Git restored every requested worktree path");
  }
}

/**
 * Performs every rejection-capable repository read before the coordinator marks mutationStarted.
 * Task 14 must call this from MutationCallbacks.preflight and retain the returned authority in its closure.
 */
export async function prepareWorktreeRestore(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  input: RestoreWorktreeRequest,
  signal?: AbortSignal,
): Promise<PreparedWorktreeRestore> {
  const canonical = { ...snapshot };
  const requested = {
    expectedBranch: input.expectedBranch,
    expectedHead: input.expectedHead,
    worktreeSnapshotId: input.worktreeSnapshotId,
    paths: [...input.paths],
  };

  const beforeValidation = await inspectRepository(runner, canonical.root, signal);
  assertIdentity(canonical, beforeValidation);
  assertMutationReady(beforeValidation, requested.expectedBranch, requested.expectedHead);
  if (beforeValidation.indexTree !== canonical.indexTree) {
    reject("INDEX_MISMATCH", "Repository index changed before worktree restore");
  }

  const paths = await safePaths(runner, beforeValidation, requested.paths, signal);
  await assertRestorableIndexModes(runner, beforeValidation, paths, signal);

  const before = await inspectRepository(runner, beforeValidation.root, signal);
  assertIdentity(beforeValidation, before);
  assertMutationReady(before, requested.expectedBranch, requested.expectedHead);
  if (before.indexTree !== beforeValidation.indexTree) {
    reject("INDEX_MISMATCH", "Repository index changed while preparing worktree restore");
  }

  const finalProof = await readStatusWithTrackedWorktreeProof(runner, before, paths, signal);
  assertSnapshotMatches(finalProof.status, requested.worktreeSnapshotId);
  assertPathsAreTrackedWorktreeChanges(finalProof.status, paths);

  const publicPaths = Object.freeze([...paths]);
  const prepared = Object.freeze({ paths: publicPaths });
  preparedStates.set(prepared, {
    snapshot: Object.freeze({ ...before }),
    expectedBranch: requested.expectedBranch,
    expectedHead: requested.expectedHead,
    paths: publicPaths,
    outsideWorktreeSnapshotId: finalProof.outsideWorktreeSnapshotId,
  });
  return prepared;
}

/**
 * Consumes one prepared authority, performs exactly one restore mutation, then proves its result.
 * Post-Git verification deliberately remains in this mutation phase so coordinator failures are indeterminate.
 */
export async function executePreparedWorktreeRestore(
  runner: GitRunner,
  prepared: PreparedWorktreeRestore,
  signal?: AbortSignal,
): Promise<RestoreWorktreeData> {
  const state = preparedStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared worktree restore authority is invalid or already consumed");
  preparedStates.delete(prepared);

  const pathspec = literalPathspecTransport(state.paths);
  const args = ["restore", "--worktree", ...pathspec.args];
  try {
    await runner.run({
      cwd: state.snapshot.root,
      args,
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.stage),
      maxOutputBytes: MUTATION_OUTPUT_LIMIT,
      ...(pathspec.stdin === undefined ? {} : { stdin: pathspec.stdin }),
    }, signal);
  } catch { /* The complete post-state proof below decides success. */ }

  return withReconciliationDeadline(async () => {
    const after = await inspectRepository(runner, state.snapshot.root);
    assertIdentity(state.snapshot, after);
    assertMutationReady(after, state.expectedBranch, state.expectedHead);
    if (after.indexTree !== state.snapshot.indexTree) throw new Error("Git worktree restore changed the repository index");
    const afterProof = await readStatusWithTrackedWorktreeProof(runner, after, state.paths);
    assertPathsRestored(afterProof.status, state.paths);
    if (afterProof.outsideWorktreeSnapshotId !== state.outsideWorktreeSnapshotId) {
      throw new Error("Git worktree restore changed worktree state outside the requested paths");
    }
    return { restored_paths: [...state.paths], worktree_snapshot_id: afterProof.status.worktree_snapshot_id };
  });
}

/** Convenience wrapper for direct callers; coordinator adapters must use the explicit phase API above. */
export async function restoreWorktree(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  input: RestoreWorktreeRequest,
  signal?: AbortSignal,
): Promise<RestoreWorktreeData> {
  const prepared = await prepareWorktreeRestore(runner, snapshot, input, signal);
  return executePreparedWorktreeRestore(runner, prepared, signal);
}
