import { remainingDeadlineTimeoutMs, withReconciliationDeadline } from "../deadline.js";
import type { BridgeResult, CommitAmendData } from "../domain/result.js";
import {
  BridgeRejection,
  commitAmendDataSchema,
  HOOK_FAILED_MESSAGE,
} from "../domain/result.js";
import { ProvenMutationOutcome } from "../app/mutation-coordinator.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import type { StageRecord } from "../state/records.js";
import { stageRecordHash, type SessionStore } from "../state/session-store.js";
import {
  assertCommitIdentity,
  assertExactStage,
  expectedPathSetProof,
  hookChangedPaths,
  readCommitTreeProof,
  readHooksPath,
  readStagedPathProof,
  type CommitTreeEntry,
} from "./commit.js";
import { createHookWrappers } from "./hook-wrapper.js";
import {
  readStatusWithWorktreeContentProof,
  type WorktreeContentProof,
} from "./read.js";
import {
  assertMutationReady,
  inspectRepository,
  readIndexStageMap,
  type RepositorySnapshot,
} from "./repository.js";
import type { GitCommandResult, GitRunner } from "./runner.js";

export interface CommitAmendRequest {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly stageId: string;
  readonly worktreeSnapshotId: string;
  readonly message: string;
}

export interface PreparedCommitAmend {
  readonly stageId: string;
}

export interface CommitAmendCleanupBinding {
  readonly requestId: string;
  readonly repositoryId: string;
  readonly operation: "git_commit_amend";
  readonly stageId: string;
  readonly expectedBranch: string;
  readonly expectedHead: string;
}

export interface CommitAmendPreflightObservation extends Readonly<Record<string, unknown>> {
  readonly stage_id: string;
  readonly branch: string;
  readonly old_commit: string;
  readonly old_tree: string;
  readonly index_tree: string;
  readonly worktree_snapshot_id: string;
  readonly stage_record_hash: string;
  readonly unowned_worktree_snapshot_id: string;
}

export interface CommitAmendExecutionOutcome {
  readonly data: CommitAmendData;
  readonly warnings: readonly string[];
}

interface CommitObjectProof {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly signed: boolean;
}

interface PreparedState {
  readonly snapshot: RepositorySnapshot;
  readonly record: StageRecord;
  readonly sessions: SessionStore;
  readonly worktreeSnapshotId: string;
  readonly worktreeContentProof: WorktreeContentProof;
  readonly message: string;
  readonly hooksPath: string;
  readonly oldCommit: CommitObjectProof;
  readonly preIndexTreeFingerprint: string;
  readonly preOwnedEntries: ReadonlyMap<string, CommitTreeEntry>;
}

const MUTATION_OUTPUT_LIMIT = 64_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const preparedStates = new WeakMap<PreparedCommitAmend, PreparedState>();

function reject(
  code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_MISMATCH" | "SESSION_NOT_FOUND" | "SESSION_MISMATCH",
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new BridgeRejection({ code, message, ...(details === undefined ? {} : { details }) });
}

function completeRead(result: GitCommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated && result.stderr === "" && !result.stdout.includes("�");
}

async function readCommitObject(
  runner: GitRunner,
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<CommitObjectProof> {
  const result = await runner.run({
    cwd: root,
    args: ["--no-replace-objects", "cat-file", "commit", commit],
    timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxOutputBytes: MUTATION_OUTPUT_LIMIT,
  }, signal);
  if (!completeRead(result)) throw new Error("Unable to prove current commit metadata");
  const separator = result.stdout.indexOf("\n\n");
  if (separator < 0) throw new Error("Git returned malformed commit metadata");
  const parents: string[] = [];
  let tree: string | undefined;
  let signed = false;
  let continuationOf: string | undefined;
  for (const line of result.stdout.slice(0, separator).split("\n")) {
    if (line.startsWith(" ")) {
      if (continuationOf === undefined) throw new Error("Git returned malformed commit metadata");
      continue;
    }
    const space = line.indexOf(" ");
    const name = space > 0 ? line.slice(0, space) : "";
    const value = space > 0 ? line.slice(space + 1) : "";
    if (name.length === 0 || value.length === 0) throw new Error("Git returned malformed commit metadata");
    continuationOf = name;
    if (name === "tree") {
      if (tree !== undefined || !OBJECT_ID.test(value) || value.length !== commit.length) {
        throw new Error("Git returned malformed commit metadata");
      }
      tree = value;
    }
    if (name === "parent") {
      if (!OBJECT_ID.test(value) || value.length !== commit.length) throw new Error("Git returned malformed commit metadata");
      parents.push(value);
    }
    if (name === "gpgsig" || name === "gpgsig-sha256") signed = true;
  }
  if (tree === undefined || new Set(parents).size !== parents.length) throw new Error("Git returned malformed commit metadata");
  return Object.freeze({ tree, parents: Object.freeze(parents), signed });
}

function sameParents(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function proven<T>(result: BridgeResult<T>): never {
  throw new ProvenMutationOutcome(result);
}

function indeterminate(): never {
  proven<CommitAmendData>({
    status: "indeterminate",
    operation: "git_commit_amend",
    warnings: [],
    error: { code: "OPERATION_INDETERMINATE", message: "The amend started but its final repository state could not be confirmed" },
  });
}

function ordinaryGitFailure(result: GitCommandResult): boolean {
  return result.exitCode !== 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated;
}

async function proveUnchangedAmendFailure(
  runner: GitRunner,
  state: PreparedState,
  after: RepositorySnapshot,
): Promise<void> {
  if (after.headTree !== state.snapshot.headTree || after.indexTree !== state.snapshot.indexTree
    || after.indexMatchesHead !== state.snapshot.indexMatchesHead) {
    throw new Error("Repository trees changed while amend HEAD remained unchanged");
  }
  const index = await readIndexStageMap(runner, after.root);
  if (index.fingerprint !== after.indexTree || index.hasUnmergedEntries
    || index.stageZeroTreeFingerprint !== state.preIndexTreeFingerprint) {
    throw new Error("Complete prepared index proof changed while amend HEAD remained unchanged");
  }
  const statusProof = await readStatusWithWorktreeContentProof(
    runner, after, state.worktreeContentProof.paths,
  );
  if (statusProof.status.worktree_snapshot_id !== state.worktreeSnapshotId
    || statusProof.contentProof.snapshotId !== state.worktreeContentProof.snapshotId
    || statusProof.contentProof.paths.length !== state.worktreeContentProof.paths.length) {
    throw new Error("Worktree proof changed while amend HEAD remained unchanged");
  }
  const record = await state.sessions.getStage(state.record.stageId);
  if (record === null || stageRecordHash(record) !== stageRecordHash(state.record)) {
    throw new Error("Stage record changed while amend HEAD remained unchanged");
  }
  await state.sessions.assertActiveStage(record);
}

export async function prepareCommitAmend(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: CommitAmendRequest,
  signal?: AbortSignal,
): Promise<PreparedCommitAmend> {
  if (input.message.length === 0 || input.message.length > 100_000) reject("INVALID_INPUT", "Amend message length is invalid");
  const record = await sessions.getStage(input.stageId);
  if (record === null) reject("SESSION_NOT_FOUND", "Stage session was not found", { stageId: input.stageId });
  const before = await inspectRepository(runner, snapshot.root, signal);
  assertCommitIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  assertExactStage(record, before, input);
  await sessions.assertActiveStage(record);
  const expectedPaths = expectedPathSetProof(record.ownedPaths);
  const stagedPaths = await readStagedPathProof(runner, before.root, signal);
  if (stagedPaths.count !== expectedPaths.count || stagedPaths.fingerprint !== expectedPaths.fingerprint) {
    reject("SESSION_MISMATCH", "Persisted stage ownership does not match the complete staged path set");
  }
  const statusProof = await readStatusWithWorktreeContentProof(runner, before, [], signal);
  if (statusProof.status.worktree_snapshot_id !== input.worktreeSnapshotId) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Worktree snapshot changed before amend");
  }
  const preIndex = await readIndexStageMap(runner, before.root, signal, new Set(record.ownedPaths));
  if (preIndex.fingerprint !== before.indexTree || preIndex.hasUnmergedEntries) {
    reject("INDEX_MISMATCH", "Repository index changed while preparing amend");
  }
  const preOwnedEntries = new Map<string, CommitTreeEntry>();
  for (const [path, entries] of preIndex.capturedEntries) {
    const entry = entries[0];
    if (entries.length !== 1 || entry === undefined || entry.stage !== "0") {
      reject("INDEX_MISMATCH", "Repository index changed while preparing amend");
    }
    preOwnedEntries.set(path, { mode: entry.mode, objectId: entry.objectId, path });
  }
  const oldCommit = await readCommitObject(runner, before.root, before.head, signal);
  if (oldCommit.tree !== before.headTree) throw new Error("Unable to prove current commit tree");
  if (oldCommit.signed) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Signed HEAD cannot be amended while signing is disabled by policy");
  }
  const hooksPath = await readHooksPath(runner, before.root, signal);
  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertCommitIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  assertExactStage(record, finalBefore, input);
  const finalPaths = await readStagedPathProof(runner, finalBefore.root, signal);
  if (finalPaths.count !== expectedPaths.count || finalPaths.fingerprint !== expectedPaths.fingerprint) {
    reject("SESSION_MISMATCH", "Stage ownership changed while preparing amend");
  }
  const finalStatusProof = await readStatusWithWorktreeContentProof(
    runner, finalBefore, statusProof.contentProof.paths, signal,
  );
  if (finalStatusProof.status.worktree_snapshot_id !== input.worktreeSnapshotId) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Worktree snapshot changed while preparing amend");
  }
  if (finalStatusProof.contentProof.snapshotId !== statusProof.contentProof.snapshotId
    || finalStatusProof.contentProof.paths.length !== statusProof.contentProof.paths.length) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Worktree content changed while preparing amend");
  }
  const finalIndex = await readIndexStageMap(runner, finalBefore.root, signal, new Set(record.ownedPaths));
  if (finalIndex.fingerprint !== finalBefore.indexTree || finalIndex.hasUnmergedEntries
    || finalIndex.stageZeroTreeFingerprint !== preIndex.stageZeroTreeFingerprint) {
    reject("INDEX_MISMATCH", "Repository index changed while preparing amend");
  }
  const finalRecord = await sessions.getStage(record.stageId);
  if (finalRecord === null || stageRecordHash(finalRecord) !== stageRecordHash(record)) {
    reject("SESSION_MISMATCH", "Stage record changed while preparing amend");
  }
  await sessions.assertActiveStage(finalRecord);
  const prepared = Object.freeze({ stageId: record.stageId });
  preparedStates.set(prepared, {
    snapshot: Object.freeze({ ...finalBefore }),
    record: Object.freeze({ ...record, ownedPaths: Object.freeze([...record.ownedPaths]) }),
    sessions,
    worktreeSnapshotId: input.worktreeSnapshotId,
    worktreeContentProof: finalStatusProof.contentProof,
    message: input.message,
    hooksPath,
    oldCommit,
    preIndexTreeFingerprint: preIndex.stageZeroTreeFingerprint,
    preOwnedEntries,
  });
  return prepared;
}

export async function executePreparedCommitAmend(
  runner: GitRunner,
  prepared: PreparedCommitAmend,
  signal?: AbortSignal,
): Promise<CommitAmendExecutionOutcome> {
  const state = preparedStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared amend authority is invalid or already consumed");
  preparedStates.delete(prepared);
  const beforeCommand = await inspectRepository(runner, state.snapshot.root, signal);
  assertCommitIdentity(state.snapshot, beforeCommand);
  assertMutationReady(beforeCommand, state.record.branch, state.snapshot.head);
  if (beforeCommand.indexTree !== state.snapshot.indexTree) {
    reject("INDEX_MISMATCH", "Repository index changed before amend execution");
  }
  const beforeCommandStatusProof = await readStatusWithWorktreeContentProof(
    runner, beforeCommand, state.worktreeContentProof.paths, signal,
  );
  if (beforeCommandStatusProof.status.worktree_snapshot_id !== state.worktreeSnapshotId) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Worktree snapshot changed before amend execution");
  }
  if (beforeCommandStatusProof.contentProof.snapshotId !== state.worktreeContentProof.snapshotId
    || beforeCommandStatusProof.contentProof.paths.length !== state.worktreeContentProof.paths.length) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Worktree content changed before amend execution");
  }
  let command: GitCommandResult | undefined;
  let wrappers: Awaited<ReturnType<typeof createHookWrappers>> | undefined;
  try {
    wrappers = await createHookWrappers(state.hooksPath);
    command = await runner.run({
      cwd: state.snapshot.root,
      args: ["commit", "--amend", "--no-gpg-sign", "--file=-"],
      stdin: state.message,
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.commit),
      maxOutputBytes: MUTATION_OUTPUT_LIMIT,
      hookExecution: { wrappersDirectory: wrappers.directory, failureConsumer: wrappers.failureConsumer },
    }, signal);
  } catch {
    command = undefined;
  } finally {
    try { await wrappers?.cleanup(); } catch { /* Private wrapper cleanup cannot alter Git outcome. */ }
  }

  return withReconciliationDeadline(async () => {
    let after: RepositorySnapshot;
    try { after = await inspectRepository(runner, state.snapshot.root); } catch { indeterminate(); }
    if (after.repositoryId !== state.snapshot.repositoryId || after.root !== state.snapshot.root
      || after.gitDir !== state.snapshot.gitDir || after.commonGitDir !== state.snapshot.commonGitDir
      || after.branch !== state.record.branch || after.operationState !== "none") indeterminate();
    if (after.head === state.snapshot.head) {
      try { await proveUnchangedAmendFailure(runner, state, after); } catch { indeterminate(); }
      if (command?.timedOut) {
        proven<CommitAmendData>({
          status: "failed", operation: "git_commit_amend", warnings: [],
          error: { code: "GIT_TIMEOUT", message: "The amend timed out and HEAD was unchanged" },
        });
      }
      if (command !== undefined && ordinaryGitFailure(command)) {
        const hook = wrappers?.rejectedHook();
        if (hook !== undefined) {
          proven<CommitAmendData>({
            status: "failed", operation: "git_commit_amend", warnings: [],
            error: { code: "HOOK_FAILED", message: HOOK_FAILED_MESSAGE, details: { hook } },
          });
        }
      }
      proven<CommitAmendData>({
        status: "failed", operation: "git_commit_amend", warnings: [],
        error: { code: "GIT_FAILED", message: "Git did not amend the commit" },
      });
    }
    let amended: CommitObjectProof;
    let changedPaths: readonly string[];
    try {
      amended = await readCommitObject(runner, after.root, after.head);
      if (amended.tree !== after.headTree || !sameParents(state.oldCommit.parents, amended.parents)) indeterminate();
      const amendedTree = await readCommitTreeProof(runner, after.root, after.head, new Set());
      if (amendedTree.fingerprint !== state.preIndexTreeFingerprint || after.indexTree !== state.snapshot.indexTree) {
        indeterminate();
      }
      const afterStatusProof = await readStatusWithWorktreeContentProof(
        runner, after, state.worktreeContentProof.paths,
      );
      if (afterStatusProof.contentProof.snapshotId !== state.worktreeContentProof.snapshotId
        || afterStatusProof.contentProof.paths.length !== state.worktreeContentProof.paths.length) indeterminate();
      changedPaths = await hookChangedPaths(
        runner,
        after.root,
        state.snapshot.head,
        state.preIndexTreeFingerprint,
        state.preOwnedEntries,
        state.record.ownedPaths,
        after.head,
      );
    } catch (error) {
      if (error instanceof ProvenMutationOutcome) throw error;
      indeterminate();
    }
    const warnings: string[] = [];
    if (command === undefined || command.exitCode !== 0 || command.signal !== null || command.timedOut || command.aborted
      || command.stdoutTruncated || command.stderrTruncated) {
      warnings.push("Git command completion diagnostics were incomplete after the commit was amended");
    } else if (command.stderr !== "") {
      warnings.push("Git emitted diagnostics after the commit was amended");
    }
    return {
      data: {
        old_commit: state.snapshot.head,
        commit: after.head,
        old_tree: state.snapshot.headTree,
        tree: after.headTree,
        hook_changed_paths: [...changedPaths],
        signing: "disabled_by_policy",
      },
      warnings: Object.freeze(warnings),
    };
  });
}

export function preparedCommitAmendObservation(prepared: PreparedCommitAmend): CommitAmendPreflightObservation {
  const state = preparedStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared amend authority is invalid or already consumed");
  return Object.freeze({
    stage_id: state.record.stageId,
    branch: state.record.branch,
    old_commit: state.snapshot.head,
    old_tree: state.snapshot.headTree,
    index_tree: state.record.currentIndexTree,
    worktree_snapshot_id: state.worktreeSnapshotId,
    stage_record_hash: stageRecordHash(state.record),
    unowned_worktree_snapshot_id: state.worktreeContentProof.snapshotId,
  });
}

export function createAmendAfterPersistCleanup(
  sessions: SessionStore,
  binding: CommitAmendCleanupBinding,
): (result: BridgeResult<CommitAmendData>) => Promise<void> {
  return async (result): Promise<void> => {
    if (result.status !== "succeeded") return;
    if (result.request_id !== binding.requestId || result.repository_id !== binding.repositoryId
      || result.operation !== binding.operation) throw new Error("Durable amend success does not match the cleanup binding");
    const parsed = commitAmendDataSchema.safeParse(result.data);
    if (!parsed.success || parsed.data.old_commit !== binding.expectedHead || parsed.data.commit === binding.expectedHead) {
      throw new Error("Durable amend success does not contain the expected commit context");
    }
    const observed = result.observed_before;
    if (observed === undefined || observed.stage_id !== binding.stageId || observed.branch !== binding.expectedBranch
      || observed.old_commit !== binding.expectedHead || typeof observed.index_tree !== "string"
      || typeof observed.worktree_snapshot_id !== "string" || typeof observed.stage_record_hash !== "string"
      || typeof observed.unowned_worktree_snapshot_id !== "string"
      || !/^[0-9a-f]{64}$/.test(observed.stage_record_hash)) {
      throw new Error("Durable amend success does not match the stage cleanup context");
    }
    await sessions.deleteStageSessionByIdentity({
      repositoryId: binding.repositoryId,
      stageId: binding.stageId,
      recordHash: observed.stage_record_hash,
    });
  };
}
