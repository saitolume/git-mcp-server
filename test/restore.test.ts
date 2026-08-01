import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeRejection } from "../src/domain/result.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { readStatus } from "../src/git/read.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import {
  executePreparedWorktreeRestore,
  prepareWorktreeRestore,
  restoreWorktree,
} from "../src/git/restore.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

class AbortAfterWorktreeRestoreRunner extends TrackingRunner {
  private aborted = false;

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly controller: AbortController) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.aborted && command.args[0] === "restore" && command.args[1] === "--worktree") {
      this.commands.push(command);
      const completed = await GitRunner.prototype.run.call(this, command) as GitCommandResult;
      this.aborted = true;
      this.controller.abort();
      return { ...completed, aborted: true };
    }
    return super.run(command, signal);
  }
}

class RejectAfterWorktreeRestoreRunner extends TrackingRunner {
  private rejected = false;
  readonly postMutationSignals: Array<AbortSignal | undefined> = [];

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly controller: AbortController) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "restore" && command.args[1] === "--worktree") {
      this.commands.push(command);
      await GitRunner.prototype.run.call(this, command, signal);
      this.rejected = true;
      this.controller.abort();
      throw new Error("runner rejected after the Git effect");
    }
    if (this.rejected) this.postMutationSignals.push(signal);
    return super.run(command, signal);
  }
}

class OverRestoreWorktreeRejectRunner extends TrackingRunner {
  private rejected = false;

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly extraPath: string) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "restore" && command.args[1] === "--worktree") {
      this.commands.push(command);
      await GitRunner.prototype.run.call(this, { ...command, args: [...command.args, this.extraPath] }, signal);
      this.rejected = true;
      throw new Error("runner rejected after restoring more worktree paths than requested");
    }
    return super.run(command, signal);
  }
}

class MutateUntrackedAfterWorktreeRestoreRunner extends TrackingRunner {
  private rejected = false;

  constructor(
    executable: string,
    environment: NodeJS.ProcessEnv,
    private readonly mutateOutside: () => Promise<void>,
  ) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "restore" && command.args[1] === "--worktree") {
      this.commands.push(command);
      await GitRunner.prototype.run.call(this, command, signal);
      await this.mutateOutside();
      this.rejected = true;
      throw new Error("runner rejected after changing outside untracked state");
    }
    return super.run(command, signal);
  }
}

function result(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0, ...overrides,
  };
}

class RestoreFailureRunner extends TrackingRunner {
  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly failure: GitCommandResult) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (command.args[0] === "restore" && command.args[1] === "--worktree") {
      this.commands.push(command);
      return this.failure;
    }
    return super.run(command, signal);
  }
}

class IndexModeOverrideRunner extends TrackingRunner {
  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly metadata: GitCommandResult) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (JSON.stringify(command.args) === JSON.stringify(["ls-files", "--stage", "-z", "--", "src/a.ts"])) {
      this.commands.push(command);
      return this.metadata;
    }
    return super.run(command, signal);
  }
}

class PostflightFailureRunner extends TrackingRunner {
  private restored = false;

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (this.restored && command.args[0] === "rev-parse" && command.args[1] === "--verify" && command.args[2] === "HEAD") {
      this.commands.push(command);
      return result({ exitCode: 128, stderr: "postflight unavailable\n" });
    }
    const commandResult = await super.run(command, signal);
    if (command.args[0] === "restore" && command.args[1] === "--worktree") this.restored = true;
    return commandResult;
  }
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const commandResult = await runner.run({ cwd, args, timeoutMs: 10_000, maxOutputBytes: 32_768 });
  assert.equal(commandResult.exitCode, 0, commandResult.stderr);
  return commandResult.stdout;
}

async function fixture(t: test.TestContext, Runner: typeof TrackingRunner = TrackingRunner): Promise<{
  directory: string;
  runner: TrackingRunner;
  snapshot: RepositorySnapshot;
}> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-restore-repo-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const runner = new Runner(await resolveGitExecutable(), process.env);
  await runGit(runner, directory, ["init", "--initial-branch=main"]);
  await runGit(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
  await runGit(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "a.ts"), "initial a\n");
  await writeFile(join(directory, "src", "b.ts"), "initial b\n");
  await runGit(runner, directory, ["add", "--", "src/a.ts", "src/b.ts"]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "initial"]);
  const snapshot = await inspectRepository(runner, directory);
  runner.commands.length = 0;
  return { directory, runner, snapshot };
}

async function currentStatus(runner: GitRunner, directory: string) {
  const snapshot = await inspectRepository(runner, directory);
  return { snapshot, status: await readStatus(runner, snapshot) };
}

function request(snapshot: RepositorySnapshot, worktreeSnapshotId: string, paths: readonly string[]) {
  return {
    expectedBranch: snapshot.branch ?? "main",
    expectedHead: snapshot.head,
    worktreeSnapshotId,
    paths,
  };
}

function rejection(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BridgeRejection && error.error.code === code;
}

test("worktree restore restores one tracked modification and preserves every untracked file", async (t) => {
  const { directory, runner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "modified\n");
  await writeFile(join(directory, "untracked.txt"), "keep me\n");
  await mkdir(join(directory, "untracked-dir"));
  await writeFile(join(directory, "untracked-dir", "nested.txt"), "keep nested\n");
  const { snapshot, status } = await currentStatus(runner, directory);
  runner.commands.length = 0;

  const restored = await restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"]));

  assert.deepEqual(restored.restored_paths, ["src/a.ts"]);
  assert.match(restored.worktree_snapshot_id, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "initial a\n");
  assert.equal(await readFile(join(directory, "untracked.txt"), "utf8"), "keep me\n");
  assert.equal(await readFile(join(directory, "untracked-dir", "nested.txt"), "utf8"), "keep nested\n");
  assert.equal((await currentStatus(runner, directory)).status.entries.some(({ path }) => path === "src/a.ts"), false);
});

test("worktree restore uses the current index as its only source and keeps staged content", async (t) => {
  const { directory, runner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "staged A\n");
  await runGit(runner, directory, ["add", "--", "src/a.ts"]);
  await writeFile(join(directory, "src", "a.ts"), "worktree B\n");
  const { snapshot, status } = await currentStatus(runner, directory);
  runner.commands.length = 0;

  const restored = await restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"]));

  assert.deepEqual(restored.restored_paths, ["src/a.ts"]);
  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "staged A\n");
  const after = await currentStatus(runner, directory);
  assert.deepEqual(after.status.entries.find(({ path }) => path === "src/a.ts"), {
    path: "src/a.ts", index: "M", worktree: ".", kind: "ordinary",
  });
});

test("worktree restore rejects a stale complete snapshot without mutating requested content", async (t) => {
  for (const scenario of ["content", "metadata"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, runner } = await fixture(t);
      await writeFile(join(directory, "src", "a.ts"), "requested modification\n");
      const { snapshot, status } = await currentStatus(runner, directory);
      if (scenario === "content") {
        await writeFile(join(directory, "src", "b.ts"), "unrelated changed content\n");
      } else {
        await chmod(join(directory, "src", "b.ts"), 0o755);
      }
      runner.commands.length = 0;

      await assert.rejects(
        prepareWorktreeRestore(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"])),
        rejection("UNSUPPORTED_REPOSITORY_STATE"),
      );
      assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "requested modification\n");
      assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
    });
  }
});

test("worktree restore rejects directories, symlink traversal, pathspecs, malformed paths, and deduplicates", async (t) => {
  const invalidPaths = ["src", ".", "/src/a.ts", "../src/a.ts", "src/../src/a.ts", ":!src/b.ts", "src/*.ts", "src\\a.ts"];
  for (const path of invalidPaths) {
    await t.test(path, async (t) => {
      const { directory, runner } = await fixture(t);
      await writeFile(join(directory, "src", "a.ts"), "modified\n");
      const { snapshot, status } = await currentStatus(runner, directory);
      runner.commands.length = 0;
      await assert.rejects(
        restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, [path])),
        rejection("INVALID_INPUT"),
      );
      assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
    });
  }

  await t.test("intermediate symlink", async (t) => {
    const { directory, runner } = await fixture(t);
    const outside = await mkdtemp(join(tmpdir(), "git-mcp-server-restore-outside-"));
    t.after(async () => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "a.ts"), "outside\n");
    await symlink(outside, join(directory, "linked"));
    const { snapshot, status } = await currentStatus(runner, directory);
    runner.commands.length = 0;
    await assert.rejects(
      restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["linked/a.ts"])),
      rejection("PATH_OUTSIDE_REPOSITORY"),
    );
    assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
  });

  await t.test("duplicates", async (t) => {
    const { directory, runner } = await fixture(t);
    await writeFile(join(directory, "src", "a.ts"), "modified\n");
    const { snapshot, status } = await currentStatus(runner, directory);
    runner.commands.length = 0;
    const restored = await restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts", "src/a.ts"]));
    assert.deepEqual(restored.restored_paths, ["src/a.ts"]);
    assert.deepEqual(runner.commands.find(({ args }) => args[0] === "restore")?.args, ["restore", "--worktree", "--", "src/a.ts"]);
  });
});

test("worktree restore rejects untracked, missing, staged-only, and rename-ambiguous paths", async (t) => {
  for (const scenario of ["untracked", "missing", "staged-only", "rename"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, runner } = await fixture(t);
      let path = "src/a.ts";
      if (scenario === "untracked") {
        path = "new.txt";
        await writeFile(join(directory, path), "untracked\n");
      } else if (scenario === "missing") {
        path = "missing.txt";
      } else if (scenario === "staged-only") {
        await writeFile(join(directory, path), "staged only\n");
        await runGit(runner, directory, ["add", "--", path]);
      } else {
        path = "src/renamed.ts";
        await runGit(runner, directory, ["mv", "src/a.ts", path]);
      }
      const { snapshot, status } = await currentStatus(runner, directory);
      runner.commands.length = 0;

      await assert.rejects(
        restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, [path])),
        rejection("INVALID_INPUT"),
      );
      assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
    });
  }
});

test("worktree restore restores an unstaged tracked deletion from the current index", async (t) => {
  const { directory, runner } = await fixture(t);
  await rm(join(directory, "src", "a.ts"));
  const { snapshot, status } = await currentStatus(runner, directory);
  runner.commands.length = 0;

  const restored = await restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"]));

  assert.deepEqual(restored.restored_paths, ["src/a.ts"]);
  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "initial a\n");
});

test("worktree restore rejects branch, HEAD, index, operation, and canonical identity changes", async (t) => {
  for (const scenario of ["branch", "head", "index", "operation", "identity"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, runner } = await fixture(t);
      await writeFile(join(directory, "src", "a.ts"), "modified\n");
      const { snapshot, status } = await currentStatus(runner, directory);
      const input = request(snapshot, status.worktree_snapshot_id, ["src/a.ts"]);
      let supplied = snapshot;
      if (scenario === "branch") input.expectedBranch = "other";
      if (scenario === "head") input.expectedHead = "a".repeat(40);
      if (scenario === "index") {
        await writeFile(join(directory, "src", "b.ts"), "staged change\n");
        await runGit(runner, directory, ["add", "--", "src/b.ts"]);
      }
      if (scenario === "operation") await writeFile(join(snapshot.gitDir, "MERGE_HEAD"), snapshot.head + "\n");
      if (scenario === "identity") supplied = { ...snapshot, repositoryId: "f".repeat(64) };
      runner.commands.length = 0;

      const code = scenario === "branch" ? "BRANCH_MISMATCH"
        : scenario === "head" ? "HEAD_MISMATCH"
          : scenario === "index" ? "INDEX_MISMATCH" : "UNSUPPORTED_REPOSITORY_STATE";
      await assert.rejects(restoreWorktree(runner, supplied, input), rejection(code));
      assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "modified\n");
      assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
    });
  }
});

test("worktree restore checks canonical HEAD before touching an invalid requested path", async (t) => {
  const { directory, runner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "modified\n");
  const { snapshot, status } = await currentStatus(runner, directory);
  runner.commands.length = 0;

  await assert.rejects(
    prepareWorktreeRestore(runner, snapshot, {
      ...request(snapshot, status.worktree_snapshot_id, ["../escape"]),
      expectedHead: "a".repeat(40),
    }),
    rejection("HEAD_MISMATCH"),
  );

  assert.equal(runner.commands.some(({ args }) => args.includes("../escape")), false);
  assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "modified\n");
});

test("worktree restore prepare rejects a deleted gitlink without recreating its directory", async (t) => {
  const { directory, runner, snapshot: initial } = await fixture(t);
  await mkdir(join(directory, "vendor"));
  await runGit(runner, directory, ["update-index", "--add", "--cacheinfo", `160000,${initial.head},vendor/submodule`]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "add gitlink"]);
  const { snapshot, status } = await currentStatus(runner, directory);
  assert.deepEqual(status.entries.find(({ path }) => path === "vendor/submodule"), {
    path: "vendor/submodule", index: ".", worktree: "D", kind: "ordinary",
  });
  runner.commands.length = 0;

  await assert.rejects(
    prepareWorktreeRestore(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["vendor/submodule"])),
    rejection("INVALID_INPUT"),
  );

  await assert.rejects(access(join(directory, "vendor", "submodule")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
});

test("worktree restore prepare fails closed on malformed, multiple-stage, duplicate, and extra index metadata", async (t) => {
  const object = "a".repeat(40);
  const cases: Readonly<Record<string, GitCommandResult>> = {
    malformed: result({ stdout: "garbage\0" }),
    multipleStage: result({ stdout: `100644 ${object} 1\tsrc/a.ts\u0000100644 ${object} 2\tsrc/a.ts\u0000` }),
    duplicate: result({ stdout: `100644 ${object} 0\tsrc/a.ts\u0000100644 ${object} 0\tsrc/a.ts\u0000` }),
    extra: result({ stdout: `100644 ${object} 0\tsrc/a.ts\u0000100644 ${object} 0\tsrc/b.ts\u0000` }),
    truncated: result({ stdout: `100644 ${object} 0\tsrc/a.ts\0`, stdoutTruncated: true }),
  };
  for (const [name, metadata] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const { directory, snapshot: initial } = await fixture(t);
      const baseRunner = new TrackingRunner(await resolveGitExecutable(), process.env);
      await writeFile(join(directory, "src", "a.ts"), "modified\n");
      const { snapshot, status } = await currentStatus(baseRunner, directory);
      assert.equal(snapshot.repositoryId, initial.repositoryId);
      const runner = new IndexModeOverrideRunner(await resolveGitExecutable(), process.env, metadata);

      await assert.rejects(
        prepareWorktreeRestore(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"])),
        rejection("UNSUPPORTED_REPOSITORY_STATE"),
      );
      assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
    });
  }
});

test("worktree restore exposes a coordinator-safe preflight and one-shot mutation boundary", async (t) => {
  const { directory, runner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "modified\n");
  const { snapshot, status } = await currentStatus(runner, directory);
  runner.commands.length = 0;

  const prepared = await prepareWorktreeRestore(
    runner,
    snapshot,
    request(snapshot, status.worktree_snapshot_id, ["src/a.ts", "src/a.ts"]),
  );
  assert.deepEqual(prepared.paths, ["src/a.ts"]);
  assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);
  assert.deepEqual(runner.commands.at(-3)?.args, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  assert.deepEqual(runner.commands.at(-2)?.args, ["ls-files", "--cached", "-v", "-z"]);
  assert.deepEqual(runner.commands.at(-1)?.args, ["ls-files", "--stage", "-z"]);

  runner.commands.length = 0;
  const restored = await executePreparedWorktreeRestore(runner, prepared);
  assert.deepEqual(restored.restored_paths, ["src/a.ts"]);
  assert.equal(runner.commands.filter(({ args }) => args[0] === "restore").length, 1);
  assert.deepEqual(runner.commands[0]?.args, ["restore", "--worktree", "--", "src/a.ts"]);
  assert.ok(runner.commands.slice(1).some(({ args }) => args[0] === "status"));
  await assert.rejects(executePreparedWorktreeRestore(runner, prepared), rejection("INVALID_INPUT"));
});

test("worktree restore proves its exact postflight after caller abort during mutation", async (t) => {
  const { directory, runner: setupRunner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "modified\n");
  const { snapshot, status } = await currentStatus(setupRunner, directory);
  const controller = new AbortController();
  const runner = new AbortAfterWorktreeRestoreRunner(await resolveGitExecutable(), process.env, controller);

  const restored = await restoreWorktree(
    runner,
    snapshot,
    request(snapshot, status.worktree_snapshot_id, ["src/a.ts"]),
    controller.signal,
  );

  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(restored.restored_paths, ["src/a.ts"]);
  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "initial a\n");
});

test("worktree restore reconciles an exact effect after runner rejection", async (t) => {
  const { directory, runner: setupRunner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "modified\n");
  const { snapshot, status } = await currentStatus(setupRunner, directory);
  const controller = new AbortController();
  const runner = new RejectAfterWorktreeRestoreRunner(await resolveGitExecutable(), process.env, controller);

  const restored = await restoreWorktree(
    runner,
    snapshot,
    request(snapshot, status.worktree_snapshot_id, ["src/a.ts"]),
    controller.signal,
  );

  assert.deepEqual(restored.restored_paths, ["src/a.ts"]);
  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "initial a\n");
  assert.ok(runner.postMutationSignals.length > 0);
  assert.equal(runner.postMutationSignals.every((signal) => signal === undefined), true);
  const mutationIndex = runner.commands.findIndex(({ args }) => args[0] === "restore" && args[1] === "--worktree");
  const proofCommands = runner.commands.slice(mutationIndex + 1);
  assert.ok(proofCommands.length > 0);
  assert.equal(proofCommands.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 30_000), true);
});

test("worktree restore rejects an A+B over-restore even when the requested path is restored", async (t) => {
  const { directory, runner: setupRunner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "modified a\n");
  await writeFile(join(directory, "src", "b.ts"), "modified b\n");
  const { snapshot, status } = await currentStatus(setupRunner, directory);
  const runner = new OverRestoreWorktreeRejectRunner(await resolveGitExecutable(), process.env, "src/b.ts");

  await assert.rejects(
    restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"])),
    /outside|over|unchanged/i,
  );

  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "initial a\n");
  assert.equal(await readFile(join(directory, "src", "b.ts"), "utf8"), "initial b\n");
});

test("worktree restore rejects changes to promised outside untracked state", async (t) => {
  for (const scenario of ["delete", "add", "rename", "rewrite", "symlink"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, runner: setupRunner } = await fixture(t);
      await writeFile(join(directory, "src", "a.ts"), "modified a\n");
      const outside = join(directory, "outside.txt");
      await writeFile(outside, "keep outside\n");
      const { snapshot, status } = await currentStatus(setupRunner, directory);
      const runner = new MutateUntrackedAfterWorktreeRestoreRunner(
        await resolveGitExecutable(),
        process.env,
        async () => {
          if (scenario === "delete") await rm(outside);
          if (scenario === "add") await writeFile(join(directory, "added.txt"), "added\n");
          if (scenario === "rename") await rename(outside, join(directory, "renamed.txt"));
          if (scenario === "rewrite") await writeFile(outside, "changed outside\n");
          if (scenario === "symlink") {
            await rm(outside);
            await symlink("src/b.ts", outside);
          }
        },
      );

      await assert.rejects(
        restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"])),
        /outside|untracked|unchanged/i,
      );
      assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "initial a\n");
    });
  }
});

test("worktree restore rejects forged prepared values before running Git", async (t) => {
  const { runner } = await fixture(t);
  runner.commands.length = 0;
  const forged = Object.freeze({ paths: Object.freeze(["src/a.ts"]) });

  await assert.rejects(executePreparedWorktreeRestore(runner, forged), rejection("INVALID_INPUT"));

  assert.deepEqual(runner.commands, []);
});

test("worktree restore issues the exact literal command after the final complete status read", async (t) => {
  const { directory, runner } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "modified a\n");
  await writeFile(join(directory, "src", "b.ts"), "modified b\n");
  const { snapshot, status } = await currentStatus(runner, directory);
  runner.commands.length = 0;

  await restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"]));

  const mutationIndex = runner.commands.findIndex(({ args }) => args[0] === "restore");
  assert.ok(mutationIndex > 0);
  assert.deepEqual(runner.commands[mutationIndex]?.args, ["restore", "--worktree", "--", "src/a.ts"]);
  assert.deepEqual(runner.commands[mutationIndex - 3]?.args, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  assert.deepEqual(runner.commands[mutationIndex - 2]?.args, ["ls-files", "--cached", "-v", "-z"]);
  assert.deepEqual(runner.commands[mutationIndex - 1]?.args, ["ls-files", "--stage", "-z"]);
  assert.equal(runner.commands.some(({ args }) => ["clean", "reset", "checkout"].includes(args[0] ?? "")), false);
  assert.equal(runner.commands.some(({ args }) => args[0] === "restore" && args.some((arg) => arg === "--staged" || arg.startsWith("--source"))), false);
  assert.equal(await readFile(join(directory, "src", "b.ts"), "utf8"), "modified b\n");
});

test("worktree restore treats every ambiguous mutation outcome as failure", async (t) => {
  const cases: Readonly<Record<string, GitCommandResult>> = {
    nonzero: result({ exitCode: 1, stderr: "failed\n" }),
    signal: result({ exitCode: null, signal: "SIGTERM" }),
    timeout: result({ exitCode: null, timedOut: true }),
    abort: result({ exitCode: null, aborted: true }),
    stdoutTruncated: result({ stdoutTruncated: true }),
    stderrTruncated: result({ stderrTruncated: true }),
  };
  for (const [name, failure] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-restore-failure-"));
      t.after(async () => rm(directory, { recursive: true, force: true }));
      const runner = new RestoreFailureRunner(await resolveGitExecutable(), process.env, failure);
      await runGit(runner, directory, ["init", "--initial-branch=main"]);
      await runGit(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
      await runGit(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
      await writeFile(join(directory, "a.txt"), "initial\n");
      await runGit(runner, directory, ["add", "--", "a.txt"]);
      await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "initial"]);
      await writeFile(join(directory, "a.txt"), "modified\n");
      const { snapshot, status } = await currentStatus(runner, directory);
      await assert.rejects(restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["a.txt"])));
      assert.equal(await readFile(join(directory, "a.txt"), "utf8"), "modified\n");
    });
  }
});

test("worktree restore refuses to claim success when postflight proof is unavailable", async (t) => {
  const { directory, runner } = await fixture(t, PostflightFailureRunner);
  await writeFile(join(directory, "src", "a.ts"), "modified\n");
  const { snapshot, status } = await currentStatus(runner, directory);
  runner.commands.length = 0;

  await assert.rejects(restoreWorktree(runner, snapshot, request(snapshot, status.worktree_snapshot_id, ["src/a.ts"])));

  assert.equal(await readFile(join(directory, "src", "a.ts"), "utf8"), "initial a\n");
  assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), true);
});
