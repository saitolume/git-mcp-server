import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveGitExecutable } from "../src/git/environment.js";
import { addConflictPaths, mergeIndexStateId } from "../src/git/merge.js";
import { readStatus } from "../src/git/read.js";
import { inspectRepository } from "../src/git/repository.js";
import { restoreWorktree } from "../src/git/restore.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";
import { addPaths, restoreStaged } from "../src/git/stage.js";
import { initializeStatePaths, resolveStatePaths } from "../src/state/paths.js";
import type { MergeRecord } from "../src/state/records.js";
import { SessionStore } from "../src/state/session-store.js";

const INLINE_PATHSPEC_MAX_BYTES = 48 * 1024;
const SENTINEL = "unrequested-sentinel.txt";

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

function largePathSet(): readonly string[] {
  const paths = Array.from({ length: 250 }, (_, index) =>
    `bulk/file-${index.toString().padStart(3, "0")}-${"x".repeat(184)}.txt`);
  paths.push("-leading-dash.txt", "space path.txt", "line\nbreak.txt");
  const bytes = paths.reduce((total, path) => total + Buffer.byteLength(path, "utf8") + 1, 0);
  assert.ok(bytes > INLINE_PATHSPEC_MAX_BYTES, `fixture pathspec must exceed 48 KiB, observed ${bytes}`);
  assert.ok(bytes < 128 * 1024, `fixture pathspec must remain within the public input limit, observed ${bytes}`);
  return paths;
}

async function runGit(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
  options: { readonly expectExit?: number; readonly stdin?: string } = {},
): Promise<GitCommandResult> {
  const result = await runner.run({
    cwd,
    args,
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  assert.equal(result.exitCode, options.expectExit ?? 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
  return result;
}

function nulRecords(output: string): readonly string[] {
  if (output === "") return [];
  assert.equal(output.endsWith("\0"), true, "Git NUL output must be complete");
  return output.slice(0, -1).split("\0");
}

function assertSameSet(actual: readonly string[], expected: readonly string[]): void {
  assert.equal(actual.length, expected.length);
  assert.deepEqual(new Set(actual), new Set(expected));
}

function lastCommand(runner: TrackingRunner, predicate: (command: GitCommand) => boolean): GitCommand {
  const command = [...runner.commands].reverse().find(predicate);
  assert.ok(command, "expected Git command was not observed");
  return command;
}

function assertLargePathspecCommand(command: GitCommand, prefix: readonly string[], paths: readonly string[]): void {
  assert.deepEqual(command.args, [...prefix, "--pathspec-from-file=-", "--pathspec-file-nul"]);
  assert.equal(command.stdin, `${paths.join("\0")}\0`);
}

async function writeAll(root: string, paths: readonly string[], body: string): Promise<void> {
  await Promise.all(paths.map((path) => writeFile(join(root, path), `${body}\n`, "utf8")));
}

async function fixture(t: test.TestContext): Promise<{
  readonly repository: string;
  readonly runner: TrackingRunner;
  readonly sessions: SessionStore;
  readonly paths: readonly string[];
}> {
  const repository = await mkdtemp(join(tmpdir(), "git-mcp-server-large-pathspec-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-large-pathspec-state-"));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  });
  const runner = new TrackingRunner(await resolveGitExecutable(), process.env);
  await runGit(runner, repository, ["init", "--initial-branch=main"]);
  await runGit(runner, repository, ["config", "user.name", "git-mcp-server Test"]);
  await runGit(runner, repository, ["config", "user.email", "git-mcp-server@example.test"]);
  await mkdir(join(repository, "bulk"));
  const paths = largePathSet();
  await writeAll(repository, paths, "base");
  await writeFile(join(repository, SENTINEL), "sentinel base\n", "utf8");
  await runGit(runner, repository, ["add", "--all"]);
  await runGit(runner, repository, ["commit", "--no-gpg-sign", "-m", "base"]);
  const statePaths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  runner.commands.length = 0;
  return { repository, runner, sessions: new SessionStore(statePaths), paths };
}

test("large real-Git NUL pathspec covers add, restore-staged, and restore-worktree", async (t) => {
  const { repository, runner, sessions, paths } = await fixture(t);
  await writeAll(repository, paths, "modified");
  await writeFile(join(repository, SENTINEL), "sentinel modified\n", "utf8");
  const sentinelIndex = (await runGit(runner, repository, ["ls-files", "--stage", "-z", "--", SENTINEL])).stdout;

  let snapshot = await inspectRepository(runner, repository);
  runner.commands.length = 0;
  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths,
  });
  assert.ok(added.stage_id);
  assertSameSet(added.staged_paths, paths);
  assertLargePathspecCommand(lastCommand(runner, ({ args }) => args[0] === "add"), ["add"], paths);
  assertSameSet(nulRecords((await runGit(runner, repository, ["diff", "--cached", "--name-only", "-z"])).stdout), paths);
  assert.equal((await runGit(runner, repository, ["ls-files", "--stage", "-z", "--", SENTINEL])).stdout, sentinelIndex);
  assert.equal(await readFile(join(repository, SENTINEL), "utf8"), "sentinel modified\n");

  snapshot = await inspectRepository(runner, repository);
  const withSentinel = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: [SENTINEL],
  });
  assert.equal(withSentinel.stage_id, added.stage_id);
  assertSameSet(withSentinel.staged_paths, [...paths, SENTINEL]);
  const stagedSentinelIndex = (await runGit(
    runner, repository, ["ls-files", "--stage", "-z", "--", SENTINEL],
  )).stdout;
  assert.notEqual(stagedSentinelIndex, sentinelIndex);
  await writeFile(join(repository, SENTINEL), "sentinel later\n", "utf8");

  snapshot = await inspectRepository(runner, repository);
  runner.commands.length = 0;
  const restoredIndex = await restoreStaged(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths,
  });
  assert.equal(restoredIndex.stage_id, added.stage_id);
  assert.deepEqual(restoredIndex.remaining_paths, [SENTINEL]);
  assertLargePathspecCommand(
    lastCommand(runner, ({ args }) => args[0] === "restore" && args[1] === "--staged"),
    ["restore", "--staged", "--source=HEAD"],
    paths,
  );
  assert.deepEqual(nulRecords((await runGit(runner, repository, ["diff", "--cached", "--name-only", "-z"])).stdout), [SENTINEL]);
  assert.equal((await runGit(runner, repository, ["ls-files", "--stage", "-z", "--", SENTINEL])).stdout, stagedSentinelIndex);
  assert.equal(await readFile(join(repository, SENTINEL), "utf8"), "sentinel later\n");

  snapshot = await inspectRepository(runner, repository);
  const status = await readStatus(runner, snapshot);
  runner.commands.length = 0;
  const restoredWorktree = await restoreWorktree(runner, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head,
    worktreeSnapshotId: status.worktree_snapshot_id, paths,
  });
  assertSameSet(restoredWorktree.restored_paths, paths);
  assertLargePathspecCommand(
    lastCommand(runner, ({ args }) => args[0] === "restore" && args[1] === "--worktree"),
    ["restore", "--worktree"],
    paths,
  );
  for (const path of paths) assert.equal(await readFile(join(repository, path), "utf8"), "base\n", path);
  assert.equal((await runGit(runner, repository, ["ls-files", "--stage", "-z", "--", SENTINEL])).stdout, stagedSentinelIndex);
  assert.equal(await readFile(join(repository, SENTINEL), "utf8"), "sentinel later\n");
});

function indexStages(output: string): ReadonlyMap<string, readonly string[]> {
  const stages = new Map<string, string[]>();
  for (const record of nulRecords(output)) {
    const tab = record.indexOf("\t");
    const header = record.slice(0, tab).split(" ");
    assert.equal(header.length, 3, record);
    const path = record.slice(tab + 1);
    const entries = stages.get(path) ?? [];
    entries.push(header[2]!);
    stages.set(path, entries);
  }
  return stages;
}

test("large real-Git NUL pathspec resolves only requested merge conflicts", async (t) => {
  const { repository, runner, sessions, paths } = await fixture(t);
  await runGit(runner, repository, ["switch", "-c", "topic"]);
  await writeAll(repository, paths, "topic");
  await writeFile(join(repository, SENTINEL), "sentinel topic\n", "utf8");
  await runGit(runner, repository, ["add", "--all"]);
  await runGit(runner, repository, ["commit", "--no-gpg-sign", "-m", "topic"]);
  const targetObject = (await runGit(runner, repository, ["rev-parse", "HEAD"])).stdout.trim();

  await runGit(runner, repository, ["switch", "main"]);
  await writeAll(repository, paths, "main");
  await writeFile(join(repository, SENTINEL), "sentinel main\n", "utf8");
  await runGit(runner, repository, ["add", "--all"]);
  await runGit(runner, repository, ["commit", "--no-gpg-sign", "-m", "main"]);
  const originalHead = (await runGit(runner, repository, ["rev-parse", "HEAD"])).stdout.trim();
  await runGit(runner, repository, ["merge", "--no-gpg-sign", "topic"], { expectExit: 1 });

  let snapshot = await inspectRepository(runner, repository);
  const status = await readStatus(runner, snapshot);
  const conflictedPaths = status.entries.filter(({ kind }) => kind === "unmerged").map(({ path }) => path);
  assertSameSet(conflictedPaths, [...paths, SENTINEL]);
  const now = "2026-07-20T00:00:00.000Z";
  const record: MergeRecord = {
    kind: "merge", mergeSessionId: "large-pathspec-merge", repositoryId: snapshot.repositoryId,
    branch: "main", originalHead, targetObject, fetchId: "large-pathspec-fetch",
    currentIndexTree: mergeIndexStateId(snapshot.indexTree), conflictedPaths, resolvedPaths: [],
    createdAt: now, updatedAt: now,
  };
  await sessions.createMergeSession(record);
  await writeAll(repository, paths, "resolved");
  const sentinelContent = await readFile(join(repository, SENTINEL), "utf8");
  const sentinelIndex = (await runGit(runner, repository, ["ls-files", "--stage", "-z", "--", SENTINEL])).stdout;

  snapshot = await inspectRepository(runner, repository);
  runner.commands.length = 0;
  const added = await addConflictPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: originalHead, mergeSessionId: record.mergeSessionId, paths,
  });
  assert.equal(added.mode, "merge");
  assertSameSet(added.staged_paths, paths);
  assert.deepEqual(added.unresolved_paths, [SENTINEL]);
  assertLargePathspecCommand(lastCommand(runner, ({ args }) => args[0] === "add"), ["add"], paths);

  const unresolved = nulRecords((await runGit(
    runner, repository, ["diff", "--name-only", "--diff-filter=U", "-z"],
  )).stdout);
  assert.deepEqual(unresolved, [SENTINEL]);
  const stages = indexStages((await runGit(runner, repository, ["ls-files", "--stage", "-z"])).stdout);
  for (const path of paths) assert.deepEqual(stages.get(path), ["0"], path);
  assert.deepEqual(stages.get(SENTINEL), ["1", "2", "3"]);
  assert.equal((await runGit(runner, repository, ["ls-files", "--stage", "-z", "--", SENTINEL])).stdout, sentinelIndex);
  assert.equal(await readFile(join(repository, SENTINEL), "utf8"), sentinelContent);
  const stored = await sessions.getMerge(record.mergeSessionId);
  assert.ok(stored);
  assert.deepEqual(stored.conflictedPaths, [SENTINEL]);
  assertSameSet(stored.resolvedPaths, paths);
});
