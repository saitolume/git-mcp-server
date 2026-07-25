import type { GitSwitchAttachInput, GitSwitchCreateInput } from "../domain/inputs.js";
import { remainingDeadlineTimeoutMs, withReconciliationDeadline } from "../deadline.js";
import { BridgeRejection, type SwitchAttachData, type SwitchCreateData } from "../domain/result.js";
import { assertWellFormedGitText, isWellFormedGitText } from "../domain/git-text.js";
import type { SessionStore } from "../state/session-store.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import { assertSwitchCreateReady, canonicalBranchRef, inspectRepository, type RepositorySnapshot } from "./repository.js";
import { readStatus } from "./read.js";
import type { GitCommandResult, GitRunner } from "./runner.js";

type SwitchCreateRequest = Pick<GitSwitchCreateInput, "branch"> & {
  readonly expectedBranch: string | null;
  readonly expectedHead: string;
};

export interface PreparedSwitchCreate {
  readonly branch: string;
}

export interface SwitchCreatePreflightObservation extends Readonly<Record<string, unknown>> {
  readonly branch: string | null;
  readonly head: string;
  readonly index_tree: string;
  readonly new_branch: string;
}

interface PreparedSwitchCreateState {
  readonly snapshot: RepositorySnapshot;
  readonly branch: string;
}

const preparedSwitches = new WeakMap<PreparedSwitchCreate, PreparedSwitchCreateState>();

const MUTATION_OUTPUT_LIMIT = 32_768;

function completed(result: GitCommandResult | undefined): boolean {
  return result !== undefined && result.exitCode !== null && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated;
}

function reject(
  code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_NOT_EMPTY" | "HEAD_MISMATCH",
  message: string,
): never {
  throw new BridgeRejection({ code, message });
}

function assertIdentity(
  expected: RepositorySnapshot,
  actual: RepositorySnapshot,
  action = "branch creation",
): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    reject("UNSUPPORTED_REPOSITORY_STATE", `Repository identity changed before ${action}`);
  }
}

async function run(runner: GitRunner, root: string, args: readonly string[], signal?: AbortSignal): Promise<GitCommandResult> {
  return runner.run({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.stage), maxOutputBytes: MUTATION_OUTPUT_LIMIT,
  }, signal);
}

export async function prepareSwitchCreate(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: SwitchCreateRequest,
  signal?: AbortSignal,
): Promise<PreparedSwitchCreate> {
  assertWellFormedGitText(input.branch, "Branch name");
  const checkArgs = ["check-ref-format", "--branch", input.branch];
  const checked = await run(runner, snapshot.root, checkArgs, signal);
  if (!completed(checked) || checked.exitCode !== 0) reject("INVALID_INPUT", "Branch name is invalid");

  const existingArgs = ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`];
  const existing = await run(runner, snapshot.root, existingArgs, signal);
  if (!completed(existing) || (existing.exitCode !== 0 && existing.exitCode !== 1)) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to verify whether the branch already exists");
  }
  if (existing.exitCode === 0) reject("INVALID_INPUT", "Local branch already exists");

  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  assertSwitchCreateReady(before, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(before.repositoryId);
  if (!before.indexMatchesHead) reject("INDEX_NOT_EMPTY", "Branch creation requires an empty index");

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertSwitchCreateReady(finalBefore, input.expectedBranch, input.expectedHead);
  if (finalBefore.indexTree !== before.indexTree || finalBefore.headTree !== before.headTree) {
    reject("INDEX_NOT_EMPTY", "Repository index changed before branch creation");
  }
  const status = await readStatus(runner, finalBefore, signal);
  if (status.entries.length !== 0) reject("UNSUPPORTED_REPOSITORY_STATE", "Branch creation requires a clean worktree");

  const prepared = Object.freeze({ branch: input.branch });
  preparedSwitches.set(prepared, { snapshot: finalBefore, branch: input.branch });
  return prepared;
}

export function preparedSwitchCreateObservation(prepared: PreparedSwitchCreate): SwitchCreatePreflightObservation {
  const state = preparedSwitches.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared branch creation authority is invalid or already consumed");
  return Object.freeze({
    branch: state.snapshot.branch,
    head: state.snapshot.head,
    index_tree: state.snapshot.indexTree,
    new_branch: state.branch,
  });
}

export async function executePreparedSwitchCreate(
  runner: GitRunner,
  prepared: PreparedSwitchCreate,
  signal?: AbortSignal,
): Promise<SwitchCreateData> {
  const state = preparedSwitches.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared branch creation authority is invalid or already consumed");
  preparedSwitches.delete(prepared);
  const { snapshot: finalBefore, branch } = state;

  const switchArgs = ["switch", "-c", branch];
  let switched: GitCommandResult | undefined;
  try { switched = await run(runner, finalBefore.root, switchArgs, signal); }
  catch { switched = undefined; }

  return withReconciliationDeadline(async () => {
    // Caller cancellation cannot suppress this separately bounded proof.
    const after = await inspectRepository(runner, finalBefore.root);
    assertIdentity(finalBefore, after);
    if (after.branch !== branch || after.head !== finalBefore.head || after.operationState !== "none"
      || !after.indexMatchesHead || after.indexTree !== finalBefore.indexTree) {
      throw new Error(!completed(switched) || switched?.exitCode !== 0
        ? "Git branch creation did not complete successfully"
        : "Git branch creation produced an unexpected repository state");
    }
    const afterStatus = await readStatus(runner, after);
    if (afterStatus.entries.length !== 0) throw new Error("Git branch creation did not preserve a clean worktree");
    return { branch: after.branch, head: after.head };
  });
}

export async function switchCreate(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: SwitchCreateRequest,
  signal?: AbortSignal,
): Promise<SwitchCreateData> {
  const prepared = await prepareSwitchCreate(runner, sessions, snapshot, input, signal);
  return executePreparedSwitchCreate(runner, prepared, signal);
}

type SwitchAttachRequest = Pick<GitSwitchAttachInput, "branch"> & {
  readonly expectedBranch: null;
  readonly expectedHead: string;
  readonly expectedBranchHead: string;
};

export interface PreparedSwitchAttach {
  readonly branch: string;
}

export interface SwitchAttachPreflightObservation extends Readonly<Record<string, unknown>> {
  readonly branch: null;
  readonly head: string;
  readonly index_tree: string;
  readonly target_branch: string;
  readonly target_head: string;
}

interface PreparedSwitchAttachState {
  readonly snapshot: RepositorySnapshot;
  readonly branch: string;
  readonly branchRef: string;
  readonly targetHead: string;
}

const preparedAttachments = new WeakMap<PreparedSwitchAttach, PreparedSwitchAttachState>();

function exactObjectId(result: GitCommandResult): string | null {
  if (!completed(result) || result.exitCode !== 0 || result.stderr !== "") return null;
  const value = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null;
}

async function readLocalBranchHead(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  branchRef: string,
  signal?: AbortSignal,
): Promise<string> {
  const existence = await run(runner, snapshot.root, ["show-ref", "--verify", "--quiet", branchRef], signal);
  if (completed(existence) && existence.exitCode === 1 && existence.stdout === "" && existence.stderr === "") {
    reject("INVALID_INPUT", "Target local branch does not exist");
  }
  if (!completed(existence) || existence.exitCode !== 0 || existence.stdout !== "" || existence.stderr !== "") {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to prove whether the target local branch exists");
  }
  const result = await run(runner, snapshot.root, ["show-ref", "--verify", "--hash", branchRef], signal);
  const head = exactObjectId(result);
  if (head === null) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to prove the target local branch HEAD");
  return head;
}

async function assertBranchNotCheckedOut(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  branchRef: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await run(runner, snapshot.root, ["worktree", "list", "--porcelain", "-z"], signal);
  if (!completed(result) || result.exitCode !== 0 || result.stderr !== "") {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to prove target branch worktree ownership");
  }
  if (parseWorktreeOwnership(result.stdout, branchRef)) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Target local branch is already checked out in another worktree");
  }
}

function parseWorktreeOwnership(output: string, targetBranchRef: string): boolean {
  if (!output.endsWith("\0\0") || !isWellFormedGitText(output)) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
  }
  const records = output.slice(0, -2).split("\0\0");
  if (records.length === 0 || records.some((record) => record.length === 0)) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
  }
  let targetCheckedOut = false;
  for (const record of records) {
    const fields = record.split("\0");
    const values = new Map<string, string>();
    for (const field of fields) {
      const separator = field.indexOf(" ");
      const key = separator === -1 ? field : field.slice(0, separator);
      const value = separator === -1 ? "" : field.slice(separator + 1);
      if (!["worktree", "HEAD", "branch", "detached", "bare", "locked", "prunable"].includes(key)
        || values.has(key)) {
        reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
      }
      values.set(key, value);
    }
    const worktree = values.get("worktree");
    if (worktree === undefined || worktree.length === 0 || !worktree.startsWith("/")) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
    }
    for (const marker of ["detached", "bare"] as const) {
      if (values.has(marker) && values.get(marker) !== "") {
        reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
      }
    }
    const states = Number(values.has("branch")) + Number(values.has("detached")) + Number(values.has("bare"));
    if (states !== 1) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
    if (values.has("bare")) {
      if (values.has("HEAD")) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
    } else {
      const head = values.get("HEAD");
      if (head === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
        reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
      }
    }
    const branch = values.get("branch");
    if (branch !== undefined) {
      const prefix = "refs/heads/";
      if (!branch.startsWith(prefix)) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
      const name = branch.slice(prefix.length);
      try {
        if (canonicalBranchRef(name) !== branch) {
          reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
        }
      } catch {
        reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to parse complete worktree ownership");
      }
      if (branch === targetBranchRef) targetCheckedOut = true;
    }
  }
  return targetCheckedOut;
}

export async function prepareSwitchAttach(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: SwitchAttachRequest,
  signal?: AbortSignal,
): Promise<PreparedSwitchAttach> {
  assertWellFormedGitText(input.branch, "Branch name");
  if (input.expectedBranch !== null) reject("INVALID_INPUT", "Branch attachment requires a null expected branch");
  if (input.branch === "HEAD" || input.branch.startsWith("refs/")) {
    reject("INVALID_INPUT", "Target must be a local branch name, not a ref expression");
  }
  let branchRef: string;
  try { branchRef = canonicalBranchRef(input.branch); }
  catch { return reject("INVALID_INPUT", "Target local branch name is invalid"); }
  const checked = await run(runner, snapshot.root, ["check-ref-format", "--branch", input.branch], signal);
  if (!completed(checked) || checked.exitCode !== 0) reject("INVALID_INPUT", "Target local branch name is invalid");

  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before, "branch attachment");
  assertSwitchCreateReady(before, null, input.expectedHead);
  await sessions.assertNoActiveSession(before.repositoryId);
  if (!before.indexMatchesHead) reject("INDEX_NOT_EMPTY", "Branch attachment requires an empty index");

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore, "branch attachment");
  assertSwitchCreateReady(finalBefore, null, input.expectedHead);
  if (finalBefore.indexTree !== before.indexTree || finalBefore.headTree !== before.headTree) {
    reject("INDEX_NOT_EMPTY", "Repository index changed before branch attachment");
  }
  const status = await readStatus(runner, finalBefore, signal);
  if (status.entries.length !== 0) reject("UNSUPPORTED_REPOSITORY_STATE", "Branch attachment requires a clean worktree");

  const targetHead = await readLocalBranchHead(runner, finalBefore, branchRef, signal);
  if (targetHead !== input.expectedBranchHead) {
    reject("HEAD_MISMATCH", "Target local branch HEAD does not match the expected branch HEAD");
  }
  if (targetHead !== finalBefore.head) {
    reject("HEAD_MISMATCH", "Target local branch HEAD does not match the detached worktree HEAD");
  }
  await assertBranchNotCheckedOut(runner, finalBefore, branchRef, signal);

  const prepared = Object.freeze({ branch: input.branch });
  preparedAttachments.set(prepared, { snapshot: finalBefore, branch: input.branch, branchRef, targetHead });
  return prepared;
}

export function preparedSwitchAttachObservation(prepared: PreparedSwitchAttach): SwitchAttachPreflightObservation {
  const state = preparedAttachments.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared branch attachment authority is invalid or already consumed");
  return Object.freeze({
    branch: null,
    head: state.snapshot.head,
    index_tree: state.snapshot.indexTree,
    target_branch: state.branch,
    target_head: state.targetHead,
  });
}

export async function executePreparedSwitchAttach(
  runner: GitRunner,
  prepared: PreparedSwitchAttach,
  signal?: AbortSignal,
): Promise<SwitchAttachData> {
  const state = preparedAttachments.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared branch attachment authority is invalid or already consumed");
  preparedAttachments.delete(prepared);
  const { snapshot: finalBefore, branch, branchRef, targetHead } = state;

  let switched: GitCommandResult | undefined;
  try { switched = await run(runner, finalBefore.root, ["switch", "--no-guess", branch], signal); }
  catch { switched = undefined; }

  return withReconciliationDeadline(async () => {
    const after = await inspectRepository(runner, finalBefore.root);
    assertIdentity(finalBefore, after, "branch attachment");
    if (after.branch !== branch || after.branchRef !== branchRef || after.head !== targetHead
      || after.head !== finalBefore.head || after.operationState !== "none"
      || !after.indexMatchesHead || after.indexTree !== finalBefore.indexTree) {
      throw new Error(!completed(switched) || switched?.exitCode !== 0
        ? "Git branch attachment did not complete successfully"
        : "Git branch attachment produced an unexpected repository state");
    }
    const afterStatus = await readStatus(runner, after);
    if (afterStatus.entries.length !== 0) throw new Error("Git branch attachment did not preserve a clean worktree");
    return { branch: after.branch, head: after.head };
  });
}

export async function switchAttach(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: SwitchAttachRequest,
  signal?: AbortSignal,
): Promise<SwitchAttachData> {
  const prepared = await prepareSwitchAttach(runner, sessions, snapshot, input, signal);
  return executePreparedSwitchAttach(runner, prepared, signal);
}
