import type { GitSwitchCreateInput } from "../domain/inputs.js";
import { remainingDeadlineTimeoutMs, withReconciliationDeadline } from "../deadline.js";
import { BridgeRejection, type SwitchCreateData } from "../domain/result.js";
import { assertWellFormedGitText } from "../domain/git-text.js";
import type { SessionStore } from "../state/session-store.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import { assertMutationReady, inspectRepository, type RepositorySnapshot } from "./repository.js";
import { readStatus } from "./read.js";
import type { GitCommandResult, GitRunner } from "./runner.js";

type SwitchCreateRequest = Pick<GitSwitchCreateInput, "branch"> & {
  readonly expectedBranch: string;
  readonly expectedHead: string;
};

export interface PreparedSwitchCreate {
  readonly branch: string;
}

export interface SwitchCreatePreflightObservation extends Readonly<Record<string, unknown>> {
  readonly branch: string;
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

function reject(code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_NOT_EMPTY", message: string): never {
  throw new BridgeRejection({ code, message });
}

function assertIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed before branch creation");
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
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(before.repositoryId);
  if (!before.indexMatchesHead) reject("INDEX_NOT_EMPTY", "Branch creation requires an empty index");

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
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
    branch: state.snapshot.branch!,
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
