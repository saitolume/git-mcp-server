import { createHash } from "node:crypto";
import { remainingDeadlineTimeoutMs, throwIfDeadlineExceeded, withReconciliationDeadline } from "../deadline.js";
import { assertWellFormedGitText, isWellFormedGitText } from "../domain/git-text.js";
import { BridgeRejection, HOOK_FAILED_MESSAGE, type BridgeResult, type CommitRangeValidateData, type RewordData } from "../domain/result.js";
import { ProvenMutationOutcome } from "../app/mutation-coordinator.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import type { SessionStore } from "../state/session-store.js";
import { createHookWrappers, withNativeCommitMessageFile } from "./hook-wrapper.js";
import { assertBranchNotCheckedOut } from "./branch.js";
import { assertMutationReady, canonicalBranchRef, inspectRepository, validateFullRef, type RepositorySnapshot } from "./repository.js";
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
  readonly tree: string;
  readonly parent: string;
  readonly author: CommitIdentity;
  readonly committer: CommitIdentity;
}

interface CommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly date: string;
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

function parseIdentity(value: string): CommitIdentity {
  const match = /^([^<>\n]+) <([^<>\n]+)> ([0-9]+ [+-][0-9]{4})$/.exec(value);
  if (match === null || match[1]!.endsWith(" ")) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit contains unsupported identity metadata");
  return Object.freeze({ name: match[1]!, email: match[2]!, date: match[3]! });
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
  let author: CommitIdentity | undefined;
  let committer: CommitIdentity | undefined;
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
    if (name === "author") author = parseIdentity(value);
    if (name === "committer") committer = parseIdentity(value);
  }
  if (tree === undefined || author === undefined || committer === undefined || parent !== expectedParent) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Commit parent does not match the exact requested range");
  }
  return Object.freeze({ commit, message, tree, parent, author, committer });
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

function refFingerprint(lines: readonly string[], signal?: AbortSignal): string {
  const hash = createHash("sha256").update("git-mcp-server:refs:v1\0");
  for (let index = 0; index < lines.length; index += 1) {
    if (index % 256 === 0) throwIfDeadlineExceeded(signal);
    hash.update(lines[index]!).update("\0");
  }
  throwIfDeadlineExceeded(signal);
  return hash.digest("hex");
}

async function readRefFingerprint(runner: GitRunner, root: string, width: number, signal?: AbortSignal): Promise<string> {
  return refFingerprint(await readRefLines(runner, root, width, signal), signal);
}

export function parseRefLines(output: string, width: number, signal?: AbortSignal): readonly string[] {
  if (width !== 40 && width !== 64) throw new Error("Repository object ID width is invalid");
  if (!isWellFormedGitText(output) || (output.length > 0 && !output.endsWith("\n"))) throw new Error("Git returned malformed refs");
  throwIfDeadlineExceeded(signal);
  const records = output.split("\n");
  throwIfDeadlineExceeded(signal);
  const lines: string[] = [];
  const names = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    if (index % 256 === 0) throwIfDeadlineExceeded(signal);
    const line = records[index]!;
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > 16 * 1024) throw new Error("Git returned malformed refs");
    const separator = line.indexOf(" ");
    if (separator < 0 || line.indexOf(" ", separator + 1) >= 0) throw new Error("Git returned malformed refs");
    const objectId = line.slice(0, separator);
    const ref = line.slice(separator + 1);
    if (!OBJECT_ID.test(objectId) || objectId.length !== width) throw new Error("Git returned a ref with an invalid object ID width");
    if (ref !== "HEAD") {
      try { validateFullRef(ref); }
      catch { throw new Error("Git returned a malformed ref name"); }
    }
    if (names.has(ref)) throw new Error("Git returned duplicate refs");
    names.add(ref);
    lines.push(line);
  }
  throwIfDeadlineExceeded(signal);
  return Object.freeze(lines);
}

async function readRefLines(runner: GitRunner, root: string, width: number, signal?: AbortSignal): Promise<readonly string[]> {
  const result = await runner.run({
    cwd: root, args: ["show-ref", "--head"],
    timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: REF_OUTPUT_LIMIT,
  }, signal);
  if (!complete(result) || !isWellFormedGitText(result.stdout)) throw new Error("Unable to prove repository refs");
  return parseRefLines(result.stdout, width, signal);
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
    if (worktreeSnapshotId !== state.worktreeSnapshotId
      || await readRefFingerprint(runner, after.root, state.snapshot.head.length) !== state.refsFingerprint) {
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
    || await readRefFingerprint(runner, current.root, state.snapshot.head.length, signal) !== state.refsFingerprint) {
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
  hookWrappersFactory: typeof createHookWrappers = createHookWrappers,
): Promise<void> {
  for (const message of messages) {
    assertWellFormedGitText(message, "Commit message");
    let wrappers: Awaited<ReturnType<typeof createHookWrappers>> | undefined;
    let result: GitCommandResult | undefined;
    let executionError: unknown;
    let cleanupError: unknown;
    try {
      wrappers = await hookWrappersFactory(hooksPath);
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
    // Never inherit an operation deadline or caller cancellation here. This is
    // the mandatory post-hook proof and must receive its own bounded budget.
    if (afterEach !== undefined) await withReconciliationDeadline(async () => afterEach());
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
  const refsFingerprint = await readRefFingerprint(runner, before.root, before.head.length, signal);

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(finalBefore.repositoryId);
  if (finalBefore.indexTree !== before.indexTree || finalBefore.headTree !== before.headTree) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository changed while preparing commit range validation");
  }
  if (await cleanStatus(runner, finalBefore, signal) !== worktreeSnapshotId
    || await readRefFingerprint(runner, finalBefore.root, finalBefore.head.length, signal) !== refsFingerprint) {
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

export interface RewordRequest {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly base: string;
  readonly commits: readonly { readonly commit: string; readonly message: string }[];
  readonly destination: { readonly mode: "current_branch" }
    | { readonly mode: "new_branch"; readonly branch: string };
}

export interface PreparedReword {
  readonly base: string;
  readonly oldHead: string;
  readonly commitCount: number;
}

export interface RewordExecutionOutcome {
  readonly data: RewordData;
  readonly warnings: readonly string[];
  readonly observation: Readonly<Record<string, unknown>>;
}

interface PreparedRewordState extends PreparedState {
  readonly replacements: readonly string[];
  readonly destination: RewordRequest["destination"];
  readonly destinationRef: string;
  readonly refLines: readonly string[];
}

const preparedRewords = new WeakMap<PreparedReword, PreparedRewordState>();

function sameCommits(left: readonly LinearCommit[], right: readonly LinearCommit[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && entry.commit === other.commit && entry.message === other.message
      && entry.tree === other.tree && entry.parent === other.parent
      && entry.author.name === other.author.name && entry.author.email === other.author.email && entry.author.date === other.author.date
      && entry.committer.name === other.committer.name && entry.committer.email === other.committer.email
      && entry.committer.date === other.committer.date;
  });
}

async function assertNewBranchAbsent(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  branch: string,
  branchRef: string,
  signal?: AbortSignal,
): Promise<void> {
  const checked = await runRead(runner, snapshot.root, ["check-ref-format", "--branch", branch], signal);
  if (!ordinaryFailure(checked) && !complete(checked)) reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to validate the destination branch");
  if (!complete(checked) || checked.stdout !== branch + "\n") reject("INVALID_INPUT", "Destination branch name is invalid");
  const existing = await runRead(runner, snapshot.root, ["show-ref", "--verify", "--quiet", branchRef], signal);
  if (complete(existing)) reject("INVALID_INPUT", "Destination local branch already exists");
  if (!ordinaryFailure(existing) || existing.exitCode !== 1 || existing.stdout !== "" || existing.stderr !== "") {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Unable to prove the destination branch is absent");
  }
  await assertBranchNotCheckedOut(runner, snapshot, branchRef, signal);
}

/** Performs every rejection-capable reword check before native hooks or object creation. */
export async function prepareReword(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: RewordRequest,
  signal?: AbortSignal,
): Promise<PreparedReword> {
  const base = exactObjectId(input.base, "Base");
  exactObjectId(input.expectedHead, "Expected head", base.length);
  if (input.commits.length === 0 || input.commits.length > RANGE_LIMIT) reject("INVALID_INPUT", "Reword requires 1 through 128 commits");
  const replacements = input.commits.map((entry) => {
    exactObjectId(entry.commit, "Reword commit", base.length);
    assertWellFormedGitText(entry.message, "Commit message");
    if (entry.message.length === 0 || entry.message.length > 100_000) reject("INVALID_INPUT", "Commit message length is invalid");
    return entry.message;
  });

  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(before.repositoryId);
  const worktreeSnapshotId = await cleanStatus(runner, before, signal);
  const commits = await inspectLinearCommitRange(runner, before.root, base, before.head, signal);
  if (commits.length !== input.commits.length || commits.some((entry, index) => entry.commit !== input.commits[index]?.commit)) {
    reject("INVALID_INPUT", "Reword commits must exactly cover the ordered linear range");
  }
  const hooksPath = await readHooksPath(runner, before.root, signal);
  const refLines = await readRefLines(runner, before.root, before.head.length, signal);
  const refsFingerprint = refFingerprint(refLines, signal);
  let destinationRef = before.branchRef!;
  if (input.destination.mode === "new_branch") {
    try { destinationRef = canonicalBranchRef(input.destination.branch); }
    catch { reject("INVALID_INPUT", "Destination branch name is invalid"); }
    await assertNewBranchAbsent(runner, before, input.destination.branch, destinationRef, signal);
  }

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(finalBefore.repositoryId);
  if (finalBefore.indexTree !== before.indexTree || finalBefore.headTree !== before.headTree
    || await cleanStatus(runner, finalBefore, signal) !== worktreeSnapshotId
    || await readRefFingerprint(runner, finalBefore.root, finalBefore.head.length, signal) !== refsFingerprint) {
    reject("UNSUPPORTED_REPOSITORY_STATE", "Repository changed while preparing reword");
  }
  const finalCommits = await inspectLinearCommitRange(runner, finalBefore.root, base, finalBefore.head, signal);
  if (!sameCommits(commits, finalCommits)) reject("UNSUPPORTED_REPOSITORY_STATE", "Commit range changed while preparing reword");
  if (input.destination.mode === "new_branch") {
    await assertBranchNotCheckedOut(runner, finalBefore, destinationRef, signal);
  }

  const prepared = Object.freeze({ base, oldHead: finalBefore.head, commitCount: commits.length });
  preparedRewords.set(prepared, {
    snapshot: Object.freeze({ ...finalBefore }), sessions, base, commits, hooksPath, refsFingerprint,
    worktreeSnapshotId, replacements: Object.freeze(replacements), destination: Object.freeze({ ...input.destination }),
    destinationRef, refLines,
  });
  return prepared;
}

export function preparedRewordObservation(prepared: PreparedReword): Readonly<Record<string, unknown>> {
  const state = preparedRewords.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared reword authority is invalid or already consumed");
  return Object.freeze({
    branch: state.snapshot.branch!, head: state.snapshot.head, base: state.base,
    commit_count: state.commits.length, index_tree: state.snapshot.indexTree,
    destination: state.destination,
  });
}

function rewordProven<T>(result: BridgeResult<T>): never {
  throw new ProvenMutationOutcome<T>(result);
}

export function sameRefLines(actual: readonly string[], expected: readonly string[], signal?: AbortSignal): boolean {
  throwIfDeadlineExceeded(signal);
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set<string>();
  for (let index = 0; index < expected.length; index += 1) {
    if (index % 256 === 0) throwIfDeadlineExceeded(signal);
    const line = expected[index]!;
    if (expectedSet.has(line)) return false;
    expectedSet.add(line);
  }
  const actualSet = new Set<string>();
  for (let index = 0; index < actual.length; index += 1) {
    if (index % 256 === 0) throwIfDeadlineExceeded(signal);
    const line = actual[index]!;
    if (actualSet.has(line) || !expectedSet.has(line)) return false;
    actualSet.add(line);
  }
  throwIfDeadlineExceeded(signal);
  return true;
}

function expectedRewordRefLines(state: PreparedRewordState, newHead: string, signal?: AbortSignal): readonly string[] {
  const sourceRef = state.snapshot.branchRef!;
  const expected = state.refLines.map((line, index) => {
    if (index % 256 === 0) throwIfDeadlineExceeded(signal);
    if (line === `${state.snapshot.head} HEAD`) return `${newHead} HEAD`;
    if (state.destination.mode === "current_branch" && line === `${state.snapshot.head} ${sourceRef}`) return `${newHead} ${sourceRef}`;
    return line;
  });
  if (state.destination.mode === "new_branch") expected.push(`${newHead} ${state.destinationRef}`);
  return Object.freeze(expected);
}

async function recreateCommits(
  runner: GitRunner,
  state: PreparedRewordState,
  signal?: AbortSignal,
): Promise<string> {
  let parent = state.base;
  for (let index = 0; index < state.commits.length; index += 1) {
    const source = state.commits[index]!;
    const result = await runner.run({
      cwd: state.snapshot.root,
      args: ["-c", "commit.gpgSign=false", "commit-tree", source.tree, "-p", parent],
      stdin: state.replacements[index]!,
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.commit),
      maxOutputBytes: READ_OUTPUT_LIMIT,
      commitIdentity: {
        authorName: source.author.name, authorEmail: source.author.email, authorDate: source.author.date,
        committerName: source.committer.name, committerEmail: source.committer.email, committerDate: source.committer.date,
      },
    }, signal);
    if (!complete(result) || !result.stdout.endsWith("\n")) throw new Error("Git did not recreate the commit object");
    const commit = emittedObjectId(result.stdout.slice(0, -1), "Recreated commit", state.snapshot.head.length);
    const object = await runRead(runner, state.snapshot.root, ["--no-replace-objects", "cat-file", "commit", commit], signal);
    if (!complete(object)) throw new Error("Unable to inspect a recreated commit");
    const parsed = parseCommitObject(commit, object.stdout, parent, state.snapshot.head.length);
    if (parsed.tree !== source.tree || parsed.parent !== parent || parsed.message !== state.replacements[index]
      || parsed.author.name !== source.author.name || parsed.author.email !== source.author.email || parsed.author.date !== source.author.date
      || parsed.committer.name !== source.committer.name || parsed.committer.email !== source.committer.email
      || parsed.committer.date !== source.committer.date) {
      throw new Error("Recreated commit metadata did not match the source commit");
    }
    parent = commit;
  }
  return parent;
}

async function proveRewordStillPrepared(
  runner: GitRunner,
  state: PreparedRewordState,
  signal?: AbortSignal,
): Promise<void> {
  await proveStillPrepared(runner, state, signal);
  if (state.destination.mode === "new_branch") {
    await assertBranchNotCheckedOut(runner, state.snapshot, state.destinationRef, signal);
  }
}

async function proveRewordUnchanged(runner: GitRunner, state: PreparedRewordState): Promise<void> {
  try {
    await proveUnchanged(runner, state);
    if (state.destination.mode === "new_branch") {
      await assertBranchNotCheckedOut(runner, state.snapshot, state.destinationRef);
    }
  } catch {
    throw new HookStateChanged();
  }
}

async function proveRewordSuccess(
  runner: GitRunner,
  state: PreparedRewordState,
  newHead: string,
  signal?: AbortSignal,
): Promise<RewordExecutionOutcome | null> {
  const after = await inspectRepository(runner, state.snapshot.root, signal);
  assertIdentity(state.snapshot, after);
  const destinationBranch = state.destination.mode === "current_branch" ? state.snapshot.branch! : state.destination.branch;
  if (after.branch !== destinationBranch || after.branchRef !== state.destinationRef || after.head !== newHead
    || after.operationState !== "none" || !after.indexMatchesHead || after.indexTree !== state.snapshot.indexTree
    || after.headTree !== state.snapshot.headTree) return null;
  await cleanStatus(runner, after, signal);
  if (!sameRefLines(
    await readRefLines(runner, after.root, after.head.length, signal),
    expectedRewordRefLines(state, newHead, signal),
    signal,
  )) return null;
  const commits = await inspectLinearCommitRange(runner, after.root, state.base, newHead, signal);
  if (commits.length !== state.commits.length || commits.some((entry, index) => {
    const source = state.commits[index]!;
    return entry.tree !== source.tree || entry.parent !== (index === 0 ? state.base : commits[index - 1]!.commit)
      || entry.author.name !== source.author.name || entry.author.email !== source.author.email || entry.author.date !== source.author.date
      || entry.committer.name !== source.committer.name || entry.committer.email !== source.committer.email
      || entry.committer.date !== source.committer.date || entry.message !== state.replacements[index];
  })) return null;
  const data: RewordData = {
    base: state.base, old_head: state.snapshot.head, head: newHead, commit_count: commits.length,
    destination: state.destination.mode === "current_branch"
      ? { mode: "current_branch", branch: state.snapshot.branch! }
      : { mode: "new_branch", branch: state.destination.branch, source_branch: state.snapshot.branch! },
    trees_unchanged: true, hook: "commit-msg", signing: "disabled_by_policy",
  };
  return {
    data, warnings: Object.freeze([]),
    observation: Object.freeze({ branch: after.branch, head: after.head, index_tree: after.indexTree, base: state.base }),
  };
}

/** Recreates and pairwise proves every commit before exact CAS ref movement. */
export async function executePreparedReword(
  runner: GitRunner,
  prepared: PreparedReword,
  signal?: AbortSignal,
): Promise<RewordExecutionOutcome> {
  const state = preparedRewords.get(prepared);
  if (state === undefined) reject("INVALID_INPUT", "Prepared reword authority is invalid or already consumed");
  preparedRewords.delete(prepared);
  let newHead: string | undefined;
  let mutationCommand: GitCommandResult | undefined;
  let executionError: unknown;
  try {
    await proveRewordStillPrepared(runner, state, signal);
    await validateMessagesWithNativeHook(
      runner, state.snapshot.root, state.hooksPath, state.replacements, signal,
      async () => proveRewordUnchanged(runner, state),
    );
    await proveRewordStillPrepared(runner, state, signal);
    newHead = await recreateCommits(runner, state, signal);
    await proveRewordStillPrepared(runner, state, signal);
    const oldValue = state.destination.mode === "current_branch" ? state.snapshot.head : "0".repeat(state.snapshot.head.length);
    mutationCommand = await runner.run({
      cwd: state.snapshot.root,
      args: ["update-ref", state.destinationRef, newHead, oldValue],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.commit), maxOutputBytes: READ_OUTPUT_LIMIT,
    }, signal);
    if (state.destination.mode === "new_branch" && complete(mutationCommand)) {
      mutationCommand = await runner.run({
        cwd: state.snapshot.root, args: ["switch", "--no-guess", state.destination.branch],
        timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.commit), maxOutputBytes: READ_OUTPUT_LIMIT,
      }, signal);
    }
  } catch (error) { executionError = error; /* Reconciliation below is authoritative after any hook or Git attempt. */ }

  return withReconciliationDeadline(async (reconciliationSignal) => {
    if (newHead !== undefined) {
      try {
        const succeeded = await proveRewordSuccess(runner, state, newHead, reconciliationSignal);
        if (succeeded !== null) {
          if (mutationCommand === undefined || !complete(mutationCommand)) {
            return { ...succeeded, warnings: Object.freeze(["Git completion diagnostics were incomplete after reword success was proven"]) };
          }
          return succeeded;
        }
      } catch { /* Fall through to exact unchanged-state proof. */ }
    }
    try {
      const after = await inspectRepository(runner, state.snapshot.root, reconciliationSignal);
      assertIdentity(state.snapshot, after);
      if (after.branch === state.snapshot.branch && after.branchRef === state.snapshot.branchRef && after.head === state.snapshot.head
        && after.indexTree === state.snapshot.indexTree && after.headTree === state.snapshot.headTree && after.indexMatchesHead
        && after.operationState === "none" && await cleanStatus(runner, after, reconciliationSignal) === state.worktreeSnapshotId
        && sameRefLines(
          await readRefLines(runner, after.root, after.head.length, reconciliationSignal),
          state.refLines,
          reconciliationSignal,
        )) {
        if (executionError instanceof BridgeRejection && executionError.error.code === "HOOK_FAILED") {
          rewordProven<RewordData>({ status: "failed", operation: "git_reword", warnings: [], error: executionError.error });
        }
        rewordProven<RewordData>({
          status: "failed", operation: "git_reword", warnings: [],
          error: { code: mutationCommand?.timedOut ? "GIT_TIMEOUT" : "GIT_FAILED", message: "Reword did not move a repository ref" },
        });
      }
    } catch (error) {
      if (error instanceof ProvenMutationOutcome) throw error;
    }
    rewordProven<RewordData>({
      status: "indeterminate", operation: "git_reword", warnings: [],
      error: { code: "OPERATION_INDETERMINATE", message: "The reword started but its final repository state could not be confirmed" },
    });
  });
}
