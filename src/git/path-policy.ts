import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { throwIfDeadlineExceeded, remainingDeadlineTimeoutMs } from "../deadline.js";
import { gitOutputPath } from "../domain/inputs.js";
import { assertWellFormedGitText, isWellFormedGitText } from "../domain/git-text.js";
import { BridgeRejection } from "../domain/result.js";
import {
  COMPLETE_RECORD_MAX_BYTES, GIT_PATH_MAX_BYTES, INITIALIZED_GITLINK_PATH_MAX_COUNT,
} from "../limits.js";
import { literalPathChunks } from "./pathspec.js";
import { readIndexStageMap, type IndexStageRecord } from "./repository.js";
import { GitRunner, type GitCommandResult } from "./runner.js";
import { DelimitedRecordParser, STREAM_STDERR_MAX_BYTES } from "./streaming.js";

const READ_TIMEOUT_MS = 30_000;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

interface FileTypeFacts {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}

export function isUnsupportedSpecialNode(stats: FileTypeFacts): boolean {
  return stats.isFIFO() || stats.isSocket() || stats.isBlockDevice() || stats.isCharacterDevice();
}

function invalidPath(path: string, message: string): BridgeRejection {
  return new BridgeRejection({
    code: "INVALID_INPUT",
    message,
    details: { path },
  });
}

function assertLexicallySafe(path: string): string {
  if (!isWellFormedGitText(path) || path.length === 0 || Buffer.byteLength(path, "utf8") > GIT_PATH_MAX_BYTES
    || path.startsWith("/") || path.startsWith(":") || path.includes("\0")
    || path.includes("\\") || /[*?\[]/.test(path)) {
    throw invalidPath(path, "Path must be a safe repository-relative path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidPath(path, "Path must be a safe repository-relative path");
  }
  return segments.join("/");
}

function assertGitOutputLexicallySafe(path: string): string {
  if (!isWellFormedGitText(path) || path.length === 0 || Buffer.byteLength(path, "utf8") > GIT_PATH_MAX_BYTES
    || path.startsWith("/") || path.includes("\0")) {
    throw invalidPath(path, "Git output path is not a safe repository-relative path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidPath(path, "Git output path is not a safe repository-relative path");
  }
  return segments.join("/");
}

function commandFailed(result: GitCommandResult): boolean {
  return result.signal !== null || result.timedOut || result.aborted || result.stdoutTruncated || result.stderrTruncated;
}

/** Rejects a tracked path that would traverse an observed symlink below the repository root. */
export async function assertTrackedPathConfined(root: string, path: string): Promise<string> {
  assertWellFormedGitText(root, "Repository root");
  const normalized = assertGitOutputLexicallySafe(path);
  const segments = normalized.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    throwIfDeadlineExceeded();
    const intermediate = join(root, ...segments.slice(0, index));
    try {
      const stats = await lstat(intermediate);
      if (stats.isSymbolicLink()) {
        throw new BridgeRejection({
          code: "PATH_OUTSIDE_REPOSITORY",
          message: "Path traverses a symbolic link",
          details: { path: normalized },
        });
      }
    } catch (error) {
      if (error instanceof BridgeRejection) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "ENOTDIR") throw invalidPath(normalized, "Path traverses a non-directory component");
      throw error;
    }
  }
  return normalized;
}

type HeadPathKind = "absent" | "blob" | "symlink" | "gitlink" | "directory";

async function readHeadPathKinds(
  runner: GitRunner,
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, HeadPathKind>> {
  const kinds = new Map<string, HeadPathKind>();
  for (const chunk of literalPathChunks(paths)) {
    throwIfDeadlineExceeded(signal);
    const selected = new Set(chunk);
    const args = ["ls-tree", "-z", "HEAD", "--", ...chunk];
    const parser = new DelimitedRecordParser(0, COMPLETE_RECORD_MAX_BYTES, "Git HEAD path metadata", (record) => {
      throwIfDeadlineExceeded(signal);
      const match = /^(040000|100644|100755|120000|160000) (blob|tree|commit) ([0-9a-f]{40,64})\t(.+)$/s.exec(record);
      const mode = match?.[1];
      const type = match?.[2];
      const object = match?.[3];
      const path = match?.[4];
      if (mode === undefined || type === undefined || object === undefined || path === undefined
        || !OBJECT_ID.test(object) || !gitOutputPath.safeParse(path).success || !selected.has(path) || kinds.has(path)) {
        throw new Error("Malformed Git HEAD path metadata");
      }
      const kind: HeadPathKind = mode === "040000" && type === "tree" ? "directory"
        : (mode === "100644" || mode === "100755") && type === "blob" ? "blob"
          : mode === "120000" && type === "blob" ? "symlink"
            : mode === "160000" && type === "commit" ? "gitlink"
              : (() => { throw new Error("Unsupported Git HEAD path metadata"); })();
      kinds.set(path, kind);
    });
    const result = await runner.runStreaming({
      cwd: root,
      args,
      timeoutMs: remainingDeadlineTimeoutMs(READ_TIMEOUT_MS),
      maxStderrBytes: STREAM_STDERR_MAX_BYTES,
    }, (data) => parser.write(data), signal);
    if (result.exitCode !== 0 || commandFailed(result) || result.stderr !== "") {
      throw new Error("Git command failed while checking HEAD path metadata");
    }
    try { parser.finish(); } catch { throw new Error("Malformed Git HEAD path metadata"); }
  }
  return kinds;
}

function strictLine(result: GitCommandResult): string | null {
  if (result.exitCode !== 0) {
    if (typeof result.exitCode === "number" && result.exitCode > 0
      && result.signal === null && !result.timedOut && !result.aborted
      && !result.stdoutTruncated && !result.stderrTruncated) return null;
    throw new Error("Unable to prove initialized gitlink state");
  }
  if (commandFailed(result) || result.stderr !== "" || !result.stdout.endsWith("\n") || result.stdout.includes("�")) {
    throw new Error("Unable to prove initialized gitlink state");
  }
  const line = result.stdout.slice(0, -1);
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) throw new Error("Unable to prove initialized gitlink state");
  return line;
}

async function isInitializedGitlink(
  runner: GitRunner,
  canonicalRoot: string,
  fullPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let canonicalPath: string;
  throwIfDeadlineExceeded(signal);
  try { canonicalPath = assertWellFormedGitText(await realpath(fullPath), "Canonical gitlink path"); }
  catch { return false; }
  throwIfDeadlineExceeded(signal);
  if (canonicalPath === canonicalRoot || !canonicalPath.startsWith(`${canonicalRoot}/`)) return false;
  throwIfDeadlineExceeded(signal);
  const top = strictLine(await runner.run({
    cwd: canonicalPath,
    args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    timeoutMs: remainingDeadlineTimeoutMs(READ_TIMEOUT_MS),
    maxOutputBytes: 8_192,
  }, signal));
  if (top === null) return false;
  let canonicalTop: string;
  try {
    canonicalTop = assertWellFormedGitText(
      await realpath(assertWellFormedGitText(top, "Git gitlink path output")),
      "Canonical Git gitlink path",
    );
  } catch { return false; }
  throwIfDeadlineExceeded(signal);
  if (canonicalTop !== canonicalPath) return false;
  throwIfDeadlineExceeded(signal);
  const head = strictLine(await runner.run({
    cwd: canonicalPath,
    args: ["rev-parse", "--verify", "HEAD^{commit}"],
    timeoutMs: remainingDeadlineTimeoutMs(READ_TIMEOUT_MS),
    maxOutputBytes: 8_192,
  }, signal));
  return head !== null && OBJECT_ID.test(head);
}

export interface ValidatePathOptions {
  readonly allowHeadTrackedMissing?: boolean;
  readonly allowIndexedGitlink?: boolean;
}

/**
 * Validates paths under a canonical repository root without traversing caller-controlled symlinks.
 * The returned values retain POSIX repository separators and original case.
 */
export async function validatePaths(
  runner: GitRunner,
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
  options: ValidatePathOptions = {},
): Promise<readonly string[]> {
  assertWellFormedGitText(root, "Repository root");
  const normalized = [...new Set(paths)].map(assertLexicallySafe);
  throwIfDeadlineExceeded(signal);
  const indexProof = await readIndexStageMap(runner, root, signal, new Set(normalized));
  const entriesFor = (path: string): readonly IndexStageRecord[] => indexProof.capturedEntries.get(path) ?? [];
  const initializedGitlinkPaths = options.allowIndexedGitlink === true
    ? normalized.filter((path) => {
        const entries = entriesFor(path);
        return entries.length > 0 && entries.every(({ mode }) => mode === "160000");
      })
    : [];
  if (initializedGitlinkPaths.length > INITIALIZED_GITLINK_PATH_MAX_COUNT) {
    throw invalidPath(
      initializedGitlinkPaths[INITIALIZED_GITLINK_PATH_MAX_COUNT]!,
      `Initialized gitlink path limit exceeded (${INITIALIZED_GITLINK_PATH_MAX_COUNT})`,
    );
  }
  let canonicalRoot: string | undefined;
  if (initializedGitlinkPaths.length > 0) {
    throwIfDeadlineExceeded(signal);
    try { canonicalRoot = assertWellFormedGitText(await realpath(root), "Canonical repository root"); }
    catch { throw invalidPath(initializedGitlinkPaths[0]!, "Unable to resolve repository root for gitlink validation"); }
    throwIfDeadlineExceeded(signal);
  }
  const needsHead = new Set<string>();
  for (const path of normalized) {
    throwIfDeadlineExceeded(signal);
    const segments = path.split("/");
    await assertTrackedPathConfined(root, path);

    const finalPath = join(root, ...segments);
    try {
      const stats = await lstat(finalPath);
      if (isUnsupportedSpecialNode(stats)
        || (!stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink())) {
        throw invalidPath(path, "Path must not name a special filesystem node");
      }
      if (stats.isDirectory()) {
        const entries = options.allowIndexedGitlink === true ? entriesFor(path) : [];
        if (entries.length === 0 || entries.some(({ mode }) => mode !== "160000")
          || canonicalRoot === undefined || !(await isInitializedGitlink(runner, canonicalRoot, finalPath, signal))) {
          throw invalidPath(path, "Path must not name an ordinary or uninitialized directory");
        }
      }
      if (stats.isSymbolicLink() && entriesFor(path).length === 0) {
        throw invalidPath(path, "Final symbolic-link path must be tracked");
      }
    } catch (error) {
      if (error instanceof BridgeRejection) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entries = entriesFor(path);
      if (entries.some(({ mode }) => mode === "160000")) {
        throw invalidPath(path, "Missing gitlink paths are not supported");
      }
      if (entries.length === 0) {
        if (options.allowHeadTrackedMissing === true) needsHead.add(path);
        else throw invalidPath(path, "Missing path must be tracked");
      }
    }
  }
  const headKinds = await readHeadPathKinds(runner, root, [...needsHead], signal);
  for (const path of needsHead) {
    throwIfDeadlineExceeded(signal);
    const headKind = headKinds.get(path) ?? "absent";
    if (headKind === "gitlink") throw invalidPath(path, "Missing gitlink paths are not supported");
    if (headKind !== "blob" && headKind !== "symlink") throw invalidPath(path, "Missing path must be tracked");
  }
  return normalized;
}
