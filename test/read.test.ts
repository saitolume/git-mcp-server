import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withDeadline } from "../src/deadline.js";
import { BridgeRejection, type StatusEntry } from "../src/domain/result.js";
import { INITIALIZED_GITLINK_PATH_MAX_COUNT } from "../src/limits.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { isUnsupportedSpecialNode, validatePaths } from "../src/git/path-policy.js";
import {
  createWorktreeHashBudget, hashRegularFileForSnapshot, readDiff, readStatus, readStatusWithTrackedWorktreeProof,
} from "../src/git/read.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-read-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function gitRunner(): Promise<GitRunner> {
  return new GitRunner(await resolveGitExecutable(), process.env);
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 10_000, maxOutputBytes: 32_768 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
  return result.stdout;
}

async function createRepository(t: test.TestContext): Promise<{ directory: string; runner: GitRunner }> {
  const directory = await temporaryDirectory(t);
  const runner = await gitRunner();
  await runGit(runner, directory, ["init", "--initial-branch=main"]);
  await runGit(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
  await runGit(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
  await runGit(runner, directory, ["config", "commit.gpgSign", "false"]);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "README.md"), "initial\\n");
  await writeFile(join(directory, "src", "a.ts"), "export const a = 1;\\n");
  await runGit(runner, directory, ["add", "README.md", "src/a.ts"]);
  await runGit(runner, directory, ["-c", "commit.gpgSign=false", "commit", "-m", "initial"]);
  return { directory, runner };
}

function isRejection(code: "INVALID_INPUT" | "PATH_OUTSIDE_REPOSITORY" | "UNSUPPORTED_REPOSITORY_STATE") {
  return (error: unknown): boolean => error instanceof BridgeRejection && error.error.code === code;
}

function result(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0, ...overrides,
  };
}

class ControlledRunner extends GitRunner {
  readonly commands: GitCommand[] = [];

  constructor(private readonly respond: (command: GitCommand) => GitCommandResult) {
    super(process.execPath, process.env);
  }

  override async run(command: GitCommand, _signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return this.respond(command);
  }
}

function snapshotFor(root: string): RepositorySnapshot {
  return {
    repositoryId: "r".repeat(64), root, gitDir: join(root, ".git"), commonGitDir: join(root, ".git"),
    branch: "main", branchRef: "refs/heads/main", head: "a".repeat(40), headTree: "b".repeat(40),
    indexTree: "c".repeat(64), indexMatchesHead: false, operationState: "none",
  } as RepositorySnapshot;
}

async function repositoryWriteState(directory: string): Promise<unknown> {
  const indexPath = join(directory, ".git", "index");
  const index = await lstat(indexPath);
  return {
    index: await readFile(indexPath),
    metadata: { mode: index.mode, size: index.size, ino: index.ino, mtimeMs: index.mtimeMs, ctimeMs: index.ctimeMs },
    objects: (await readdir(join(directory, ".git", "objects"), { recursive: true }))
      .filter((entry) => /^[0-9a-f]{2}\/[0-9a-f]{38,62}$/.test(entry)).sort(),
  };
}

test("git status and both git diff modes are read-only across index and object state", async (t) => {
  for (const operation of ["status", "worktree-diff", "staged-diff"] as const) {
    await t.test(operation, async (t) => {
      const { directory, runner } = await createRepository(t);
      await writeFile(join(directory, "src", "a.ts"), `staged ${operation}\n`);
      await runGit(runner, directory, ["add", "--", "src/a.ts"]);
      if (operation === "worktree-diff") await writeFile(join(directory, "README.md"), "worktree change\n");
      const before = await repositoryWriteState(directory);

      const snapshot = await inspectRepository(runner, directory);
      if (operation === "status") await readStatus(runner, snapshot);
      else await readDiff(runner, snapshot, { mode: operation === "worktree-diff" ? "worktree" : "staged" });

      assert.deepEqual(await repositoryWriteState(directory), before);
    });
  }
});

test("status rejects an index visibility change between its visibility and porcelain reads", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);
  const gitExecutable = await resolveGitExecutable();
  class VisibilityRaceRunner extends GitRunner {
    private triggered = false;

    override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
      const response = await super.run(command, signal);
      if (!this.triggered && command.args.join(" ") === "ls-files --cached -v -z") {
        this.triggered = true;
        await writeFile(join(directory, "README.md"), "hidden mutation\n");
        const hidden = await super.run({
          cwd: directory,
          args: ["update-index", "--assume-unchanged", "--", "README.md"],
          timeoutMs: 10_000,
          maxOutputBytes: 32_768,
        });
        assert.equal(hidden.exitCode, 0, hidden.stderr);
      }
      return response;
    }
  }
  const racingRunner = new VisibilityRaceRunner(gitExecutable, process.env);

  await assert.rejects(readStatus(racingRunner, snapshot), isRejection("UNSUPPORTED_REPOSITORY_STATE"));
});

function statusText(): string {
  return `# branch.oid ${"a".repeat(40)}\0# branch.head main\0`;
}

test("path policy rejects unsafe lexical paths", async (t) => {
  const { directory, runner } = await createRepository(t);

  for (const path of ["/absolute", ".", "a/../b", "a//b", "*.ts", "", "a/\\0b"]) {
    await assert.rejects(validatePaths(runner, directory, [path]), isRejection("INVALID_INPUT"));
  }
});

test("path policy rejects an oversized UTF-8 path before invoking Git", async () => {
  const runner = new ControlledRunner(() => { throw new Error("Git must not run"); });
  const path = `src/${"あ".repeat(1_365)}.ts`;
  assert.ok(Buffer.byteLength(path, "utf8") > 4 * 1024);

  await assert.rejects(validatePaths(runner, "/repo", [path]), isRejection("INVALID_INPUT"));
  assert.deepEqual(runner.commands, []);
});

test("path policy rejects ambiguous Unicode before invoking Git", async () => {
  for (const path of ["bad\uFFFD.txt", "bad\uD800.txt", "bad\uDC00.txt"]) {
    const runner = new ControlledRunner(() => { throw new Error("Git must not run"); });
    await assert.rejects(validatePaths(runner, "/repo", [path]), isRejection("INVALID_INPUT"));
    assert.deepEqual(runner.commands, []);
  }
});

test("path policy accepts tracked and Unicode files", async (t) => {
  const { directory, runner } = await createRepository(t);
  const unicodePath = "src/日本語.ts";
  await writeFile(join(directory, unicodePath), "export const 日本語 = true;\\n");
  await runGit(runner, directory, ["add", "--", unicodePath]);

  assert.deepEqual(await validatePaths(runner, directory, ["src/a.ts", unicodePath]), ["src/a.ts", unicodePath]);
});

test("git diff path policy accepts an initialized indexed gitlink", async (t) => {
  const { directory, runner } = await createRepository(t);
  const module = join(directory, "module");
  await mkdir(module);
  await runGit(runner, module, ["init", "--initial-branch=main"]);
  await runGit(runner, module, ["config", "user.name", "git-mcp-server Nested Test"]);
  await runGit(runner, module, ["config", "user.email", "nested@example.test"]);
  await writeFile(join(module, "nested.txt"), "one\n");
  await runGit(runner, module, ["add", "--", "nested.txt"]);
  await runGit(runner, module, ["commit", "--no-gpg-sign", "-m", "nested one"]);
  const firstNestedHead = (await runGit(runner, module, ["rev-parse", "HEAD"])).trim();
  await runGit(runner, directory, ["update-index", "--add", "--cacheinfo", `160000,${firstNestedHead},module`]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "add gitlink"]);
  const snapshot = await inspectRepository(runner, directory);
  await writeFile(join(module, "nested.txt"), "two\n");
  await runGit(runner, module, ["add", "--", "nested.txt"]);
  await runGit(runner, module, ["commit", "--no-gpg-sign", "-m", "nested two"]);

  const diff = await readDiff(runner, snapshot, { mode: "worktree", paths: ["module"] });

  assert.match(diff.diff, /Subproject commit/);
});

test("path policy rejects an indexed gitlink whose nested HEAD does not peel to a commit", async (t) => {
  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, "module"));
  const runner = new ControlledRunner((command) => {
    if (command.args.join(" ") === "ls-files --stage -z") {
      return result({ stdout: `160000 ${"a".repeat(40)} 0\tmodule\0` });
    }
    if (command.args.join(" ") === "rev-parse --path-format=absolute --show-toplevel") {
      return result({ stdout: `${join(directory, "module")}\n` });
    }
    if (command.args.join(" ") === "rev-parse --verify HEAD^{commit}") {
      return result({ exitCode: 1 });
    }
    throw new Error(`unexpected command: ${command.args.join(" ")}`);
  });

  await assert.rejects(
    validatePaths(runner, directory, ["module"], undefined, { allowIndexedGitlink: true }),
    isRejection("INVALID_INPUT"),
  );
  assert.equal(runner.commands.some(({ args }) => args.join(" ") === "rev-parse --verify HEAD^{commit}"), true);
  assert.equal(runner.commands.some(({ args }) => args.join(" ") === "rev-parse --verify HEAD"), false);
});

test("path policy classifies FIFO socket block and character nodes as special", () => {
  type TypeFacts = {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
  };
  for (const kind of ["FIFO", "Socket", "BlockDevice", "CharacterDevice"] as const) {
    const facts = {
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => kind === "FIFO",
      isSocket: () => kind === "Socket",
      isBlockDevice: () => kind === "BlockDevice",
      isCharacterDevice: () => kind === "CharacterDevice",
    };
    assert.equal(isUnsupportedSpecialNode(facts), true, kind);
  }
});

test("path policy accepts a tracked final symlink and a tracked missing path", async (t) => {
  const { directory, runner } = await createRepository(t);
  const linkPath = join(directory, "src", "linked.ts");
  await symlink("a.ts", linkPath);
  await runGit(runner, directory, ["add", "--", "src/linked.ts"]);
  await unlink(join(directory, "src", "a.ts"));

  assert.deepEqual(
    await validatePaths(runner, directory, ["src/linked.ts", "src/a.ts"]),
    ["src/linked.ts", "src/a.ts"],
  );
});

test("path policy classifies the maximum literal path request with one complete index read and few HEAD reads", async (t) => {
  const directory = await temporaryDirectory(t);
  const paths = Array.from({ length: 10_000 }, (_, index) => `p${index.toString().padStart(6, "0")}`);
  assert.ok(paths.reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) <= 128 * 1024);
  const runner = new ControlledRunner((command) => {
    if (command.args[0] === "ls-files" && command.args[1] === "--stage") return result();
    if (command.args[0] === "ls-tree") {
      const separator = command.args.indexOf("--");
      const selected = command.args.slice(separator + 1);
      return result({ stdout: selected.map((path) => `100644 blob ${"a".repeat(40)}\t${path}\0`).join("") });
    }
    throw new Error(`unexpected command: ${command.args.join(" ")}`);
  });

  assert.deepEqual(
    await validatePaths(runner, directory, paths, undefined, { allowHeadTrackedMissing: true }),
    paths,
  );
  assert.equal(runner.commands.filter(({ args }) => args[0] === "ls-files").length, 1);
  assert.ok(runner.commands.filter(({ args }) => args[0] === "ls-tree").length <= 3);
  assert.equal(runner.commands.every(({ args }) => Buffer.byteLength(args.join("\0")) < 64 * 1024), true);
});

test("batched path classification passes only the shrinking absolute budget to later children", async (t) => {
  const directory = await temporaryDirectory(t);
  const paths = ["missing-a", "missing-b"];
  let now = 1_000;
  const runner = new ControlledRunner((command) => {
    now += 1_000;
    if (command.args[0] === "ls-files") return result();
    if (command.args[0] === "ls-tree") {
      const selected = command.args.slice(command.args.indexOf("--") + 1);
      return result({ stdout: selected.map((path) => `100644 blob ${"a".repeat(40)}\t${path}\0`).join("") });
    }
    throw new Error(`unexpected command: ${command.args.join(" ")}`);
  });

  await withDeadline(5_000, undefined, () =>
    validatePaths(runner, directory, paths, undefined, { allowHeadTrackedMissing: true }),
  { monotonicNow: () => now });

  assert.deepEqual(runner.commands.map(({ timeoutMs }) => timeoutMs), [5_000, 4_000]);
});

test("maximum duplicate initialized-gitlink paths are validated once within the absolute deadline", async (t) => {
  const directory = await temporaryDirectory(t);
  const module = join(directory, "module");
  await mkdir(module);
  let now = 1_000;
  const runner = new ControlledRunner((command) => {
    now += 1_000;
    if (command.args[0] === "ls-files") {
      return result({ stdout: `160000 ${"a".repeat(40)} 0\tmodule\0` });
    }
    if (command.args.join(" ") === "rev-parse --path-format=absolute --show-toplevel") {
      return result({ stdout: `${module}\n` });
    }
    if (command.args.join(" ") === "rev-parse --verify HEAD^{commit}") {
      return result({ stdout: `${"b".repeat(40)}\n` });
    }
    throw new Error(`unexpected command: ${command.args.join(" ")}`);
  });

  const validated = await withDeadline(5_000, undefined, () => validatePaths(
    runner,
    directory,
    Array.from({ length: 10_000 }, () => "module"),
    undefined,
    { allowIndexedGitlink: true },
  ), { monotonicNow: () => now });

  assert.deepEqual(validated, ["module"]);
  assert.deepEqual(runner.commands.map(({ args }) => args.slice(0, 3)), [
    ["ls-files", "--stage", "-z"],
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    ["rev-parse", "--verify", "HEAD^{commit}"],
  ]);
  assert.deepEqual(runner.commands.map(({ timeoutMs }) => timeoutMs), [5_000, 4_000, 3_000]);
});

test("initialized-gitlink validation has an explicit unique-path child-process bound", async (t) => {
  const directory = await temporaryDirectory(t);
  const boundedPaths = Array.from(
    { length: INITIALIZED_GITLINK_PATH_MAX_COUNT },
    (_, index) => `module-${index.toString().padStart(3, "0")}`,
  );
  await Promise.all(boundedPaths.map((path) => mkdir(join(directory, path))));
  const boundedRunner = new ControlledRunner((command) => {
    if (command.args[0] === "ls-files") {
      return result({ stdout: boundedPaths.map((path) => `160000 ${"a".repeat(40)} 0\t${path}\0`).join("") });
    }
    if (command.args.join(" ") === "rev-parse --path-format=absolute --show-toplevel") {
      return result({ stdout: `${command.cwd}\n` });
    }
    if (command.args.join(" ") === "rev-parse --verify HEAD^{commit}") {
      return result({ stdout: `${"b".repeat(40)}\n` });
    }
    throw new Error(`unexpected command: ${command.args.join(" ")}`);
  });

  assert.deepEqual(
    await validatePaths(boundedRunner, directory, boundedPaths, undefined, { allowIndexedGitlink: true }),
    boundedPaths,
  );
  assert.equal(boundedRunner.commands.length, 1 + (2 * INITIALIZED_GITLINK_PATH_MAX_COUNT));

  const maximumPaths = Array.from({ length: 10_000 }, (_, index) => `gitlink-${index.toString().padStart(5, "0")}`);
  const maximumRunner = new ControlledRunner((command) => {
    if (command.args[0] === "ls-files") {
      return result({ stdout: maximumPaths.map((path) => `160000 ${"a".repeat(40)} 0\t${path}\0`).join("") });
    }
    throw new Error(`nested Git must not run: ${command.args.join(" ")}`);
  });

  await assert.rejects(
    validatePaths(maximumRunner, directory, maximumPaths, undefined, { allowIndexedGitlink: true }),
    (error: unknown) => error instanceof BridgeRejection
      && error.error.code === "INVALID_INPUT"
      && /initialized gitlink.*limit/i.test(error.error.message),
  );
  assert.equal(maximumRunner.commands.length, 1);
});

test("path policy rejects a directory and intermediate symlink traversal", async (t) => {
  const { directory, runner } = await createRepository(t);
  const outside = await temporaryDirectory(t);
  await writeFile(join(outside, "escape.ts"), "outside\\n");
  await symlink(outside, join(directory, "linked"));

  await assert.rejects(validatePaths(runner, directory, ["src"]), isRejection("INVALID_INPUT"));
  await assert.rejects(validatePaths(runner, directory, ["linked/escape.ts"]), isRejection("PATH_OUTSIDE_REPOSITORY"));
});

test("path policy rejects a missing directory path even when Git pathspec matches descendants", async (t) => {
  const { directory, runner } = await createRepository(t);
  await mkdir(join(directory, "d"));
  await writeFile(join(directory, "d", "f"), "tracked\n");
  await runGit(runner, directory, ["add", "d/f"]);
  await rm(join(directory, "d"), { recursive: true, force: true });

  await assert.rejects(validatePaths(runner, directory, ["d"]), isRejection("INVALID_INPUT"));
});

test("status rejects tracked paths whose intermediate directory was replaced by a symlink", async (t) => {
  const { directory, runner } = await createRepository(t);
  await mkdir(join(directory, "d"));
  await writeFile(join(directory, "d", "f"), "inside\n");
  await runGit(runner, directory, ["add", "d/f"]);
  await runGit(runner, directory, ["commit", "-m", "track d/f"]);
  const snapshot = await inspectRepository(runner, directory);
  const outside = await temporaryDirectory(t);
  await writeFile(join(outside, "f"), "outside changed\n");
  await rm(join(directory, "d"), { recursive: true, force: true });
  await symlink(outside, join(directory, "d"));

  await assert.rejects(readStatus(runner, snapshot), isRejection("PATH_OUTSIDE_REPOSITORY"));
});

test("status snapshot changes for same-path worktree content edits", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);

  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\\n");
  const first = await readStatus(runner, snapshot);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 3;\\n");
  const second = await readStatus(runner, snapshot);

  assert.equal(first.repository_id, snapshot.repositoryId);
  assert.equal(first.root, snapshot.root);
  assert.equal(first.branch, "main");
  assert.ok(first.entries.some((entry: StatusEntry) => entry.path === "src/a.ts" && entry.kind === "ordinary"));
  assert.notEqual(second.worktree_snapshot_id, first.worktree_snapshot_id);
});

test("status snapshot changes for same-path untracked regular content edits", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);
  await writeFile(join(directory, "untracked.txt"), "first\n");
  const first = await readStatus(runner, snapshot);

  await writeFile(join(directory, "untracked.txt"), "second\n");
  const second = await readStatus(runner, snapshot);

  assert.notEqual(second.worktree_snapshot_id, first.worktree_snapshot_id);
});

test("status snapshot covers untracked symlink targets, add-delete, and type changes", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);
  const path = join(directory, "untracked-leaf");
  await symlink("first-target", path);
  const first = await readStatus(runner, snapshot);
  await unlink(path);
  await symlink("second-target", path);
  const changedTarget = await readStatus(runner, snapshot);
  await unlink(path);
  const deleted = await readStatus(runner, snapshot);
  await writeFile(path, "regular\n");
  const changedType = await readStatus(runner, snapshot);

  assert.notEqual(changedTarget.worktree_snapshot_id, first.worktree_snapshot_id);
  assert.notEqual(deleted.worktree_snapshot_id, changedTarget.worktree_snapshot_id);
  assert.notEqual(changedType.worktree_snapshot_id, deleted.worktree_snapshot_id);
  assert.notEqual(changedType.worktree_snapshot_id, changedTarget.worktree_snapshot_id);
});

test("status snapshot distinguishes malformed UTF-8 bytes in tracked symlink targets", async (t) => {
  const { directory, runner } = await createRepository(t);
  const path = join(directory, "tracked-link");
  await symlink(Buffer.from("tracked"), path);
  await runGit(runner, directory, ["add", "tracked-link"]);
  await runGit(runner, directory, ["commit", "-m", "track symlink"]);
  const snapshot = await inspectRepository(runner, directory);

  await unlink(path);
  await symlink(Buffer.from([0xff]), path);
  const first = await readStatus(runner, snapshot);
  await unlink(path);
  await symlink(Buffer.from([0xfe]), path);
  const second = await readStatus(runner, snapshot);

  assert.notEqual(second.worktree_snapshot_id, first.worktree_snapshot_id);
});

test("status expands untracked directories and rejects nested repositories and tracked FIFOs", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);
  await mkdir(join(directory, "untracked-directory"));
  await writeFile(join(directory, "untracked-directory", "leaf"), "leaf\n");
  const leafStatus = await readStatus(runner, snapshot);
  assert.ok(leafStatus.entries.some((entry) => entry.path === "untracked-directory/leaf"));
  await rm(join(directory, "untracked-directory"), { recursive: true, force: true });

  await mkdir(join(directory, "nested"));
  await runGit(runner, join(directory, "nested"), ["init"]);
  await assert.rejects(readStatus(runner, snapshot), isRejection("UNSUPPORTED_REPOSITORY_STATE"));
  await rm(join(directory, "nested"), { recursive: true, force: true });

  const fifo = join(directory, "src", "a.ts");
  await unlink(fifo);
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  await assert.rejects(readStatus(runner, snapshot), isRejection("UNSUPPORTED_REPOSITORY_STATE"));
});

test("status parser handles ordinary, renamed, unmerged, and untracked records", async (t) => {
  const { directory, runner } = await createRepository(t);
  await writeFile(join(directory, "README.md"), "ordinary\\n");
  await runGit(runner, directory, ["mv", "src/a.ts", "src/b.ts"]);
  await writeFile(join(directory, "untracked 日本語.txt"), "untracked\\n");
  await runGit(runner, directory, ["add", "README.md", "src/b.ts"]);
  await runGit(runner, directory, ["commit", "-m", "rename and ordinary"]);
  await runGit(runner, directory, ["checkout", "-b", "topic"]);
  await writeFile(join(directory, "README.md"), "topic\\n");
  await runGit(runner, directory, ["add", "README.md"]);
  await runGit(runner, directory, ["commit", "-m", "topic"]);
  await runGit(runner, directory, ["checkout", "main"]);
  await writeFile(join(directory, "README.md"), "main\\n");
  await runGit(runner, directory, ["add", "README.md"]);
  await runGit(runner, directory, ["commit", "-m", "main"]);
  const merge = await runner.run({
    cwd: directory, args: ["merge", "topic"], timeoutMs: 10_000, maxOutputBytes: 32_768,
  });
  assert.notEqual(merge.exitCode, 0);
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\\n");
  await runGit(runner, directory, ["add", "src/b.ts"]);
  await writeFile(join(directory, "later untracked.txt"), "later\\n");
  const snapshot = await inspectRepository(runner, directory);

  const status = await readStatus(runner, snapshot);

  assert.ok(status.entries.some((entry: StatusEntry) => entry.kind === "ordinary" && entry.path === "src/b.ts"));
  assert.ok(status.entries.some((entry: StatusEntry) => entry.kind === "unmerged" && entry.path === "README.md"));
  assert.ok(status.entries.some((entry: StatusEntry) => entry.kind === "untracked" && entry.path === "untracked 日本語.txt"));
  assert.ok(status.entries.some((entry: StatusEntry) => entry.kind === "untracked" && entry.path === "later untracked.txt"));
});

test("status parser recognizes a rename record", async (t) => {
  const { directory, runner } = await createRepository(t);
  await runGit(runner, directory, ["mv", "src/a.ts", "src/renamed.ts"]);
  const snapshot = await inspectRepository(runner, directory);

  const status = await readStatus(runner, snapshot);

  assert.ok(status.entries.some((entry: StatusEntry) => entry.kind === "renamed" && entry.path === "src/renamed.ts"));
});

test("bounded diff separates worktree and staged changes and filters paths", async (t) => {
  const { directory, runner } = await createRepository(t);
  await writeFile(join(directory, "README.md"), "worktree " + "x".repeat(200) + "\\n");
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\\n");
  await runGit(runner, directory, ["add", "src/a.ts"]);
  const snapshot = await inspectRepository(runner, directory);

  const worktree = await readDiff(runner, snapshot, { mode: "worktree", paths: ["README.md"], maxBytes: 32 });
  const staged = await readDiff(runner, snapshot, { mode: "staged", paths: ["src/a.ts"] });

  assert.equal(worktree.mode, "worktree");
  assert.ok(worktree.diff.length <= 32);
  assert.equal(worktree.truncated, true);
  assert.equal(worktree.bytes, Buffer.byteLength(worktree.diff));
  assert.equal(worktree.diff.includes("src/a.ts"), false);
  assert.equal(staged.mode, "staged");
  assert.equal(staged.truncated, false);
  assert.match(staged.diff, /src\/a\.ts/);
  assert.equal(staged.diff.includes("README.md"), false);
});

test("bounded diff never returns a partial UTF-8 code point after runner truncation", async (t) => {
  const directory = await temporaryDirectory(t);
  const runner = new ControlledRunner(() => result({ stdout: "€", stdoutTruncated: true }));

  const diff = await readDiff(runner, snapshotFor(directory), { mode: "worktree", maxBytes: 2 });

  assert.equal(diff.diff, "");
  assert.equal(diff.truncated, true);
  assert.equal(diff.bytes, 0);
  assert.ok(diff.bytes <= 2);
});

test("status rejects malformed porcelain records and missing ls-files terminators", async (t) => {
  const directory = await temporaryDirectory(t);
  const malformedStatus = new ControlledRunner((command) => command.args[0] === "status"
    ? result({ stdout: `${statusText()}1 ZZ N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} README.md\0` })
    : result());
  await assert.rejects(readStatus(malformedStatus, snapshotFor(directory)), /malformed Git status output/);

  const missingStatusTerminator = new ControlledRunner((command) => command.args[0] === "status"
    ? result({ stdout: statusText().slice(0, -1) }) : result());
  await assert.rejects(readStatus(missingStatusTerminator, snapshotFor(directory)), /missing NUL terminator/);

  const missingTerminator = new ControlledRunner((command) => command.args[0] === "status"
    ? result({ stdout: statusText() })
    : command.args.includes("-v") ? result({ stdout: "H README.md\0" })
    : result({ stdout: `100644 ${"a".repeat(40)} 0\tREADME.md` }));
  await assert.rejects(readStatus(missingTerminator, snapshotFor(directory)), /malformed Git output: git ls-files/);
});

test("status rejects impossible exact porcelain metadata but accepts extension headers", async (t) => {
  const directory = await temporaryDirectory(t);
  const impossible = new ControlledRunner((command) => command.args[0] === "status"
    ? result({ stdout: `${statusText()}1 UU SU.. 777777 777777 777777 ${"a".repeat(40)} ${"b".repeat(40)} README.md\0` })
    : result({ stdout: "" }));
  await assert.rejects(readStatus(impossible, snapshotFor(directory)), /malformed Git status output/);

  const extensible = new ControlledRunner((command) => command.args[0] === "status"
    ? result({ stdout: `# bridge.extension future\0${statusText()}` }) : result({ stdout: "" }));
  const status = await readStatus(extensible, snapshotFor(directory));
  assert.deepEqual(status.entries, []);
});

test("gitlink checkout HEAD participates in the worktree snapshot", async (t) => {
  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, "module"));
  let gitlinkRead = 0;
  let confirmedNestedRoot = false;
  const runner = new ControlledRunner((command) => {
    if (command.args[0] === "status") return result({ stdout: statusText() });
    if (command.args[0] === "ls-files" && command.args.includes("-v")) return result({ stdout: "H module\0" });
    if (command.args[0] === "ls-files") return result({ stdout: `160000 ${"a".repeat(40)} 0\tmodule\0` });
    if (command.args.join(" ") === "rev-parse --path-format=absolute --show-toplevel") {
      confirmedNestedRoot = true;
      return result({ stdout: `${join(directory, "module")}\n` });
    }
    if (command.args.join(" ") === "rev-parse --verify HEAD^{commit}") {
      assert.equal(confirmedNestedRoot, true);
      gitlinkRead += 1;
      return result({ stdout: `${gitlinkRead === 1 ? "b".repeat(40) : "c".repeat(40)}\n` });
    }
    throw new Error(`unexpected command: ${command.args.join(" ")}`);
  });
  const snapshot = snapshotFor(directory);

  const first = await readStatus(runner, snapshot);
  const second = await readStatus(runner, snapshot);

  assert.notEqual(first.worktree_snapshot_id, second.worktree_snapshot_id);
});

test("real gitlink uses its nested checkout and deinitialized directory never uses parent HEAD", async (t) => {
  const nested = await createRepository(t);
  await writeFile(join(nested.directory, "nested.txt"), "nested\n");
  await runGit(nested.runner, nested.directory, ["add", "nested.txt"]);
  await runGit(nested.runner, nested.directory, ["commit", "-m", "nested"]);
  const superproject = await createRepository(t);
  await runGit(superproject.runner, superproject.directory, ["-c", "protocol.file.allow=always", "submodule", "add", nested.directory, "module"]);
  await runGit(superproject.runner, superproject.directory, ["commit", "-m", "submodule"]);
  const initialized = await readStatus(superproject.runner, await inspectRepository(superproject.runner, superproject.directory));
  await runGit(superproject.runner, superproject.directory, ["submodule", "deinit", "-f", "module"]);

  const deinitialized = await readStatus(superproject.runner, await inspectRepository(superproject.runner, superproject.directory));

  assert.notEqual(initialized.worktree_snapshot_id, deinitialized.worktree_snapshot_id);
});

test("status aborts before opening an empty tracked file", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, "empty.txt"), "");
  const runner = new ControlledRunner((command) => command.args[0] === "status"
    ? result({ stdout: statusText() })
    : command.args.includes("-v") ? result({ stdout: "H empty.txt\0" })
    : result({ stdout: `100644 ${"a".repeat(40)} 0\tempty.txt\0` }));
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));

  await assert.rejects(readStatus(runner, snapshotFor(directory), controller.signal), /cancelled/);
});

test("successful diffs with diagnostics are rejected", async (t) => {
  const directory = await temporaryDirectory(t);
  const runner = new ControlledRunner(() => result({ stdout: "diff", stderr: "warning" }));

  await assert.rejects(readDiff(runner, snapshotFor(directory), { mode: "worktree" }), /Git command failed/);
});

test("gitlink control failures never become uninitialized or broken snapshots", async (t) => {
  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, "module"));
  const failures: readonly GitCommandResult[] = [
    result({ aborted: true, exitCode: null }), result({ timedOut: true, exitCode: null }),
    result({ signal: "SIGTERM", exitCode: null }), result({ stdoutTruncated: true }), result({ stderrTruncated: true }),
    result({ stderr: "diagnostic" }), result({ exitCode: null }),
  ];
  for (const phase of ["top", "head"] as const) {
    for (const failure of failures) {
      const runner = new ControlledRunner((command) => {
        if (command.args[0] === "status") return result({ stdout: statusText() });
        if (command.args[0] === "ls-files" && command.args.includes("-v")) return result({ stdout: "H module\0" });
        if (command.args[0] === "ls-files") return result({ stdout: `160000 ${"a".repeat(40)} 0\tmodule\0` });
        if (command.args.join(" ") === "rev-parse --path-format=absolute --show-toplevel") {
          return phase === "top" ? failure : result({ stdout: `${join(directory, "module")}\n` });
        }
        if (command.args.join(" ") === "rev-parse --verify HEAD^{commit}") return phase === "head" ? failure : result({ stdout: `${"b".repeat(40)}\n` });
        throw new Error("unexpected command");
      });
      await assert.rejects(readStatus(runner, snapshotFor(directory)), /Git command|Git read/);
    }
  }
});

test("status fingerprints a large tracked file without changing its read contract", async (t) => {
  const { directory, runner } = await createRepository(t);
  const large = "x".repeat(3 * 1024 * 1024);
  await writeFile(join(directory, "large.txt"), large);
  await runGit(runner, directory, ["add", "large.txt"]);
  await runGit(runner, directory, ["commit", "-m", "large"]);
  const snapshot = await inspectRepository(runner, directory);
  await writeFile(join(directory, "large.txt"), `${large}changed`);

  const status = await readStatus(runner, snapshot);

  assert.ok(status.entries.some((entry: StatusEntry) => entry.path === "large.txt"));
});

test("tracked-file hashing promptly rejects a regular-file to FIFO swap without a repository lock", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "tracked.txt");
  await writeFile(path, "regular\n");
  const expected = await lstat(path, { bigint: true });
  await unlink(path);
  const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  await Promise.race([
    assert.rejects(
      hashRegularFileForSnapshot(path, expected, createWorktreeHashBudget()),
      /regular file|changed while hashing/i,
    ),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("FIFO open blocked")), 500)),
  ]);
});

test("tracked-file hashing rejects pathname replacement and growth across descriptor reads", async (t) => {
  const directory = await temporaryDirectory(t);
  const replaced = join(directory, "replaced.txt");
  await writeFile(replaced, "before\n");
  const replacedExpected = await lstat(replaced, { bigint: true });
  await unlink(replaced);
  await writeFile(replaced, "before\n");
  await assert.rejects(
    hashRegularFileForSnapshot(replaced, replacedExpected, createWorktreeHashBudget()),
    /changed while hashing/i,
  );

  const growing = join(directory, "growing.txt");
  await writeFile(growing, "x".repeat(128 * 1024));
  const growingExpected = await lstat(growing, { bigint: true });
  let appended = false;
  await assert.rejects(hashRegularFileForSnapshot(
    growing,
    growingExpected,
    createWorktreeHashBudget(),
    undefined,
    {
      onReadChunk: async () => {
        if (appended) return;
        appended = true;
        await appendFile(growing, "growth");
      },
    },
  ), /changed while hashing|grew/i);
  assert.equal(appended, true);
});

test("tracked-file hashing checks every bounded chunk against the operation deadline", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "slow.txt");
  await writeFile(path, "x".repeat(128 * 1024));
  const expected = await lstat(path, { bigint: true });
  let now = 1_000;
  let chunks = 0;

  await assert.rejects(withDeadline(10, undefined, (signal) => hashRegularFileForSnapshot(
    path,
    expected,
    createWorktreeHashBudget(),
    signal,
    { onReadChunk: () => { chunks += 1; now += 11; } },
  ), { monotonicNow: () => now }), /deadline/i);
  assert.equal(chunks, 1);
});

test("tracked-file hashing enforces one aggregate byte budget across files", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = join(directory, "first.txt");
  const second = join(directory, "second.txt");
  await writeFile(first, "1234");
  await writeFile(second, "5678");
  const budget = createWorktreeHashBudget(7);

  assert.equal(
    await hashRegularFileForSnapshot(first, await lstat(first, { bigint: true }), budget),
    createHash("sha256").update("1234").digest("hex"),
  );
  await assert.rejects(
    hashRegularFileForSnapshot(second, await lstat(second, { bigint: true }), budget),
    /aggregate.*byte budget/i,
  );
});

test("restore proof shares one aggregate content budget across tracked and untracked files", async (t) => {
  const { directory, runner } = await createRepository(t);
  await writeFile(join(directory, "src", "a.ts"), "1234");
  await writeFile(join(directory, "outside.txt"), "5678");
  const snapshot = await inspectRepository(runner, directory);

  await assert.rejects(
    readStatusWithTrackedWorktreeProof(runner, snapshot, [], undefined, createWorktreeHashBudget(7)),
    /aggregate.*byte budget/i,
  );
});
