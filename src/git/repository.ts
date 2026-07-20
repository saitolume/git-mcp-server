import { access, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { remainingDeadlineTimeoutMs, throwIfDeadlineExceeded } from "../deadline.js";
import { BridgeRejection } from "../domain/result.js";
import { assertWellFormedGitText, isWellFormedGitText } from "../domain/git-text.js";
import { RETURNED_PATH_SET_MAX_BYTES, RETURNED_PATH_SET_MAX_COUNT } from "../limits.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import type { GitCommandResult } from "./runner.js";
import { GitRunner } from "./runner.js";
import { COMPLETE_RECORD_MAX_BYTES, DelimitedRecordParser, STREAM_STDERR_MAX_BYTES } from "./streaming.js";

export type GitOperationState = "none" | "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface RepositoryIdentity {
  readonly repositoryId: string;
  readonly root: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
}

export interface RepositorySnapshot extends RepositoryIdentity {
  readonly branch: string | null;
  readonly branchRef: string | null;
  readonly head: string;
  readonly headTree: string;
  /** Opaque domain-separated SHA-256 of the complete canonical index stage map. */
  readonly indexTree: string;
  readonly indexMatchesHead: boolean;
  readonly operationState: GitOperationState;
}

const READ_OUTPUT_LIMIT = 32_768;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

function invalidRefText(value: string): boolean {
  return /[\x00-\x20\x7f~^:?*\\]/u.test(value) || value.includes("[") || !isWellFormedGitText(value);
}

/** Validates a branch suffix without invoking Git and returns its canonical full ref. */
export function canonicalBranchRef(branch: string): string {
  const ref = `refs/heads/${branch}`;
  const parts = ref.split("/");
  if (branch.length === 0 || ref.length > 1024 || branch.startsWith("-") || ref === "@" || ref.endsWith(".")
    || ref.includes("..") || ref.includes("@{") || invalidRefText(ref)
    || parts.length < 3 || parts.some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new Error("Git branch ref is invalid");
  }
  return ref;
}

function branchFromCanonicalRef(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) throw new Error("Git symbolic HEAD is not a canonical local branch ref");
  const branch = ref.slice(prefix.length);
  if (canonicalBranchRef(branch) !== ref) throw new Error("Git symbolic HEAD is not a canonical local branch ref");
  return branch;
}

async function gitResult(
  runner: GitRunner,
  repository: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  return runner.run({
    cwd: repository,
    args,
    timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxOutputBytes: READ_OUTPUT_LIMIT,
  }, signal);
}

function commandFailure(args: readonly string[], result: GitCommandResult): Error {
  return new Error(`Git command failed: git ${args.join(" ")} (exit ${result.exitCode ?? "signal"})`);
}

function outputFailure(args: readonly string[]): Error {
  return new Error(`malformed Git output: git ${args.join(" ")}`);
}

function requireSingleLine(args: readonly string[], result: GitCommandResult): string {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.aborted) {
    throw commandFailure(args, result);
  }
  if (result.stdoutTruncated || result.stderrTruncated || result.stderr !== "") throw outputFailure(args);

  const line = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!line || line.includes("\n") || line.includes("\r")) throw outputFailure(args);
  return line;
}

async function gitLine(
  runner: GitRunner,
  repository: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return requireSingleLine(args, await gitResult(runner, repository, args, signal));
}

export interface IndexStageRecord {
  readonly mode: "100644" | "100755" | "120000" | "160000";
  readonly objectId: string;
  readonly stage: "0" | "1" | "2" | "3";
  readonly path: string;
}

export interface IndexStageMap {
  readonly fingerprint: string;
  /** Canonical mode/OID/path hash for stage-zero entries, comparable with a commit tree proof. */
  readonly stageZeroTreeFingerprint: string;
  readonly hasUnmergedEntries: boolean;
  /** Only caller-selected paths; the complete index is never retained. */
  readonly capturedEntries: ReadonlyMap<string, readonly IndexStageRecord[]>;
  /** Canonical complete stage-map hash with caller-selected paths omitted. */
  readonly uncapturedFingerprint: string;
}

function updateIndexHash(hash: ReturnType<typeof createHash>, entry: IndexStageRecord): void {
  hash.update(entry.mode).update("\0").update(entry.objectId).update("\0")
    .update(entry.stage).update("\0").update(entry.path).update("\0");
}

function updateTreeHash(
  hash: ReturnType<typeof createHash>,
  entry: Pick<IndexStageRecord, "mode" | "objectId" | "path">,
): void {
  hash.update(entry.mode).update("\0").update(entry.objectId).update("\0").update(entry.path).update("\0");
}

/** Complete, non-writing index proof that streams the full map and retains only selected paths. */
export async function readIndexStageMap(
  runner: GitRunner,
  repository: string,
  signal?: AbortSignal,
  capturePaths: ReadonlySet<string> = new Set(),
  captureGitlinks = false,
): Promise<IndexStageMap> {
  const args = ["ls-files", "--stage", "-z"];
  const indexHash = createHash("sha256").update("git-mcp-server:index-stage-map:v2\0");
  const treeHash = createHash("sha256").update("git-mcp-server:stage-zero-tree:v1\0");
  const uncapturedHash = createHash("sha256").update("git-mcp-server:index-stage-map:v2\0");
  const captured = new Map<string, IndexStageRecord[]>();
  let capturedPathBytes = 0;
  let previousPath: Buffer | undefined;
  let previousStage = -1;
  let stagesForPath = 0;
  let hasUnmergedEntries = false;
  const malformed = (): never => { throw outputFailure(args); };
  const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git index stage map", (record) => {
    throwIfDeadlineExceeded(signal);
    const tab = record.indexOf("\t");
    const header = /^(100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(record.slice(0, tab));
    const path = record.slice(tab + 1);
    if (tab <= 0 || path.length === 0 || header === null || !isWellFormedGitText(path)) malformed();
    const [, mode, objectId, stage] = header as unknown as [string, IndexStageRecord["mode"], string, IndexStageRecord["stage"]];
    const pathBytes = Buffer.from(path);
    const numericStage = Number(stage);
    const comparison = previousPath === undefined ? -1 : Buffer.compare(previousPath, pathBytes);
    if (previousPath !== undefined && comparison > 0) malformed();
    if (previousPath === undefined || comparison < 0) {
      previousPath = pathBytes;
      previousStage = -1;
      stagesForPath = 0;
    }
    if (numericStage <= previousStage || (stage === "0" ? stagesForPath !== 0 : (stagesForPath & 1) !== 0)) malformed();
    previousStage = numericStage;
    stagesForPath |= 1 << numericStage;
    const entry: IndexStageRecord = { mode, objectId, stage, path };
    const shouldCapture = capturePaths.has(path) || (captureGitlinks && mode === "160000");
    updateIndexHash(indexHash, entry);
    if (!shouldCapture) updateIndexHash(uncapturedHash, entry);
    if (stage === "0") updateTreeHash(treeHash, entry);
    else hasUnmergedEntries = true;
    if (shouldCapture) {
      const entries = captured.get(path) ?? [];
      if (entries.length === 0) {
        const nextBytes = capturedPathBytes + Buffer.byteLength(path, "utf8");
        if (captured.size + 1 > RETURNED_PATH_SET_MAX_COUNT || nextBytes > RETURNED_PATH_SET_MAX_BYTES) {
          throw new BridgeRejection({
            code: "UNSUPPORTED_REPOSITORY_STATE",
            message: "Selected index path proof exceeds its explicit subset limit",
          });
        }
        capturedPathBytes = nextBytes;
      }
      entries.push(entry);
      captured.set(path, entries);
    }
  });
  let result: GitCommandResult;
  try {
    throwIfDeadlineExceeded(signal);
    result = await runner.runStreaming({
      cwd: repository, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
      maxStderrBytes: STREAM_STDERR_MAX_BYTES,
    }, (chunk) => parser.write(chunk), signal);
  } catch (error) {
    if (error instanceof BridgeRejection) throw error;
    return malformed();
  }
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.aborted) throw commandFailure(args, result);
  if (result.stdoutTruncated || result.stderrTruncated || result.stderr !== "") malformed();
  try { parser.finish(); } catch { malformed(); }
  return {
    fingerprint: indexHash.digest("hex"),
    stageZeroTreeFingerprint: treeHash.digest("hex"),
    hasUnmergedEntries,
    capturedEntries: new Map([...captured].map(([path, entries]) => [path, Object.freeze(entries)])),
    uncapturedFingerprint: uncapturedHash.digest("hex"),
  };
}

function indexMatchesHead(result: GitCommandResult): boolean {
  const args = ["diff-index", "--cached", "--quiet", "--no-ext-diff", "HEAD", "--"];
  if ((result.exitCode !== 0 && result.exitCode !== 1) || result.signal !== null || result.timedOut || result.aborted) {
    throw commandFailure(args, result);
  }
  if (result.stdoutTruncated || result.stderrTruncated || result.stdout !== "" || result.stderr !== "") throw outputFailure(args);
  return result.exitCode === 0;
}

async function readIndexState(
  runner: GitRunner,
  repository: string,
  signal?: AbortSignal,
): Promise<{ readonly fingerprint: string; readonly matchesHead: boolean }> {
  const [stageMap, headComparison] = await Promise.all([
    readIndexStageMap(runner, repository, signal),
    gitResult(runner, repository, ["diff-index", "--cached", "--quiet", "--no-ext-diff", "HEAD", "--"], signal),
  ]);
  return {
    fingerprint: stageMap.fingerprint,
    matchesHead: indexMatchesHead(headComparison),
  };
}

async function canonicalGitPath(
  runner: GitRunner,
  repository: string,
  argument: "--show-toplevel" | "--git-dir" | "--git-common-dir",
  signal?: AbortSignal,
): Promise<string> {
  const args = argument === "--show-toplevel"
    ? ["rev-parse", argument]
    : ["rev-parse", "--path-format=absolute", argument];
  const emitted = assertWellFormedGitText(await gitLine(runner, repository, args, signal), "Git path output");
  return assertWellFormedGitText(await realpath(emitted), "Canonical Git path");
}

/** Minimal canonical identity read used to select the common-gitdir lock. */
export async function resolveRepositoryIdentity(
  runner: GitRunner,
  repository: string,
  signal?: AbortSignal,
): Promise<RepositoryIdentity> {
  assertWellFormedGitText(repository, "Repository path");
  const canonicalRepository = assertWellFormedGitText(await realpath(repository), "Canonical repository path");
  const [root, gitDir, commonGitDir] = await Promise.all([
    canonicalGitPath(runner, canonicalRepository, "--show-toplevel", signal),
    canonicalGitPath(runner, canonicalRepository, "--git-dir", signal),
    canonicalGitPath(runner, canonicalRepository, "--git-common-dir", signal),
  ]);
  return {
    root,
    gitDir,
    commonGitDir,
    repositoryId: createHash("sha256").update(commonGitDir).digest("hex"),
  };
}

async function symbolicBranch(
  runner: GitRunner,
  repository: string,
  signal?: AbortSignal,
): Promise<{ readonly branch: string | null; readonly branchRef: string | null }> {
  const args = ["symbolic-ref", "--quiet", "HEAD"];
  const result = await gitResult(runner, repository, args, signal);
  if (result.exitCode === 1 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated && result.stdout === "" && result.stderr === "") {
    return { branch: null, branchRef: null };
  }
  const branchRef = requireSingleLine(args, result);
  return { branch: branchFromCanonicalRef(branchRef), branchRef };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function inspectOperationState(gitDir: string): Promise<GitOperationState> {
  if (await exists(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (await exists(join(gitDir, "rebase-merge")) || await exists(join(gitDir, "rebase-apply"))) return "rebase";
  if (await exists(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (await exists(join(gitDir, "REVERT_HEAD"))) return "revert";
  if (await exists(join(gitDir, "BISECT_LOG"))) return "bisect";
  return "none";
}

/** Full repeatable snapshot; callers take the common-gitdir lock before relying on it. */
export async function inspectRepository(
  runner: GitRunner,
  repository: string,
  signal?: AbortSignal,
): Promise<RepositorySnapshot> {
  const identity = await resolveRepositoryIdentity(runner, repository, signal);
  const [symbolic, head, headTree, indexState, operationState] = await Promise.all([
    symbolicBranch(runner, identity.root, signal),
    gitLine(runner, identity.root, ["rev-parse", "--verify", "HEAD"], signal),
    gitLine(runner, identity.root, ["rev-parse", "--verify", "HEAD^{tree}"], signal),
    readIndexState(runner, identity.root, signal),
    inspectOperationState(identity.gitDir),
  ]);
  if (!OBJECT_ID.test(head) || !OBJECT_ID.test(headTree) || !/^[0-9a-f]{64}$/.test(indexState.fingerprint)) {
    throw new Error("malformed Git object ID output");
  }
  return {
    ...identity, ...symbolic, head, headTree, indexTree: indexState.fingerprint,
    indexMatchesHead: indexState.matchesHead, operationState,
  };
}

export function assertMutationReady(
  snapshot: RepositorySnapshot,
  expectedBranch: string,
  expectedHead: string,
): void {
  const observation = {
    branch: snapshot.branch,
    head: snapshot.head,
    operationState: snapshot.operationState,
  };
  if (snapshot.branch === null || snapshot.operationState !== "none") {
    throw new BridgeRejection({
      code: "UNSUPPORTED_REPOSITORY_STATE",
      message: "Repository is detached or has an unsupported Git operation in progress",
      details: observation,
    });
  }
  if (snapshot.branch !== expectedBranch) {
    throw new BridgeRejection({
      code: "BRANCH_MISMATCH",
      message: "Repository branch does not match the expected branch",
      details: { ...observation, expectedBranch, observedBranch: snapshot.branch },
    });
  }
  if (snapshot.head !== expectedHead) {
    throw new BridgeRejection({
      code: "HEAD_MISMATCH",
      message: "Repository HEAD does not match the expected HEAD",
      details: { ...observation, expectedHead, observedHead: snapshot.head },
    });
  }
}
