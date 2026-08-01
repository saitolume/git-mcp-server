import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { remainingDeadlineTimeoutMs, throwIfDeadlineExceeded } from "../deadline.js";
import { gitOutputPath } from "../domain/inputs.js";
import { assertWellFormedGitText } from "../domain/git-text.js";
import { BridgeRejection } from "../domain/result.js";
import type { DiffData, StatusData, StatusEntry } from "../domain/result.js";
import { RETURNED_PATH_SET_MAX_BYTES, RETURNED_PATH_SET_MAX_COUNT } from "../limits.js";
import type { RepositorySnapshot } from "./repository.js";
import { readIndexStageMap } from "./repository.js";
import { assertTrackedPathConfined, validatePaths } from "./path-policy.js";
import { literalPathChunks } from "./pathspec.js";
import { GitRunner, type GitCommandResult } from "./runner.js";
import { COMPLETE_RECORD_MAX_BYTES, DelimitedRecordParser, STREAM_STDERR_MAX_BYTES, utf8Bytes } from "./streaming.js";

const READ_TIMEOUT_MS = 30_000;
const DEFAULT_DIFF_MAX_BYTES = 1_000_000;
const WORKTREE_HASH_MAX_BYTES = 256 * 1024 * 1024;
const WORKTREE_HASH_CHUNK_BYTES = 64 * 1024;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const PORCELAIN_MODE = /^(?:000000|100644|100755|120000|160000)$/;
const SUBMODULE = /^(?:N\.\.\.|S[.C][.M][.U])$/;
const ORDINARY_XY = new Set([".M", ".T", ".D", "M.", "MM", "MT", "MD", "T.", "TM", "TT", "TD", "A.", "AM", "AT", "AD", "D.", "R.", "RM", "RT", "RD", "C.", "CM", "CT", "CD"]);
const RENAMED_XY = new Set(["R.", "RM", "RT", "RD", "C.", "CM", "CT", "CD"]);
const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface ReadDiffInput {
  readonly mode: "worktree" | "staged";
  readonly paths?: readonly string[];
  readonly maxBytes?: number;
}

interface ParsedStatusEntry {
  readonly path: string;
  readonly index: string;
  readonly worktree: string;
  readonly submodule: string;
  readonly kind: "ordinary" | "renamed" | "unmerged" | "untracked";
  readonly sourcePath?: string;
}

interface TrackedIndexEntry {
  readonly mode: string;
  readonly object: string;
  readonly stage: string;
}

export class WorktreeHashBudget {
  private remainingBytes: number;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("Worktree hash byte budget must be a non-negative safe integer");
    }
    this.remainingBytes = maximumBytes;
  }

  reserve(size: bigint): void {
    if (size < 0n || size > BigInt(this.remainingBytes)) {
      throw new Error("Worktree content exceeds the aggregate hash byte budget");
    }
    this.remainingBytes -= Number(size);
  }
}

export function createWorktreeHashBudget(maximumBytes = WORKTREE_HASH_MAX_BYTES): WorktreeHashBudget {
  return new WorktreeHashBudget(maximumBytes);
}

export interface WorktreeHashReadOptions {
  /** Internal deterministic observation seam; production callers leave this unset. */
  readonly onReadChunk?: (bytesRead: number) => void | Promise<void>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectGitRead(args: readonly string[], result: GitCommandResult): never {
  if (result.timedOut) throw new Error(`Git command timed out: git ${args.join(" ")}`);
  if (result.aborted) throw new Error(`Git command was aborted: git ${args.join(" ")}`);
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`Git command output was truncated: git ${args.join(" ")}`);
  throw new Error(`Git command failed: git ${args.join(" ")} (exit ${result.exitCode ?? "signal"})`);
}

function requireCompleteResult(args: readonly string[], result: GitCommandResult): void {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.aborted
    || result.stdoutTruncated || result.stderrTruncated || result.stderr !== "") rejectGitRead(args, result);
}

function malformedStatus(message: string): never {
  throw new Error(`malformed Git status output: ${message}`);
}

function statusPath(path: string | undefined, kind: string): string {
  if (!path || !gitOutputPath.safeParse(path).success) malformedStatus(`${kind} path`);
  return path;
}

function parseStatusRecord(record: string): ParsedStatusEntry {
  const ordinary = /^1 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/s.exec(record);
  if (ordinary) {
    const [, xy, submodule, modeHead, modeIndex, modeWorktree, head, index, path] = ordinary;
    if (!xy || !submodule || !modeHead || !modeIndex || !modeWorktree || !head || !index
      || !ORDINARY_XY.has(xy) || !SUBMODULE.test(submodule) || !PORCELAIN_MODE.test(modeHead) || !PORCELAIN_MODE.test(modeIndex)
      || !PORCELAIN_MODE.test(modeWorktree) || !OBJECT_ID.test(head) || !OBJECT_ID.test(index)) malformedStatus("ordinary record");
    return { path: statusPath(path, "ordinary"), index: xy[0]!, worktree: xy[1]!, submodule, kind: "ordinary" };
  }
  const renamed = /^2 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/s.exec(record);
  if (renamed) {
    const [, xy, submodule, modeHead, modeIndex, modeWorktree, head, index, score, path] = renamed;
    const scoreNumber = score?.slice(1);
    if (!xy || !submodule || !modeHead || !modeIndex || !modeWorktree || !head || !index || !score || !scoreNumber
      || !RENAMED_XY.has(xy) || !SUBMODULE.test(submodule) || !PORCELAIN_MODE.test(modeHead) || !PORCELAIN_MODE.test(modeIndex)
      || !PORCELAIN_MODE.test(modeWorktree) || !OBJECT_ID.test(head) || !OBJECT_ID.test(index) || !/^[RC]\d{1,3}$/.test(score)
      || score[0] !== xy[0] || Number(scoreNumber) > 100) malformedStatus("rename record");
    return { path: statusPath(path, "rename"), index: xy[0]!, worktree: xy[1]!, submodule, kind: "renamed" };
  }
  const unmerged = /^u ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/s.exec(record);
  if (unmerged) {
    const [, xy, submodule, mode1, mode2, mode3, modeWorktree, head1, head2, head3, path] = unmerged;
    if (!xy || !submodule || !mode1 || !mode2 || !mode3 || !modeWorktree || !head1 || !head2 || !head3
      || !UNMERGED_XY.has(xy) || !SUBMODULE.test(submodule) || !PORCELAIN_MODE.test(mode1) || !PORCELAIN_MODE.test(mode2)
      || !PORCELAIN_MODE.test(mode3) || !PORCELAIN_MODE.test(modeWorktree) || !OBJECT_ID.test(head1) || !OBJECT_ID.test(head2)
      || !OBJECT_ID.test(head3)) malformedStatus("unmerged record");
    return { path: statusPath(path, "unmerged"), index: xy[0]!, worktree: xy[1]!, submodule, kind: "unmerged" };
  }
  if (record.startsWith("? ")) {
    const path = record.slice(2);
    if (path.endsWith("/")) {
      throw new BridgeRejection({
        code: "UNSUPPORTED_REPOSITORY_STATE",
        message: "Git-visible untracked directory records cannot be content-proven",
        details: { path },
      });
    }
    return { path: statusPath(path, "untracked"), index: "?", worktree: "?", submodule: "N...", kind: "untracked" };
  }
  malformedStatus("unknown record");
}

function parseStatusHeader(record: string, headers: Map<string, string>): void {
  const header = record.slice(2);
  const separator = header.indexOf(" ");
  const key = separator > 0 ? header.slice(0, separator) : "";
  const value = separator > 0 ? header.slice(separator + 1) : "";
  if (!key || !value || headers.has(key)) malformedStatus("invalid branch header");
  if (key === "branch.oid" && !OBJECT_ID.test(value)) malformedStatus("branch.oid header");
  if (key === "branch.head" && value.includes(" ")) malformedStatus("branch.head header");
  if (key === "branch.upstream" && value.length === 0) malformedStatus("branch.upstream header");
  if (key === "branch.ab" && !/^\+[0-9]+ -[0-9]+$/.test(value)) malformedStatus("branch.ab header");
  if (["branch.oid", "branch.head", "branch.upstream", "branch.ab"].includes(key)) headers.set(key, value);
}

async function readStatusEntries(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  signal?: AbortSignal,
): Promise<readonly ParsedStatusEntry[]> {
  const headers = new Map<string, string>();
  const entries: ParsedStatusEntry[] = [];
  let resultBytes = 0;
  let sawEntry = false;
  let pendingRename: ParsedStatusEntry | undefined;
  const accountEntry = (entry: ParsedStatusEntry, bytes: number): void => {
    const nextBytes = resultBytes + bytes;
    if (entries.length + 1 > RETURNED_PATH_SET_MAX_COUNT || nextBytes > RETURNED_PATH_SET_MAX_BYTES) {
      throw new BridgeRejection({
        code: "UNSUPPORTED_REPOSITORY_STATE",
        message: "Status result exceeds its explicit returned-set limit",
      });
    }
    entries.push(entry);
    resultBytes = nextBytes;
  };
  const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git status", (record) => {
    throwIfDeadlineExceeded(signal);
    if (record.includes("�")) malformedStatus("invalid UTF-8 record");
    if (pendingRename !== undefined) {
      const sourcePath = statusPath(record, "rename source");
      accountEntry({ ...pendingRename, sourcePath }, utf8Bytes(pendingRename.path) + utf8Bytes(sourcePath));
      pendingRename = undefined;
      return;
    }
    if (record.startsWith("# ")) {
      if (sawEntry) malformedStatus("branch header after path record");
      parseStatusHeader(record, headers);
      return;
    }
    if (record.length === 0) malformedStatus("empty record");
    sawEntry = true;
    const parsed = parseStatusRecord(record);
    if (parsed.kind === "renamed") {
      pendingRename = parsed;
      return;
    }
    accountEntry(parsed, utf8Bytes(parsed.path));
  });
  const args = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"];
  const result = await runner.runStreaming({
    cwd: snapshot.root, args, timeoutMs: remainingDeadlineTimeoutMs(READ_TIMEOUT_MS),
    maxStderrBytes: STREAM_STDERR_MAX_BYTES,
  }, (chunk) => parser.write(chunk), signal);
  requireCompleteResult(args, result);
  try { parser.finish(); } catch { malformedStatus("missing NUL terminator"); }
  if (pendingRename !== undefined) malformedStatus("missing rename source path");
  const expectedBranch = snapshot.branch ?? "(detached)";
  if (headers.get("branch.oid") !== snapshot.head || headers.get("branch.head") !== expectedBranch) {
    throw new Error("incoherent Git status branch headers");
  }
  return entries.sort((left, right) => compareText(left.path, right.path)
    || compareText(left.kind, right.kind) || compareText(left.index, right.index) || compareText(left.worktree, right.worktree));
}

async function trackedIndexEntries(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  paths: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, readonly TrackedIndexEntry[]>> {
  const proof = await readIndexStageMap(runner, snapshot.root, signal, paths, true);
  const entries = new Map<string, readonly TrackedIndexEntry[]>();
  for (const [path, stageEntries] of proof.capturedEntries) {
    await assertTrackedPathConfined(snapshot.root, path);
    entries.set(path, stageEntries.map(({ mode, objectId, stage }) => ({ mode, object: objectId, stage })));
  }
  return entries;
}

function sameRegularFileState(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function changedWhileHashing(): Error {
  return new Error("Tracked regular file changed while hashing");
}

export async function hashRegularFileForSnapshot(
  fullPath: string,
  expected: BigIntStats,
  budget: WorktreeHashBudget,
  signal?: AbortSignal,
  options: WorktreeHashReadOptions = {},
): Promise<string> {
  assertWellFormedGitText(fullPath, "Worktree file path");
  throwIfDeadlineExceeded(signal);
  const hash = createHash("sha256");
  let handle;
  try {
    handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw changedWhileHashing();
  }
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    throwIfDeadlineExceeded(signal);
    if (!sameRegularFileState(expected, descriptorBefore)) throw changedWhileHashing();
    budget.reserve(descriptorBefore.size);
    const size = Number(descriptorBefore.size);
    let position = 0;
    while (position < size) {
      throwIfDeadlineExceeded(signal);
      const length = Math.min(WORKTREE_HASH_CHUNK_BYTES, size - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw changedWhileHashing();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      await options.onReadChunk?.(bytesRead);
      throwIfDeadlineExceeded(signal);
    }
    const descriptorAfter = await handle.stat({ bigint: true });
    let pathnameAfter: BigIntStats;
    try { pathnameAfter = await lstat(fullPath, { bigint: true }); }
    catch { throw changedWhileHashing(); }
    throwIfDeadlineExceeded(signal);
    if (!sameRegularFileState(descriptorBefore, descriptorAfter)
      || !sameRegularFileState(descriptorAfter, pathnameAfter)) throw changedWhileHashing();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function gitlinkIdentity(
  runner: GitRunner,
  root: string,
  fullPath: string,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  assertWellFormedGitText(root, "Repository root");
  assertWellFormedGitText(fullPath, "Gitlink path");
  let canonicalRoot: string;
  let canonicalGitlink: string;
  try {
    const [resolvedRoot, resolvedGitlink] = await Promise.all([realpath(root), realpath(fullPath)]);
    canonicalRoot = assertWellFormedGitText(resolvedRoot, "Canonical repository root");
    canonicalGitlink = assertWellFormedGitText(resolvedGitlink, "Canonical gitlink path");
  } catch {
    return { state: "uninitialized" };
  }
  if (canonicalGitlink === canonicalRoot || !canonicalGitlink.startsWith(`${canonicalRoot}/`)) return { state: "broken" };
  const topArgs = ["rev-parse", "--path-format=absolute", "--show-toplevel"];
  const top = await runner.run({
    cwd: canonicalGitlink, args: topArgs, timeoutMs: remainingDeadlineTimeoutMs(READ_TIMEOUT_MS), maxOutputBytes: 8_192,
  }, signal);
  if (!gitlinkCommandSucceeded(topArgs, top)) return { state: "uninitialized" };
  const topPath = gitlinkLine(topArgs, top);
  let canonicalTop: string;
  try {
    canonicalTop = assertWellFormedGitText(
      await realpath(assertWellFormedGitText(topPath, "Git gitlink path output")),
      "Canonical Git gitlink path",
    );
  } catch {
    return { state: "broken" };
  }
  if (canonicalTop !== canonicalGitlink) return { state: "uninitialized" };
  const headArgs = ["rev-parse", "--verify", "HEAD^{commit}"];
  const headResult = await runner.run({
    cwd: canonicalGitlink, args: headArgs, timeoutMs: remainingDeadlineTimeoutMs(READ_TIMEOUT_MS), maxOutputBytes: 8_192,
  }, signal);
  if (!gitlinkCommandSucceeded(headArgs, headResult)) return { state: "broken" };
  const head = gitlinkLine(headArgs, headResult);
  if (!OBJECT_ID.test(head)) return { state: "broken" };
  return { state: "ready", head };
}

function gitlinkCommandSucceeded(args: readonly string[], result: GitCommandResult): boolean {
  if (result.timedOut || result.aborted || result.signal !== null || result.exitCode === null
    || result.stdoutTruncated || result.stderrTruncated || (result.exitCode === 0 && result.stderr !== "")) {
    rejectGitRead(args, result);
  }
  return result.exitCode === 0;
}

function gitlinkLine(args: readonly string[], result: GitCommandResult): string {
  if (!result.stdout.endsWith("\n")) throw new Error(`malformed Git gitlink output: git ${args.join(" ")}`);
  const line = result.stdout.slice(0, -1);
  if (!line || line.includes("\n") || line.includes("\r")) throw new Error(`malformed Git gitlink output: git ${args.join(" ")}`);
  return line;
}

async function fingerprintTrackedPath(
  runner: GitRunner,
  root: string,
  path: string,
  indexEntries: readonly TrackedIndexEntry[],
  signal?: AbortSignal,
  includeNestedGitHead = true,
  hashBudget = createWorktreeHashBudget(),
): Promise<Readonly<Record<string, unknown>>> {
  await assertTrackedPathConfined(root, path);
  const fullPath = join(root, ...path.split("/"));
  const index = indexEntries.map((entry) => [entry.mode, entry.object, entry.stage]);
  try {
    const stats = await lstat(fullPath, { bigint: true });
    const mode = Number(stats.mode);
    const isGitlink = indexEntries.some((entry) => entry.mode === "160000");
    if (!stats.isDirectory() && !stats.isFile() && !stats.isSymbolicLink()) {
      throw new BridgeRejection({
        code: "UNSUPPORTED_REPOSITORY_STATE",
        message: "Tracked special filesystem entries cannot be safely content-proven",
        details: { path },
      });
    }
    if (isGitlink && !includeNestedGitHead) {
      const outerType = stats.isDirectory() ? "directory"
        : stats.isFile() ? "file"
          : stats.isSymbolicLink() ? "symlink"
            : stats.isFIFO() ? "fifo"
              : "other";
      return { path, index, kind: "gitlink", outerType, mode };
    }
    if (stats.isSymbolicLink()) {
      await assertTrackedPathConfined(root, path);
      return { path, index, kind: "symlink", mode, target: await readlink(fullPath) };
    }
    if (isGitlink) {
      await assertTrackedPathConfined(root, path);
      return { path, index, kind: "gitlink", mode, ...await gitlinkIdentity(runner, root, fullPath, signal) };
    }
    if (stats.isDirectory()) {
      throw new BridgeRejection({
        code: "UNSUPPORTED_REPOSITORY_STATE",
        message: "Tracked directory entries must be initialized gitlinks",
        details: { path },
      });
    }
    if (stats.isFile()) {
      await assertTrackedPathConfined(root, path);
      return {
        path, index, kind: "file", mode,
        content: await hashRegularFileForSnapshot(fullPath, stats, hashBudget, signal),
      };
    }
    throw new BridgeRejection({
      code: "UNSUPPORTED_REPOSITORY_STATE",
      message: "Tracked path type cannot be safely content-proven",
      details: { path },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, index, kind: "missing" };
    throw error;
  }
}

async function worktreeSnapshotId(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  entries: readonly ParsedStatusEntry[],
  tracked: ReadonlyMap<string, readonly TrackedIndexEntry[]>,
  signal?: AbortSignal,
  includeNestedGitHead = true,
): Promise<string> {
  const fingerprints = await trackedPathFingerprints(
    runner,
    snapshot,
    tracked,
    signal,
    includeNestedGitHead,
  );
  return worktreeSnapshotIdFromFingerprints(snapshot, entries, fingerprints);
}

async function trackedPathFingerprints(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  tracked: ReadonlyMap<string, readonly TrackedIndexEntry[]>,
  signal?: AbortSignal,
  includeNestedGitHead = true,
  hashBudget = createWorktreeHashBudget(),
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  throwIfDeadlineExceeded(signal);
  const fingerprints = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [path, indexEntries] of [...tracked.entries()].sort(([left], [right]) => compareText(left, right))) {
    throwIfDeadlineExceeded(signal);
    fingerprints.set(path, await fingerprintTrackedPath(
      runner,
      snapshot.root,
      path,
      indexEntries,
      signal,
      includeNestedGitHead,
      hashBudget,
    ));
  }
  throwIfDeadlineExceeded(signal);
  return fingerprints;
}

function samePathState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function untrackedChangedWhileHashing(): Error {
  return new Error("Untracked worktree path changed while hashing");
}

async function fingerprintUntrackedPath(
  snapshot: RepositorySnapshot,
  path: string,
  budget: WorktreeHashBudget,
  signal?: AbortSignal,
  allowMissing = false,
): Promise<Readonly<Record<string, unknown>>> {
  throwIfDeadlineExceeded(signal);
  await assertTrackedPathConfined(snapshot.root, path);
  const fullPath = join(snapshot.root, ...path.split("/"));
  let before: BigIntStats;
  try { before = await lstat(fullPath, { bigint: true }); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, kind: "missing" };
    }
    throw untrackedChangedWhileHashing();
  }
  throwIfDeadlineExceeded(signal);
  const mode = Number(before.mode);
  if (before.isDirectory()) {
    throw new BridgeRejection({
      code: "UNSUPPORTED_REPOSITORY_STATE",
      message: "Untracked directory records cannot be proven without recursive inventory",
      details: { path },
    });
  }
  if (before.isFile()) {
    return {
      path, kind: "untracked-file", mode,
      content: await hashRegularFileForSnapshot(fullPath, before, budget, signal),
    };
  }
  if (before.isSymbolicLink()) {
    let target: Buffer;
    try { target = await readlink(fullPath, { encoding: "buffer" }); } catch { throw untrackedChangedWhileHashing(); }
    budget.reserve(BigInt(target.byteLength));
    let after: BigIntStats;
    try { after = await lstat(fullPath, { bigint: true }); } catch { throw untrackedChangedWhileHashing(); }
    throwIfDeadlineExceeded(signal);
    if (!after.isSymbolicLink() || !samePathState(before, after)) throw untrackedChangedWhileHashing();
    return { path, kind: "untracked-symlink", mode, target: target.toString("base64") };
  }
  const kind = before.isFIFO() ? "fifo"
    : before.isSocket() ? "socket"
      : before.isBlockDevice() ? "block-device"
        : before.isCharacterDevice() ? "character-device" : "other";
  throw new BridgeRejection({
    code: "UNSUPPORTED_REPOSITORY_STATE",
    message: "Untracked special filesystem entries cannot be safely content-proven",
    details: { path, kind },
  });
}

async function untrackedPathFingerprints(
  snapshot: RepositorySnapshot,
  entries: readonly ParsedStatusEntry[],
  excluded: ReadonlySet<string>,
  budget: WorktreeHashBudget,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const fingerprints = new Map<string, Readonly<Record<string, unknown>>>();
  for (const entry of entries) {
    if (entry.kind !== "untracked" || excluded.has(entry.path)) continue;
    throwIfDeadlineExceeded(signal);
    fingerprints.set(entry.path, await fingerprintUntrackedPath(snapshot, entry.path, budget, signal));
  }
  return fingerprints;
}

function worktreeSnapshotIdFromFingerprints(
  snapshot: RepositorySnapshot,
  entries: readonly ParsedStatusEntry[],
  fingerprints: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): string {
  return createHash("sha256").update(JSON.stringify({
    branch: snapshot.branch,
    head: snapshot.head,
    indexTree: snapshot.indexTree,
    operationState: snapshot.operationState,
    entries,
    fingerprints: [...fingerprints.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, fingerprint]) => fingerprint),
  })).digest("hex");
}

function unownedWorktreeContentSnapshotIdFromFingerprints(
  entries: readonly ParsedStatusEntry[],
  fingerprints: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): string {
  return createHash("sha256").update("git-mcp-server:unowned-worktree-content:v1\0").update(JSON.stringify({
    entries,
    fingerprints: [...fingerprints.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, fingerprint]) => fingerprint),
  })).digest("hex");
}

function worktreeContentSnapshotIdFromFingerprints(
  fingerprints: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): string {
  return createHash("sha256").update("git-mcp-server:worktree-content:v1\0").update(JSON.stringify(
    [...fingerprints.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, fingerprint]) => fingerprint),
  )).digest("hex");
}

async function readParsedStatus(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  signal?: AbortSignal,
): Promise<{
  readonly tracked: ReadonlyMap<string, readonly TrackedIndexEntry[]>;
  readonly entries: readonly ParsedStatusEntry[];
}> {
  const entries = await readStatusEntries(runner, snapshot, signal);
  const trackedPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "untracked") continue;
    trackedPaths.add(entry.path);
    if (entry.sourcePath !== undefined) trackedPaths.add(entry.sourcePath);
  }
  const tracked = await trackedIndexEntries(runner, snapshot, trackedPaths, signal);
  return { tracked, entries };
}

/**
 * Push proof for superproject-tracked files. Untracked paths and nested
 * gitlink state are excluded because neither can change the pushed commit.
 */
export async function readPushTrackedWorktreeSnapshotId(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  signal?: AbortSignal,
): Promise<string> {
  const { tracked, entries } = await readParsedStatus(runner, snapshot, signal);
  const pushEntries = entries.filter(({ kind, path }) => kind !== "untracked"
    && !tracked.get(path)?.some(({ mode }) => mode === "160000"));
  return worktreeSnapshotId(runner, snapshot, pushEntries, tracked, signal, false);
}

export interface StatusWithTrackedWorktreeProof {
  readonly status: StatusData;
  /** Complete promised outside-worktree proof with caller-selected paths omitted. */
  readonly outsideWorktreeSnapshotId: string;
}

export interface WorktreeContentProof {
  /** Exact Git-visible path universe authorized by the caller snapshot. */
  readonly paths: readonly string[];
  /** Filesystem kind, mode, bytes/target, and gitlink-state proof for that universe. */
  readonly snapshotId: string;
}

export interface StatusWithWorktreeContentProof {
  readonly status: StatusData;
  readonly contentProof: WorktreeContentProof;
}

function publicStatus(
  snapshot: RepositorySnapshot,
  entries: readonly ParsedStatusEntry[],
  worktreeSnapshotIdValue: string,
): StatusData {
  return {
    repository_id: snapshot.repositoryId, root: snapshot.root, git_dir: snapshot.gitDir, common_git_dir: snapshot.commonGitDir,
    branch: snapshot.branch, head: snapshot.head, head_tree: snapshot.headTree, index_tree: snapshot.indexTree,
    operation_state: snapshot.operationState, worktree_snapshot_id: worktreeSnapshotIdValue,
    entries: entries.map(({ path, index, worktree, kind }): StatusEntry => ({ path, index, worktree, kind })),
  };
}

/**
 * Reads status once, hashes every tracked deviation, gitlink, and Git-visible
 * untracked leaf, then derives a second proof omitting only selected paths.
 */
export async function readStatusWithTrackedWorktreeProof(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  excludedPaths: readonly string[],
  signal?: AbortSignal,
  hashBudget = createWorktreeHashBudget(),
): Promise<StatusWithTrackedWorktreeProof> {
  const excluded = new Set(excludedPaths);
  const { tracked, entries } = await readParsedStatus(runner, snapshot, signal);
  const fingerprints = new Map(await trackedPathFingerprints(runner, snapshot, tracked, signal, true, hashBudget));
  for (const [path, fingerprint] of await untrackedPathFingerprints(snapshot, entries, new Set(), hashBudget, signal)) {
    fingerprints.set(path, fingerprint);
  }
  for (const entry of entries) {
    for (const path of [entry.path, entry.sourcePath]) {
      if (path !== undefined && !fingerprints.has(path)) {
        fingerprints.set(path, await fingerprintUntrackedPath(snapshot, path, hashBudget, signal, true));
      }
    }
  }
  const snapshotId = worktreeSnapshotIdFromFingerprints(snapshot, entries, fingerprints);
  const outsideEntries = entries.filter((entry) => !excluded.has(entry.path)
    && (entry.sourcePath === undefined || !excluded.has(entry.sourcePath)));
  const outsideFingerprints = new Map(
    [...fingerprints].filter(([path]) => !excluded.has(path)),
  );
  return {
    status: publicStatus(snapshot, entries, snapshotId),
    outsideWorktreeSnapshotId: worktreeSnapshotIdFromFingerprints(
      snapshot,
      outsideEntries,
      outsideFingerprints,
    ),
  };
}

/**
 * Reads one public status snapshot and binds it to a content-complete proof of
 * every current Git-visible path. When requiredPaths is supplied, those paths
 * remain in the declared universe even if a successful mutation makes them
 * status-clean; newly Git-visible paths are always added to the proof.
 * Ignored and empty-directory paths are outside Git's declared universe.
 * Ordinary untracked directories are expanded to leaves by Git; directory
 * records (including nested repositories), FIFOs, sockets, and devices reject.
 */
export async function readStatusWithWorktreeContentProof(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  requiredPaths: readonly string[] = [],
  signal?: AbortSignal,
  hashBudget = createWorktreeHashBudget(),
): Promise<StatusWithWorktreeContentProof> {
  const entries = await readStatusEntries(runner, snapshot, signal);
  const paths = new Set(requiredPaths);
  for (const entry of entries) {
    paths.add(entry.path);
    if (entry.sourcePath !== undefined) paths.add(entry.sourcePath);
  }
  let sortedPaths = [...paths].sort(compareText);
  const tracked = await trackedIndexEntries(runner, snapshot, new Set(sortedPaths), signal);
  for (const path of tracked.keys()) paths.add(path);
  sortedPaths = [...paths].sort(compareText);
  const fingerprints = new Map<string, Readonly<Record<string, unknown>>>();
  for (const path of sortedPaths) {
    throwIfDeadlineExceeded(signal);
    const indexEntries = tracked.get(path);
    fingerprints.set(path, indexEntries === undefined
      ? await fingerprintUntrackedPath(snapshot, path, hashBudget, signal, true)
      : await fingerprintTrackedPath(runner, snapshot.root, path, indexEntries, signal, true, hashBudget));
  }
  const publicSnapshotId = worktreeSnapshotIdFromFingerprints(snapshot, entries, fingerprints);
  return {
    status: publicStatus(snapshot, entries, publicSnapshotId),
    contentProof: Object.freeze({
      paths: Object.freeze(sortedPaths),
      snapshotId: worktreeContentSnapshotIdFromFingerprints(fingerprints),
    }),
  };
}

/** Complete filesystem-content proof for every Git-visible path outside one owned path set. */
export async function readUnownedWorktreeContentSnapshotId(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  excludedPaths: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const excluded = new Set(excludedPaths);
  const { tracked, entries } = await readParsedStatus(runner, snapshot, signal);
  const budget = createWorktreeHashBudget();
  const fingerprints = new Map(
    [...await trackedPathFingerprints(runner, snapshot, tracked, signal, true, budget)]
      .filter(([path]) => !excluded.has(path)),
  );
  for (const [path, fingerprint] of await untrackedPathFingerprints(snapshot, entries, excluded, budget, signal)) {
    fingerprints.set(path, fingerprint);
  }
  const outsideEntries = entries.filter((entry) => !excluded.has(entry.path)
    && (entry.sourcePath === undefined || !excluded.has(entry.sourcePath)));
  return unownedWorktreeContentSnapshotIdFromFingerprints(outsideEntries, fingerprints);
}

/** Reads a content-complete snapshot of every non-ignored Git-visible worktree path. */
export async function readStatus(runner: GitRunner, snapshot: RepositorySnapshot, signal?: AbortSignal): Promise<StatusData> {
  return (await readStatusWithWorktreeContentProof(runner, snapshot, [], signal)).status;
}

function capUtf8(text: string, maxBytes: number): { readonly text: string; readonly capped: boolean } {
  let bytes = 0;
  let capped = "";
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint);
    if (bytes + size > maxBytes) return { text: capped, capped: true };
    capped += codePoint;
    bytes += size;
  }
  return { text: capped, capped: false };
}

/** Reads a bounded, non-persisted worktree or staged patch. */
export async function readDiff(runner: GitRunner, snapshot: RepositorySnapshot, input: ReadDiffInput, signal?: AbortSignal): Promise<DiffData> {
  const maxBytes = input.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_DIFF_MAX_BYTES) throw new RangeError("maxBytes must be an integer between 1 and 1000000");
  const validatedPaths = input.paths === undefined ? undefined : await validatePaths(
    runner,
    snapshot.root,
    input.paths,
    signal,
    { allowIndexedGitlink: true },
  );
  const paths = validatedPaths === undefined ? undefined : [...new Set(validatedPaths)];
  const chunks: readonly (readonly string[] | undefined)[] = paths === undefined || paths.length === 0
    ? [undefined]
    : literalPathChunks(paths);
  let diff = "";
  let bytes = 0;
  let truncated = false;
  for (let index = 0; index < chunks.length; index += 1) {
    throwIfDeadlineExceeded(signal);
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const chunk = chunks[index];
    const args = [
      "diff", "--no-ext-diff", "--no-color", ...(input.mode === "staged" ? ["--cached"] : []),
      "--", ...(chunk ?? []),
    ];
    const result = await runner.run({
      cwd: snapshot.root,
      args,
      timeoutMs: remainingDeadlineTimeoutMs(READ_TIMEOUT_MS),
      maxOutputBytes: remaining,
    }, signal);
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.aborted
      || result.stderrTruncated || result.stderr !== "") rejectGitRead(args, result);
    const capped = capUtf8(result.stdout, remaining);
    diff += capped.text;
    bytes += Buffer.byteLength(capped.text);
    if (result.stdoutTruncated || capped.capped) {
      truncated = true;
      break;
    }
    if (bytes === maxBytes && index + 1 < chunks.length) {
      truncated = true;
      break;
    }
  }
  return { mode: input.mode, diff, truncated, bytes };
}
