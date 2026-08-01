import { createHash } from "node:crypto";
import { remainingDeadlineTimeoutMs } from "../deadline.js";
import { assertWellFormedGitText, isWellFormedGitText } from "../domain/git-text.js";
import { BridgeRejection, HOOK_FAILED_MESSAGE, type CommitRangeValidateData } from "../domain/result.js";
import { ProvenMutationOutcome } from "../app/mutation-coordinator.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import type { SessionStore } from "../state/session-store.js";
import { createHookWrappers, withNativeCommitMessageFile } from "./hook-wrapper.js";
import { assertMutationReady, inspectRepository, type RepositorySnapshot } from "./repository.js";
import { readStatus } from "./read.js";
import type { GitCommandResult, GitRunner } from "./runner.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RANGE_LIMIT = 128;
const READ_OUTPUT_LIMIT = 128_000;
const REF_OUTPUT_LIMIT = 8 * 1024 * 1024;

export interface CommitRangeValidationRequest {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly base: string;
}

export interface LinearCommit {
  readonly commit: string;
  readonly message: string;
}

export interface PreparedCommitRangeValidation {
  readonly base: string;
  readonly head: string;
  readonly commitCount: number;
}

export interface CommitRangeValidationObservation extends Readonly<Record<string, unknown>> {
  readonly branch: string;
  readonly head: string;
  readonly base: string;
  readonly commit_count: number;
  readonly index_tree: string;
}

interface PreparedState {
  readonly snapshot: RepositorySnapshot;
  readonly sessions: SessionStore;
  readonly base: string;
  readonly commits: readonly LinearCommit[];
  readonly hooksPath: string;
  readonly refsFingerprint: string;
  readonly worktreeSnapshotId: string;
}

const preparedStates = new WeakMap<PreparedCommitRangeValidation, PreparedState>();

function reject(code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_NOT_EMPTY", message: string): never {
  throw new BridgeRejection({ code, message });
}

function complete(result: GitCommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated && result.stderr === "";
}

function ordinaryFailure(result: GitCommandResult): boolean {
  return result.exitCode !== 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated;
}

function assertIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed during commit range validation");
  }
}

function exactObjectId(value: string, label: string): string {
  if (!OBJECT_ID.test(value)) reject("INVALID_INPUT", `${label} must be a full Git object ID`);
  return value;
}

async function runRead(runner: GitRunner, root: string, args: readonly string[], signal?: AbortSignal): Promise<GitCommandResult> {
  return runner.run({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: READ_OUTPUT_LIMIT,
  }, signal);
}

function parseRangeLines(output: string, base: string): readonly string[] {
  if (output.length === 0 || !output.endsWith("\n") || !isWellFormedGitText(output)) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned a malformed commit range");
  }
  const commits: string[] = [];
  let previous = base;
  for (const record of output.slice(0, -1).split("\n")) {
    if (Buffer.byteLength(record, "utf8") > 16 * 1024 || !/^[0-9a-f]{40,64} [0-9a-f]{40,64}$/.test(record)) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned a non-linear commit range");
    }
    const [commit, parent] = record.split(" ") as [string, string];
    if (commit === undefined || parent === undefined || parent !== previous || commits.length >= RANGE_LIMIT) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range is not a bounded exact linear sequence");
    }
    commits.push(commit);
    previous = commit;
  }
  return commits;
}

function parseCommitObject(commit: string, object: string, expectedParent: string): LinearCommit {
  if (!isWellFormedGitText(object) || object.includes("\0")) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Commit message is not well-formed UTF-8");
  }
  const separator = object.indexOf("\n\n");
  if (separator < 0) reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned a malformed commit object");
  const headers = object.slice(0, separator).split("\n");
  const message = object.slice(separator + 2);
  const seen = new Set<string>();
  let parent: string | undefined;
  for (const header of headers) {
    const space = header.indexOf(" ");
    const name = space > 0 ? header.slice(0, space) : "";
    const value = space > 0 ? header.slice(space + 1) : "";
    if (["gpgsig", "gpgsig-sha256", "mergetag"].includes(name) || !["tree", "parent", "author", "committer"].includes(name)
      || seen.has(name) || value.length === 0 || header.startsWith(" ")) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Commit contains unsupported metadata");
    }
    seen.add(name);
    if (name === "parent") parent = value;
  }
  if (!seen.has("tree") || !seen.has("parent") || !seen.has("author") || !seen.has("committer") || parent !== expectedParent) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Commit parent does not match the exact requested range");
  }
  return { commit, message };
}

/** Inspects only literal object IDs and returns the ordered messages of a bounded linear range. */
export async function inspectLinearCommitRange(
  runner: GitRunner,
  root: string,
  baseValue: string,
  headValue: string,
  signal?: AbortSignal,
): Promise<readonly LinearCommit[]> {
  const base = exactObjectId(baseValue, "Base");
  const head = exactObjectId(headValue, "Head");
  const ancestor = await runRead(runner, root, ["--no-replace-objects", "merge-base", "--is-ancestor", base, head], signal);
  if (!complete(ancestor) || ancestor.stdout !== "") reject("INVALID_INPUT", "Base is not an ancestor of the expected HEAD");
  const listed = await runRead(runner, root, ["--no-replace-objects", "rev-list", "--reverse", "--parents", `${base}..${head}`], signal);
  if (!complete(listed)) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to inspect the complete commit range");
  const commits = parseRangeLines(listed.stdout, base);
  if (commits.length === 0) reject("INVALID_INPUT", "Commit range must contain at least one commit");
  if (commits.at(-1) !== head) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range does not end at the expected HEAD");
  const values: LinearCommit[] = [];
  let parent = base;
  for (const commit of commits) {
    const object = await runRead(runner, root, ["--no-replace-objects", "cat-file", "commit", commit], signal);
    if (!complete(object)) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to inspect a commit in the requested range");
    values.push(parseCommitObject(commit, object.stdout, parent));
    parent = commit;
  }
  return Object.freeze(values);
}

async function readHooksPath(runner: GitRunner, root: string, signal?: AbortSignal): Promise<string> {
  const result = await runRead(runner, root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], signal);
  if (!complete(result) || !result.stdout.endsWith("\n")) throw new Error("Unable to resolve native hooks");
  const path = result.stdout.slice(0, -1);
  if (path.includes("\n") || path.includes("\r") || path.length === 0 || !isWellFormedGitText(path)) {
    throw new Error("Git returned a malformed hooks path");
  }
  return path;
}

async function readRefFingerprint(runner: GitRunner, root: string, signal?: AbortSignal): Promise<string> {
  const result = await runner.run({
    cwd: root, args: ["show-ref", "--head", "--dereference"],
    timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: REF_OUTPUT_LIMIT,
  }, signal);
  if (!complete(result) || !isWellFormedGitText(result.stdout)) throw new Error("Unable to prove repository refs");
  const hash = createHash("sha256").update("git-mcp-server:refs:v1\0");
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > 16 * 1024 || !/^[0-9a-f]{40,64} (?:HEAD|refs\/[A-Za-z0-9._/{}@+-]+(?:\^\{\})?)$/.test(line)) {
      throw new Error("Git returned malformed refs");
    }
    hash.update(Buffer.from(line)).update("\0");
  }
  return hash.digest("hex");
}

async function cleanStatus(runner: GitRunner, snapshot: RepositorySnapshot, signal?: AbortSignal): Promise<string> {
  if (!snapshot.indexMatchesHead) reject("INDEX_NOT_EMPTY", "Commit range validation requires an empty index");
  const status = await readStatus(runner, snapshot, signal);
  if (status.entries.length !== 0) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range validation requires a clean worktree");
  return status.worktree_snapshot_id;
}

async function proveUnchanged(runner: GitRunner, state: PreparedState): Promise<void> {
  const after = await inspectRepository(runner, state.snapshot.root);
  assertIdentity(state.snapshot, after);
  assertMutationReady(after, state.snapshot.branch!, state.snapshot.head);
  if (after.indexTree !== state.snapshot.indexTree || after.headTree !== state.snapshot.headTree || !after.indexMatchesHead) {
    throw new Error("Native hook changed the repository index or commit state");
  }
  const worktreeSnapshotId = await cleanStatus(runner, after);
  if (worktreeSnapshotId !== state.worktreeSnapshotId || await readRefFingerprint(runner, after.root) !== state.refsFingerprint) {
    throw new Error("Native hook changed the repository worktree or refs");
  }
}

/** Re-proves every authority bound in preflight immediately before any hook process starts. */
async function proveStillPrepared(runner: GitRunner, state: PreparedState, signal?: AbortSignal): Promise<void> {
  const current = await inspectRepository(runner, state.snapshot.root, signal);
  assertIdentity(state.snapshot, current);
  assertMutationReady(current, state.snapshot.branch!, state.snapshot.head);
  await state.sessions.assertNoActiveSession(current.repositoryId);
  if (current.indexTree !== state.snapshot.indexTree || current.headTree !== state.snapshot.headTree) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository changed before native commit-msg validation");
  }
  if (await cleanStatus(runner, current, signal) !== state.worktreeSnapshotId
    || await readRefFingerprint(runner, current.root, signal) !== state.refsFingerprint) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository refs or worktree changed before native commit-msg validation");
  }
  const commits = await inspectLinearCommitRange(runner, current.root, state.base, current.head, signal);
  if (commits.length !== state.commits.length || commits.some((entry, index) =>
    entry.commit !== state.commits[index]?.commit || entry.message !== state.commits[index]?.message)) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range changed before native commit-msg validation");
  }
}

/** Runs the configured native `commit-msg` hook for every supplied message without exposing its diagnostics. */
export async function validateMessagesWithNativeHook(
  runner: GitRunner,
  root: string,
  hooksPath: string,
  messages: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  for (const message of messages) {
    assertWellFormedGitText(message, "Commit message");
    let wrappers: Awaited<ReturnType<typeof createHookWrappers>> | undefined;
    let result: GitCommandResult | undefined;
    try {
      wrappers = await createHookWrappers(hooksPath);
      const activeWrappers = wrappers;
      result = await withNativeCommitMessageFile(message, async (path) => runner.run({
        cwd: root, args: ["hook", "run", "--ignore-missing", "commit-msg", "--", path],
        timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.commit), maxOutputBytes: READ_OUTPUT_LIMIT,
        hookExecution: { wrappersDirectory: activeWrappers.directory, failureConsumer: activeWrappers.failureConsumer },
      }, signal));
    } finally {
      try { await wrappers?.cleanup(); } catch { /* Private wrapper cleanup does not affect hook proof. */ }
    }
    if (result !== undefined && ordinaryFailure(result) && wrappers?.rejectedHook() === "commit-msg") {
      throw new BridgeRejection({ code: "HOOK_FAILED", message: HOOK_FAILED_MESSAGE, details: { hook: "commit-msg" } });
    }
    if (result === undefined || !complete(result)) throw new Error("Native commit-msg hook did not complete successfully");
  }
}

/** Performs all rejection-capable checks before the mutation coordinator executes native hooks. */
export async function prepareCommitRangeValidation(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: CommitRangeValidationRequest,
  signal?: AbortSignal,
): Promise<PreparedCommitRangeValidation> {
  const base = exactObjectId(input.base, "Base");
  exactObjectId(input.expectedHead, "Expected head");
  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(before.repositoryId);
  const worktreeSnapshotId = await cleanStatus(runner, before, signal);
  const commits = await inspectLinearCommitRange(runner, before.root, base, before.head, signal);
  const hooksPath = await readHooksPath(runner, before.root, signal);
  const refsFingerprint = await readRefFingerprint(runner, before.root, signal);

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(finalBefore.repositoryId);
  if (finalBefore.indexTree !== before.indexTree || finalBefore.headTree !== before.headTree) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository changed while preparing commit range validation");
  }
  if (await cleanStatus(runner, finalBefore, signal) !== worktreeSnapshotId
    || await readRefFingerprint(runner, finalBefore.root, signal) !== refsFingerprint) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository refs or worktree changed while preparing commit range validation");
  }
  const finalCommits = await inspectLinearCommitRange(runner, finalBefore.root, base, finalBefore.head, signal);
  if (finalCommits.length !== commits.length || finalCommits.some((entry, index) => entry.commit !== commits[index]?.commit || entry.message !== commits[index]?.message)) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range changed while preparing validation");
  }
  const prepared = Object.freeze({ base, head: finalBefore.head, commitCount: commits.length });
  preparedStates.set(prepared, { snapshot: Object.freeze({ ...finalBefore }), sessions, base, commits, hooksPath, refsFingerprint, worktreeSnapshotId });
  return prepared;
}

export function preparedCommitRangeValidationObservation(prepared: PreparedCommitRangeValidation): CommitRangeValidationObservation {
  const state = preparedStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared commit range validation authority is invalid or already consumed");
  return Object.freeze({
    branch: state.snapshot.branch!, head: state.snapshot.head, base: state.base,
    commit_count: state.commits.length, index_tree: state.snapshot.indexTree,
  });
}

export async function executePreparedCommitRangeValidation(
  runner: GitRunner,
  prepared: PreparedCommitRangeValidation,
  signal?: AbortSignal,
): Promise<CommitRangeValidateData> {
  const state = preparedStates.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared commit range validation authority is invalid or already consumed");
  preparedStates.delete(prepared);
  try {
    await proveStillPrepared(runner, state, signal);
    await validateMessagesWithNativeHook(runner, state.snapshot.root, state.hooksPath, state.commits.map(({ message }) => message), signal);
  } catch (error) {
    if (error instanceof BridgeRejection && error.error.code === "HOOK_FAILED") {
      throw new ProvenMutationOutcome<CommitRangeValidateData>({ status: "failed", operation: "git_commit_range_validate", warnings: [], error: error.error });
    }
    throw new ProvenMutationOutcome<CommitRangeValidateData>({
      status: "failed", operation: "git_commit_range_validate", warnings: [],
      error: { code: "GIT_FAILED", message: "Native commit-msg validation did not preserve the repository" },
    });
  }
  try { await proveUnchanged(runner, state); }
  catch {
    throw new ProvenMutationOutcome<CommitRangeValidateData>({
      status: "failed", operation: "git_commit_range_validate", warnings: [],
      error: { code: "GIT_FAILED", message: "Native commit-msg hook changed the repository" },
    });
  }
  return { base: state.base, head: state.snapshot.head, commit_count: state.commits.length, hook: "commit-msg" };
}
