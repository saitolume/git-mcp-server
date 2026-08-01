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
  return result.exitCode !== 0 && result.signal === null && !result.timedOut && !result.aborted;
}

function hookSucceeded(result: GitCommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted;
}

function assertIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed during commit range validation");
  }
}

function exactObjectId(value: string, label: string, width?: number): string {
  if (!OBJECT_ID.test(value) || (width !== undefined && value.length !== width)) {
    reject("INVALID_INPUT", `${label} must be a full Git object ID`);
  }
  return value;
}

function emittedObjectId(value: string, label: string, width: number): string {
  if (!OBJECT_ID.test(value) || value.length !== width) {
    reject("UNSUPPORTED_REPOSITORY_STATE", `${label} is not a valid repository object ID`);
  }
  return value;
}

async function runRead(runner: GitRunner, root: string, args: readonly string[], signal?: AbortSignal): Promise<GitCommandResult> {
  return runner.run({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: READ_OUTPUT_LIMIT,
  }, signal);
}

class NulRangeParser {
  private buffered = Buffer.alloc(0);
  private readonly commits: string[] = [];
  private previous: string;
  private pendingCommit: string | undefined;

  constructor(private readonly base: string, private readonly width: number) {
    this.previous = base;
  }

  write(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
    while (true) {
      const end = this.buffered.indexOf(0);
      if (end < 0) {
        if (this.buffered.length > 16 * 1024) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range record exceeds its limit");
        return;
      }
      if (end > 16 * 1024) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range record exceeds its limit");
      const record = this.buffered.subarray(0, end);
      this.buffered = this.buffered.subarray(end + 1);
      this.consume(record);
    }
  }

  finish(): readonly string[] {
    if (this.pendingCommit !== undefined || !this.buffered.equals(Buffer.from("\n")) || this.commits.length === 0) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned a malformed NUL-framed commit range");
    }
    return Object.freeze([...this.commits]);
  }

  private consume(raw: Buffer): void {
    let bytes = raw;
    if (this.pendingCommit === undefined && this.commits.length > 0) {
      if (bytes[0] !== 10) reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned a malformed NUL-framed commit range");
      bytes = bytes.subarray(1);
    }
    const value = bytes.toString("utf8");
    if (!isWellFormedGitText(value) || !Buffer.from(value, "utf8").equals(bytes) || !OBJECT_ID.test(value) || value.length !== this.width) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned an invalid commit range object ID");
    }
    if (this.pendingCommit === undefined) {
      if (this.commits.length >= RANGE_LIMIT) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range exceeds its maximum count");
      this.pendingCommit = value;
      return;
    }
    if (value !== this.previous) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range is not an exact linear sequence");
    this.commits.push(this.pendingCommit);
    this.previous = this.pendingCommit;
    this.pendingCommit = undefined;
  }
}

async function readNulLinearRange(
  runner: GitRunner,
  root: string,
  base: string,
  head: string,
  width: number,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const parser = new NulRangeParser(base, width);
  let result: GitCommandResult;
  try {
    result = await runner.runStreaming({
      cwd: root,
      args: ["--no-replace-objects", "rev-list", "--reverse", "--pretty=tformat:%H%x00%P%x00", "--no-commit-header", `${base}..${head}`],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxStderrBytes: READ_OUTPUT_LIMIT,
    }, (chunk) => parser.write(chunk), signal);
  } catch { reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to inspect the complete commit range"); }
  if (!complete(result)) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to inspect the complete commit range");
  const commits = parser.finish();
  if (commits.at(-1) !== head) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range does not end at the expected HEAD");
  return commits;
}

function parseCommitObject(commit: string, object: string, expectedParent: string, width: number): LinearCommit {
  if (!isWellFormedGitText(object) || object.includes("\0")) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Commit message is not well-formed UTF-8");
  }
  const separator = object.indexOf("\n\n");
  if (separator < 0) reject("UNSUPPORTED_REPOSITORY_STATE", "Git returned a malformed commit object");
  const headers = object.slice(0, separator).split("\n");
  const message = object.slice(separator + 2);
  const seen = new Set<string>();
  let parent: string | undefined;
  let tree: string | undefined;
  for (const header of headers) {
    const space = header.indexOf(" ");
    const name = space > 0 ? header.slice(0, space) : "";
    const value = space > 0 ? header.slice(space + 1) : "";
    if (["gpgsig", "gpgsig-sha256", "mergetag"].includes(name) || !["tree", "parent", "author", "committer"].includes(name)
      || seen.has(name) || value.length === 0 || header.startsWith(" ")) {
      reject("UNSUPPORTED_REPOSITORY_STATE", "Commit contains unsupported metadata");
    }
    seen.add(name);
    if (name === "parent") parent = emittedObjectId(value, "Commit parent", width);
    if (name === "tree") tree = emittedObjectId(value, "Commit tree", width);
  }
  if (!seen.has("tree") || tree === undefined || !seen.has("parent") || !seen.has("author") || !seen.has("committer") || parent !== expectedParent) {
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
  const head = exactObjectId(headValue, "Head", base.length);
  const ancestor = await runRead(runner, root, ["--no-replace-objects", "merge-base", "--is-ancestor", base, head], signal);
  if (!complete(ancestor) || ancestor.stdout !== "") reject("INVALID_INPUT", "Base is not an ancestor of the expected HEAD");
  const commits = await readNulLinearRange(runner, root, base, head, base.length, signal);
  const values: LinearCommit[] = [];
  let parent = base;
  for (const commit of commits) {
    const object = await runRead(runner, root, ["--no-replace-objects", "cat-file", "commit", commit], signal);
    if (!complete(object)) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to inspect a commit in the requested range");
    values.push(parseCommitObject(commit, object.stdout, parent, base.length));
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

class HookStateChanged extends Error {
  constructor() {
    super("Native hook changed repository state");
    this.name = "HookStateChanged";
  }
}

async function proveUnchanged(runner: GitRunner, state: PreparedState): Promise<void> {
  try {
    const after = await inspectRepository(runner, state.snapshot.root);
    assertIdentity(state.snapshot, after);
    assertMutationReady(after, state.snapshot.branch!, state.snapshot.head);
    await state.sessions.assertNoActiveSession(after.repositoryId);
    if (after.indexTree !== state.snapshot.indexTree || after.headTree !== state.snapshot.headTree || !after.indexMatchesHead) {
      throw new HookStateChanged();
    }
    const worktreeSnapshotId = await cleanStatus(runner, after);
    if (worktreeSnapshotId !== state.worktreeSnapshotId || await readRefFingerprint(runner, after.root) !== state.refsFingerprint) {
      throw new HookStateChanged();
    }
    const commits = await inspectLinearCommitRange(runner, after.root, state.base, after.head);
    if (commits.length !== state.commits.length || commits.some((entry, index) =>
      entry.commit !== state.commits[index]?.commit || entry.message !== state.commits[index]?.message)) {
      throw new HookStateChanged();
    }
  } catch {
    // Post-hook proof has no safe recovery path: any failed comparison or read
    // prevents a success result and wins over a private hook outcome.
    throw new HookStateChanged();
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
  afterEach?: () => Promise<void>,
): Promise<void> {
  for (const message of messages) {
    assertWellFormedGitText(message, "Commit message");
    let wrappers: Awaited<ReturnType<typeof createHookWrappers>> | undefined;
    let result: GitCommandResult | undefined;
    let executionError: unknown;
    let cleanupError: unknown;
    try {
      wrappers = await createHookWrappers(hooksPath);
      const activeWrappers = wrappers;
      result = await withNativeCommitMessageFile(message, async (path) => runner.run({
        cwd: root, args: ["hook", "run", "--ignore-missing", "commit-msg", "--", path],
        timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.commit), maxOutputBytes: 0,
        hookExecution: { wrappersDirectory: activeWrappers.directory, failureConsumer: activeWrappers.failureConsumer },
      }, signal));
    } catch (error) {
      executionError = error;
    }
    try { await wrappers?.cleanup(); }
    catch (error) { cleanupError = error; }
    // This callback is deliberately run even after reject/timeout/abort/wrapper failures.
    // A state change is stronger evidence than the hook's private diagnostic outcome.
    await afterEach?.();
    if (executionError !== undefined || cleanupError !== undefined) {
      throw executionError ?? cleanupError;
    }
    if (result !== undefined && ordinaryFailure(result) && wrappers?.rejectedHook() === "commit-msg") {
      throw new BridgeRejection({ code: "HOOK_FAILED", message: HOOK_FAILED_MESSAGE, details: { hook: "commit-msg" } });
    }
    if (result === undefined || !hookSucceeded(result)) throw new Error("Native commit-msg hook did not complete successfully");
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
    await validateMessagesWithNativeHook(
      runner, state.snapshot.root, state.hooksPath, state.commits.map(({ message }) => message), signal,
      async () => proveUnchanged(runner, state),
    );
  } catch (error) {
    if (error instanceof BridgeRejection && error.error.code === "HOOK_FAILED") {
      throw new ProvenMutationOutcome<CommitRangeValidateData>({ status: "failed", operation: "git_commit_range_validate", warnings: [], error: error.error });
    }
    throw new ProvenMutationOutcome<CommitRangeValidateData>({
      status: "failed", operation: "git_commit_range_validate", warnings: [],
      error: { code: "GIT_FAILED", message: error instanceof HookStateChanged
        ? "Native commit-msg hook changed the repository"
        : "Native commit-msg validation did not preserve the repository" },
    });
  }
  return { base: state.base, head: state.snapshot.head, commit_count: state.commits.length, hook: "commit-msg" };
}
