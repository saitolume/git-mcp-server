import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { relativeGitPath } from "../src/domain/inputs.js";
import { BridgeRejection } from "../src/domain/result.js";
import {
  executePreparedSwitchAttach, prepareSwitchAttach, preparedSwitchAttachObservation, switchAttach,
  executePreparedSwitchCreate, prepareSwitchCreate, preparedSwitchCreateObservation, switchCreate,
} from "../src/git/branch.js";
import { prepareCommit } from "../src/git/commit.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";
import {
  addPaths, executePreparedAddPaths, executePreparedRestoreStaged, prepareAddPaths,
  prepareRestoreStaged, preparedAddObservation, preparedRestoreStagedObservation, restoreStaged,
} from "../src/git/stage.js";
import { initializeStatePaths, resolveStatePaths } from "../src/state/paths.js";
import type { StatePaths } from "../src/state/paths.js";
import type { StageRecord } from "../src/state/records.js";
import { SessionStore } from "../src/state/session-store.js";

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

class AbortAfterMutationRunner extends TrackingRunner {
  private aborted = false;

  constructor(
    executable: string,
    environment: NodeJS.ProcessEnv,
    private readonly controller: AbortController,
    private readonly isMutation: (command: GitCommand) => boolean,
  ) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.aborted && this.isMutation(command)) {
      this.commands.push(command);
      const completed = await GitRunner.prototype.run.call(this, command) as GitCommandResult;
      this.aborted = true;
      this.controller.abort();
      return { ...completed, aborted: true };
    }
    return super.run(command, signal);
  }
}

class RejectAfterMutationRunner extends TrackingRunner {
  private rejected = false;
  readonly postMutationSignals: Array<AbortSignal | undefined> = [];

  constructor(
    executable: string,
    environment: NodeJS.ProcessEnv,
    private readonly controller: AbortController,
    private readonly isMutation: (command: GitCommand) => boolean,
  ) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && this.isMutation(command)) {
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

class DeleteTargetBeforeSwitchRunner extends TrackingRunner {
  private changed = false;

  constructor(
    executable: string,
    environment: NodeJS.ProcessEnv,
    private readonly branch: string,
    private readonly head: string,
  ) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.changed && (JSON.stringify(command.args) === JSON.stringify(["switch", this.branch])
      || JSON.stringify(command.args) === JSON.stringify(["switch", "--no-guess", this.branch]))) {
      this.changed = true;
      await GitRunner.prototype.run.call(this, {
        ...command, args: ["update-ref", "-d", `refs/heads/${this.branch}`],
      }, signal);
      await GitRunner.prototype.run.call(this, {
        ...command, args: ["update-ref", `refs/remotes/origin/${this.branch}`, this.head],
      }, signal);
    }
    return super.run(command, signal);
  }
}

class WorktreeListOverrideRunner extends TrackingRunner {
  constructor(
    executable: string,
    environment: NodeJS.ProcessEnv,
    private readonly worktreeList: GitCommandResult,
  ) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (JSON.stringify(command.args) === JSON.stringify(["worktree", "list", "--porcelain", "-z"])) {
      this.commands.push(command);
      return this.worktreeList;
    }
    return super.run(command, signal);
  }
}

class PartialAddRejectRunner extends TrackingRunner {
  private rejected = false;

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "add") {
      this.commands.push(command);
      const firstPath = command.args.at(2);
      assert.ok(firstPath);
      await GitRunner.prototype.run.call(this, { ...command, args: ["add", "--", firstPath] }, signal);
      this.rejected = true;
      throw new Error("runner rejected after staging only the first requested path");
    }
    return super.run(command, signal);
  }
}

class AddUnexpectedPathRejectRunner extends TrackingRunner {
  private rejected = false;

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly unexpectedPath: string) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "add") {
      this.commands.push(command);
      await GitRunner.prototype.run.call(
        this,
        { ...command, args: [...command.args, this.unexpectedPath] },
        signal,
      );
      this.rejected = true;
      throw new Error("runner rejected after staging an unrequested path");
    }
    return super.run(command, signal);
  }
}

class RejectWithoutAddEffectRunner extends TrackingRunner {
  private rejected = false;

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "add") {
      this.commands.push(command);
      this.rejected = true;
      throw new Error("runner rejected without changing the index");
    }
    return super.run(command, signal);
  }
}

class OverRestoreStagedRejectRunner extends TrackingRunner {
  private rejected = false;

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly extraPath: string) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "restore" && command.args[1] === "--staged") {
      this.commands.push(command);
      await GitRunner.prototype.run.call(this, { ...command, args: [...command.args, this.extraPath] }, signal);
      this.rejected = true;
      throw new Error("runner rejected after restoring more staged paths than requested");
    }
    return super.run(command, signal);
  }
}

class AlterRemainingStagedRejectRunner extends TrackingRunner {
  private rejected = false;

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly remainingPath: string) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "restore" && command.args[1] === "--staged") {
      this.commands.push(command);
      await GitRunner.prototype.run.call(this, command, signal);
      await GitRunner.prototype.run.call(this, {
        cwd: command.cwd,
        args: ["add", "--", this.remainingPath],
        timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes,
      }, signal);
      this.rejected = true;
      throw new Error("runner rejected after altering a remaining staged representation");
    }
    return super.run(command, signal);
  }
}

class RestoreThenRestageRejectRunner extends TrackingRunner {
  private rejected = false;

  constructor(
    executable: string,
    environment: NodeJS.ProcessEnv,
    private readonly restagePath: string,
    private readonly extraRestorePath?: string,
  ) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.rejected && command.args[0] === "restore" && command.args[1] === "--staged") {
      this.commands.push(command);
      await GitRunner.prototype.run.call(this, {
        ...command,
        args: this.extraRestorePath === undefined ? command.args : [...command.args, this.extraRestorePath],
      }, signal);
      await GitRunner.prototype.run.call(this, {
        cwd: command.cwd,
        args: ["add", "--", this.restagePath],
        timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes,
      }, signal);
      this.rejected = true;
      throw new Error("runner rejected after producing a mismatched restore and altered representation");
    }
    return super.run(command, signal);
  }
}

const stagedDeltaArgs = ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"];

class DeltaOverrideRunner extends TrackingRunner {
  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly delta: GitCommandResult) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (JSON.stringify(command.args) === JSON.stringify(stagedDeltaArgs)) {
      this.commands.push(command);
      return this.delta;
    }
    return super.run(command, signal);
  }
}

class HeadMetadataOverrideRunner extends TrackingRunner {
  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly metadata: GitCommandResult) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (command.args[0] === "ls-tree") {
      this.commands.push(command);
      return this.metadata;
    }
    return super.run(command, signal);
  }
}

function commandResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0, ...overrides,
  };
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 10_000, maxOutputBytes: 32_768 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

async function fixture(t: test.TestContext): Promise<{
  directory: string;
  runner: TrackingRunner;
  sessions: SessionStore;
  statePaths: StatePaths;
  snapshot: RepositorySnapshot;
}> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-stage-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-stage-state-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  });
  const runner = new TrackingRunner(await resolveGitExecutable(), process.env);
  await runGit(runner, directory, ["init", "--initial-branch=main"]);
  await runGit(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
  await runGit(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 1;\n");
  await runGit(runner, directory, ["add", "--", "src/a.ts", "src/b.ts"]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "initial"]);
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const snapshot = await inspectRepository(runner, directory);
  runner.commands.length = 0;
  return { directory, runner, sessions: new SessionStore(paths), statePaths: paths, snapshot };
}

function rejection(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BridgeRejection && error.error.code === code;
}

test("switch create creates only a new branch from the exact clean HEAD", async (t) => {
  const { runner, sessions, snapshot } = await fixture(t);
  const result = await switchCreate(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, branch: "topic/task-8",
  });

  assert.deepEqual(result, { branch: "topic/task-8", head: snapshot.head });
  assert.ok(runner.commands.some(({ args }) => JSON.stringify(args) === JSON.stringify(["check-ref-format", "--branch", "topic/task-8"])));
  const switchIndex = runner.commands.findIndex(({ args }) => JSON.stringify(args) === JSON.stringify(["switch", "-c", "topic/task-8"]));
  assert.ok(switchIndex > 0);
  assert.deepEqual(runner.commands[switchIndex - 2]?.args, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  assert.deepEqual(runner.commands[switchIndex - 1]?.args, ["ls-files", "--stage", "-z"]);
});

test("switch create accepts only an exact clean detached HEAD precondition", async (t) => {
  await t.test("creates a branch from detached HEAD", async (t) => {
    const { directory, runner, sessions } = await fixture(t);
    await runGit(runner, directory, ["checkout", "--detach"]);
    const detached = await inspectRepository(runner, directory);
    runner.commands.length = 0;

    const result = await switchCreate(runner, sessions, detached, {
      expectedBranch: null, expectedHead: detached.head, branch: "topic/detached",
    });

    assert.deepEqual(result, { branch: "topic/detached", head: detached.head });
    assert.equal((await inspectRepository(runner, directory)).branch, "topic/detached");
  });

  for (const scenario of ["attached-null", "detached-string", "head-mismatch", "dirty"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, runner, sessions, snapshot } = await fixture(t);
      let current = snapshot;
      let expectedBranch: string | null = null;
      let expectedHead = snapshot.head;
      let expectedCode = "BRANCH_MISMATCH";
      if (scenario !== "attached-null") {
        await runGit(runner, directory, ["checkout", "--detach"]);
        current = await inspectRepository(runner, directory);
      }
      if (scenario === "detached-string") expectedBranch = "main";
      if (scenario === "head-mismatch") {
        expectedHead = "0".repeat(40);
        expectedCode = "HEAD_MISMATCH";
      }
      if (scenario === "dirty") {
        await writeFile(join(directory, "src", "a.ts"), "dirty\n");
        expectedCode = "UNSUPPORTED_REPOSITORY_STATE";
      }
      runner.commands.length = 0;

      await assert.rejects(switchCreate(runner, sessions, current, {
        expectedBranch, expectedHead, branch: `topic/${scenario}`,
      }), rejection(expectedCode));
      assert.equal(runner.commands.some(({ args }) => args[0] === "switch"), false);
    });
  }
});

test("switch create proves exact state after caller abort during mutation", async (t) => {
  const { sessions, snapshot } = await fixture(t);
  const controller = new AbortController();
  const runner = new AbortAfterMutationRunner(
    await resolveGitExecutable(), process.env, controller, ({ args }) => args[0] === "switch",
  );

  const created = await switchCreate(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, branch: "topic/abort-proof",
  }, controller.signal);

  assert.deepEqual(created, { branch: "topic/abort-proof", head: snapshot.head });
  assert.equal(controller.signal.aborted, true);
});

test("switch create reconciles an exact effect after runner rejection", async (t) => {
  const { sessions, snapshot } = await fixture(t);
  const controller = new AbortController();
  const runner = new RejectAfterMutationRunner(
    await resolveGitExecutable(), process.env, controller, ({ args }) => args[0] === "switch",
  );

  const created = await switchCreate(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, branch: "topic/reject-proof",
  }, controller.signal);

  assert.deepEqual(created, { branch: "topic/reject-proof", head: snapshot.head });
  assert.equal(controller.signal.aborted, true);
  assert.ok(runner.postMutationSignals.length > 0);
  assert.equal(runner.postMutationSignals.every((signal) => signal === undefined), true);
});

test("switch create prepare authority is opaque, one-shot, and rejects before mutation", async (t) => {
  const { runner, sessions, snapshot } = await fixture(t);
  await assert.rejects(prepareSwitchCreate(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, branch: "bad..branch",
  }), rejection("INVALID_INPUT"));
  assert.equal(runner.commands.some(({ args }) => args[0] === "switch"), false);

  const prepared = await prepareSwitchCreate(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, branch: "topic/phased",
  });
  assert.deepEqual(preparedSwitchCreateObservation(prepared), {
    branch: "main", head: snapshot.head, index_tree: snapshot.indexTree, new_branch: "topic/phased",
  });
  const result = await executePreparedSwitchCreate(runner, prepared);
  assert.deepEqual(result, { branch: "topic/phased", head: snapshot.head });
  await assert.rejects(executePreparedSwitchCreate(runner, prepared), rejection("INVALID_INPUT"));
  await assert.rejects(
    executePreparedSwitchCreate(runner, Object.freeze({ branch: "forged" })),
    rejection("INVALID_INPUT"),
  );
});

test("switch create rejects invalid, existing, dirty, and untracked states before switch", async (t) => {
  for (const scenario of ["invalid", "existing", "dirty", "untracked"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, runner, sessions, snapshot } = await fixture(t);
      let branch = "topic";
      if (scenario === "invalid") branch = "bad..branch";
      if (scenario === "existing") await runGit(runner, directory, ["branch", branch]);
      if (scenario === "dirty") await writeFile(join(directory, "src", "a.ts"), "dirty\n");
      if (scenario === "untracked") await writeFile(join(directory, "untracked.txt"), "dirty\n");
      runner.commands.length = 0;

      await assert.rejects(
        switchCreate(runner, sessions, snapshot, { expectedBranch: "main", expectedHead: snapshot.head, branch }),
        rejection(scenario === "invalid" || scenario === "existing" ? "INVALID_INPUT" : "UNSUPPORTED_REPOSITORY_STATE"),
      );
      assert.equal(runner.commands.some(({ args }) => args[0] === "switch"), false);
    });
  }
});

test("switch attach checks out only an existing same-HEAD branch from a clean detached worktree", async (t) => {
  const { directory, runner, sessions } = await fixture(t);
  await runGit(runner, directory, ["branch", "claimed/topic"]);
  await runGit(runner, directory, ["checkout", "--detach"]);
  const detached = await inspectRepository(runner, directory);
  runner.commands.length = 0;

  const result = await switchAttach(runner, sessions, detached, {
    expectedBranch: null,
    expectedHead: detached.head,
    branch: "claimed/topic",
    expectedBranchHead: detached.head,
  });

  assert.deepEqual(result, { branch: "claimed/topic", head: detached.head });
  const mutation = runner.commands.filter(({ args }) => args[0] === "switch");
  assert.deepEqual(mutation.map(({ args }) => args), [["switch", "--no-guess", "claimed/topic"]]);
  assert.equal(runner.commands.some(({ args }) => args.includes("-c") || args.includes("--force") || args[0] === "reset"), false);
  const after = await inspectRepository(runner, directory);
  assert.equal(after.branch, "claimed/topic");
  assert.equal(after.head, detached.head);
});

test("switch attach rejects every stale, dirty, active, missing, unequal, or claimed state before switch", async (t) => {
  const scenarios = [
    "attached", "head-mismatch", "invalid-target", "missing-target", "target-head-mismatch",
    "unequal-heads", "dirty", "untracked", "operation", "active-session", "other-worktree",
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario, async (t) => {
      const { directory, runner, sessions, snapshot } = await fixture(t);
      const branch = scenario === "invalid-target" ? "refs/heads/claimed" : `claimed/${scenario}`;
      let expectedBranchHead = snapshot.head;
      if (scenario !== "invalid-target" && scenario !== "missing-target") {
        await runGit(runner, directory, ["branch", branch]);
      }
      if (scenario === "unequal-heads") {
        await runGit(runner, directory, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "advance current"]);
      }
      if (scenario !== "attached") await runGit(runner, directory, ["checkout", "--detach"]);
      let current = await inspectRepository(runner, directory);
      let expectedHead = current.head;
      if (scenario === "head-mismatch") expectedHead = "0".repeat(40);
      if (scenario === "target-head-mismatch") expectedBranchHead = "0".repeat(40);
      if (scenario === "dirty") await writeFile(join(directory, "src", "a.ts"), "dirty\n");
      if (scenario === "untracked") await writeFile(join(directory, "untracked.txt"), "dirty\n");
      if (scenario === "operation") {
        await writeFile(join(directory, ".git", "MERGE_HEAD"), current.head);
        current = await inspectRepository(runner, directory);
      }
      if (scenario === "active-session") {
        await sessions.createStageSession({
          kind: "stage", stageId: "active-attach", repositoryId: current.repositoryId,
          branch: "main", baseHead: current.head, initialIndexTree: current.indexTree,
          currentIndexTree: current.indexTree, ownedPaths: [],
          createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
        });
      }
      if (scenario === "other-worktree") {
        const other = `${directory}-other`;
        t.after(async () => rm(other, { recursive: true, force: true }));
        await runGit(runner, directory, ["worktree", "add", other, branch]);
      }
      runner.commands.length = 0;

      const expectedCode = scenario === "attached" ? "BRANCH_MISMATCH"
        : scenario === "head-mismatch" || scenario === "target-head-mismatch" || scenario === "unequal-heads"
          ? "HEAD_MISMATCH"
          : scenario === "invalid-target" || scenario === "missing-target"
            ? "INVALID_INPUT"
            : scenario === "active-session" ? "SESSION_MISMATCH" : "UNSUPPORTED_REPOSITORY_STATE";
      await assert.rejects(switchAttach(runner, sessions, current, {
        expectedBranch: null, expectedHead, branch, expectedBranchHead,
      }), rejection(expectedCode));
      assert.equal(runner.commands.some(({ args }) => args[0] === "switch"), false);
      assert.equal((await inspectRepository(runner, directory)).head, current.head);
    });
  }
});

test("switch attach prepare authority is exact, observable, and one-shot", async (t) => {
  const { directory, runner, sessions } = await fixture(t);
  await runGit(runner, directory, ["branch", "claimed/phased"]);
  await runGit(runner, directory, ["checkout", "--detach"]);
  const detached = await inspectRepository(runner, directory);
  runner.commands.length = 0;

  const prepared = await prepareSwitchAttach(runner, sessions, detached, {
    expectedBranch: null,
    expectedHead: detached.head,
    branch: "claimed/phased",
    expectedBranchHead: detached.head,
  });
  assert.deepEqual(preparedSwitchAttachObservation(prepared), {
    branch: null,
    head: detached.head,
    index_tree: detached.indexTree,
    target_branch: "claimed/phased",
    target_head: detached.head,
  });
  assert.deepEqual(await executePreparedSwitchAttach(runner, prepared), {
    branch: "claimed/phased",
    head: detached.head,
  });
  await assert.rejects(executePreparedSwitchAttach(runner, prepared), rejection("INVALID_INPUT"));
  await assert.rejects(
    executePreparedSwitchAttach(runner, Object.freeze({ branch: "forged" })),
    rejection("INVALID_INPUT"),
  );
});

test("switch attach reconciles the exact effect after caller abort or runner rejection", async (t) => {
  for (const scenario of ["abort", "reject"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, sessions } = await fixture(t);
      const setup = new TrackingRunner(await resolveGitExecutable(), process.env);
      await runGit(setup, directory, ["branch", `claimed/${scenario}`]);
      await runGit(setup, directory, ["checkout", "--detach"]);
      const detached = await inspectRepository(setup, directory);
      const controller = new AbortController();
      const runner = scenario === "abort"
        ? new AbortAfterMutationRunner(
          await resolveGitExecutable(), process.env, controller,
          ({ args }) => JSON.stringify(args) === JSON.stringify(["switch", "--no-guess", `claimed/${scenario}`]),
        )
        : new RejectAfterMutationRunner(
          await resolveGitExecutable(), process.env, controller,
          ({ args }) => JSON.stringify(args) === JSON.stringify(["switch", "--no-guess", `claimed/${scenario}`]),
        );

      const result = await switchAttach(runner, sessions, detached, {
        expectedBranch: null,
        expectedHead: detached.head,
        branch: `claimed/${scenario}`,
        expectedBranchHead: detached.head,
      }, controller.signal);

      assert.deepEqual(result, { branch: `claimed/${scenario}`, head: detached.head });
      assert.equal(controller.signal.aborted, true);
      if (runner instanceof RejectAfterMutationRunner) {
        assert.ok(runner.postMutationSignals.length > 0);
        assert.equal(runner.postMutationSignals.every((signal) => signal === undefined), true);
      }
    });
  }
});

test("switch attach never guesses a deleted local branch from a same-name remote-tracking ref", async (t) => {
  const { directory, sessions } = await fixture(t);
  const setup = new TrackingRunner(await resolveGitExecutable(), process.env);
  const branch = "claimed/no-guess";
  await runGit(setup, directory, ["remote", "add", "origin", "https://example.invalid/repository.git"]);
  await runGit(setup, directory, ["branch", branch]);
  await runGit(setup, directory, ["checkout", "--detach"]);
  const detached = await inspectRepository(setup, directory);
  const runner = new DeleteTargetBeforeSwitchRunner(
    await resolveGitExecutable(), process.env, branch, detached.head,
  );

  await assert.rejects(switchAttach(runner, sessions, detached, {
    expectedBranch: null,
    expectedHead: detached.head,
    branch,
    expectedBranchHead: detached.head,
  }), /did not complete successfully/);

  const local = await runner.run({
    cwd: directory,
    args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    timeoutMs: 10_000,
    maxOutputBytes: 32_768,
  });
  assert.equal(local.exitCode, 1);
  assert.ok(runner.commands.some(
    ({ args }) => JSON.stringify(args) === JSON.stringify(["switch", "--no-guess", branch]),
  ));
});

test("switch attach rejects malformed complete worktree ownership proofs before mutation", async (t) => {
  const malformed = [
    "worktree /fixture\0HEAD " + "a".repeat(40) + "\0",
    "worktree /fixture\0HEAD " + "a".repeat(40) + "\0detached\0branch refs/heads/other\0\0",
    "worktree /fixture\0HEAD invalid\0detached\0\0",
    "worktree /fixture\0HEAD " + "a".repeat(40) + "\0branch refs/heads/one\0branch refs/heads/two\0\0",
    "unknown value\0\0",
  ];
  for (const [index, stdout] of malformed.entries()) {
    await t.test(String(index), async (t) => {
      const { directory, sessions } = await fixture(t);
      const setup = new TrackingRunner(await resolveGitExecutable(), process.env);
      const branch = `claimed/malformed-${index}`;
      await runGit(setup, directory, ["branch", branch]);
      await runGit(setup, directory, ["checkout", "--detach"]);
      const detached = await inspectRepository(setup, directory);
      const runner = new WorktreeListOverrideRunner(
        await resolveGitExecutable(),
        process.env,
        commandResult({ stdout }),
      );

      await assert.rejects(switchAttach(runner, sessions, detached, {
        expectedBranch: null,
        expectedHead: detached.head,
        branch,
        expectedBranchHead: detached.head,
      }), rejection("UNSUPPORTED_REPOSITORY_STATE"));
      assert.equal(runner.commands.some(({ args }) => args[0] === "switch"), false);
    });
  }
});

test("stage session adds deduplicated explicit paths and supports additional add", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const first = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts", "src/a.ts"],
  });
  assert.equal(first.mode, "stage");
  assert.match(first.stage_id ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(first.staged_paths, ["src/a.ts"]);
  assert.deepEqual(first.unresolved_paths, []);
  assert.ok(runner.commands.some(({ args }) => JSON.stringify(args) === JSON.stringify(["add", "--", "src/a.ts"])));

  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  const current = await inspectRepository(runner, directory);
  const additional = await addPaths(runner, sessions, current, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/b.ts"], stageId: first.stage_id!,
  });
  assert.equal(additional.stage_id, first.stage_id);
  assert.deepEqual(additional.staged_paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual((await sessions.getStage(first.stage_id!))?.ownedPaths, ["src/a.ts", "src/b.ts"]);
});

test("stage add proves untracked, content, executable, symlink, and deletion representations in one batch", async (t) => {
  const { directory, runner, sessions } = await fixture(t);
  await symlink("a.ts", join(directory, "src", "link.ts"));
  await runGit(runner, directory, ["add", "--", "src/link.ts"]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "add symlink"]);
  const snapshot = await inspectRepository(runner, directory);

  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await chmod(join(directory, "src", "a.ts"), 0o755);
  await unlink(join(directory, "src", "b.ts"));
  await unlink(join(directory, "src", "link.ts"));
  await symlink("b.ts", join(directory, "src", "link.ts"));
  await writeFile(join(directory, "src", "new.ts"), "export const added = true;\n");
  runner.commands.length = 0;

  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    paths: ["src/a.ts", "src/b.ts", "src/link.ts", "src/new.ts"],
  });

  assert.deepEqual(added.staged_paths, ["src/a.ts", "src/b.ts", "src/link.ts", "src/new.ts"]);
  const index = await runGit(runner, directory, ["ls-files", "--stage"]);
  assert.match(index, /^100755 [0-9a-f]+ 0\tsrc\/a\.ts$/m);
  assert.doesNotMatch(index, /src\/b\.ts$/m);
  assert.match(index, /^120000 [0-9a-f]+ 0\tsrc\/link\.ts$/m);
  assert.match(index, /^100644 [0-9a-f]+ 0\tsrc\/new\.ts$/m);
  await runGit(runner, directory, [
    "diff-files", "--quiet", "--no-ext-diff", "--ignore-submodules=dirty", "--",
    "src/a.ts", "src/b.ts", "src/link.ts", "src/new.ts",
  ]);
});

test("stage add proves the index and persists its session after caller abort during mutation", async (t) => {
  const { directory, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const controller = new AbortController();
  const runner = new AbortAfterMutationRunner(
    await resolveGitExecutable(), process.env, controller, ({ args }) => args[0] === "add",
  );

  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  }, controller.signal);

  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(added.staged_paths, ["src/a.ts"]);
  assert.deepEqual((await sessions.getStage(added.stage_id!))?.ownedPaths, ["src/a.ts"]);
});

test("stage add reconciles its session after runner rejection", async (t) => {
  const { directory, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const controller = new AbortController();
  const runner = new RejectAfterMutationRunner(
    await resolveGitExecutable(), process.env, controller, ({ args }) => args[0] === "add",
  );

  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  }, controller.signal);

  assert.deepEqual(added.staged_paths, ["src/a.ts"]);
  assert.ok(added.stage_id);
  assert.deepEqual((await sessions.getStage(added.stage_id))?.ownedPaths, ["src/a.ts"]);
  assert.ok(runner.postMutationSignals.length > 0);
  assert.equal(runner.postMutationSignals.every((signal) => signal === undefined), true);
  const mutationIndex = runner.commands.findIndex(({ args }) => args[0] === "add");
  const proofCommands = runner.commands.slice(mutationIndex + 1);
  assert.ok(proofCommands.length > 0);
  assert.equal(proofCommands.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 30_000), true);
});

test("stage add rejects a partial requested-path effect and reconciles only the proven ownership", async (t) => {
  const { directory, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  const runner = new PartialAddRejectRunner(await resolveGitExecutable(), process.env);

  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts", "src/b.ts"],
  }), /exactly match|requested path/i);

  assert.equal(await runGit(runner, directory, ["diff", "--cached", "--name-only"]), "src/a.ts\n");
  const active = await sessions.getActiveSession(snapshot.repositoryId);
  assert.equal(active?.sessionKind, "stage");
  assert.deepEqual((await sessions.getStage(active!.sessionId))?.ownedPaths, ["src/a.ts"]);
});

test("stage add rejects an index effect outside previous ownership and requested paths", async (t) => {
  const { directory, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  const runner = new AddUnexpectedPathRejectRunner(await resolveGitExecutable(), process.env, "src/b.ts");

  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  }), /outside|unrequested/i);

  assert.equal(await sessions.getActiveSession(snapshot.repositoryId), null);
  assert.equal(await runGit(runner, directory, ["diff", "--cached", "--name-only"]), "src/a.ts\nsrc/b.ts\n");
});

test("stage add accepts a proven no-op after runner rejection", async (t) => {
  const { sessions, snapshot } = await fixture(t);
  const runner = new RejectWithoutAddEffectRunner(await resolveGitExecutable(), process.env);

  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });

  assert.deepEqual(added, {
    mode: "stage", stage_id: null, merge_session_id: null, index_tree: snapshot.indexTree,
    staged_paths: [], unresolved_paths: [],
  });
  await sessions.assertNoActiveSession(snapshot.repositoryId);
});

test("stage add prepare rejects invalid path/session/index and corrected authority executes once", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  for (const request of [
    { expectedBranch: "main", expectedHead: snapshot.head, paths: ["src"], stageId: undefined },
    { expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"], stageId: "missing" },
  ]) {
    await assert.rejects(prepareAddPaths(runner, sessions, snapshot, {
      expectedBranch: request.expectedBranch,
      expectedHead: request.expectedHead,
      paths: request.paths,
      ...(request.stageId === undefined ? {} : { stageId: request.stageId }),
    }), rejection(request.stageId === undefined ? "INVALID_INPUT" : "SESSION_NOT_FOUND"));
    assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
  }

  const prepared = await prepareAddPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  assert.deepEqual(preparedAddObservation(prepared), {
    mode: "stage", branch: "main", head: snapshot.head, index_tree: snapshot.indexTree,
    stage_id: null, paths: ["src/a.ts"], staged_paths: [],
  });
  const result = await executePreparedAddPaths(runner, sessions, prepared);
  assert.deepEqual(result.staged_paths, ["src/a.ts"]);
  await assert.rejects(executePreparedAddPaths(runner, sessions, prepared), rejection("INVALID_INPUT"));
});

test("stage session restores only owned paths and consumes the empty session", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  const current = await inspectRepository(runner, directory);
  const restored = await restoreStaged(runner, sessions, current, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  });

  assert.deepEqual(restored, { stage_id: null, index_tree: snapshot.indexTree, remaining_paths: [] });
  assert.equal(await sessions.getStage(added.stage_id!), null);
  assert.ok(runner.commands.some(({ args }) => JSON.stringify(args) === JSON.stringify(["restore", "--staged", "--source=HEAD", "--", "src/a.ts"])));
});

test("stage path policy stages and restores an initialized indexed gitlink", async (t) => {
  const { directory, runner, sessions } = await fixture(t);
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
  runner.commands.length = 0;

  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["module"],
  });
  assert.deepEqual(added.staged_paths, ["module"]);
  assert.deepEqual(runner.commands.find(({ args }) => args[0] === "add")?.args, ["add", "--", "module"]);

  const staged = await inspectRepository(runner, directory);
  const restored = await restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["module"],
  });
  assert.deepEqual(restored.remaining_paths, []);
});

test("stage path policy keeps a missing indexed gitlink fail closed", async (t) => {
  const { directory, runner, sessions } = await fixture(t);
  const module = join(directory, "module");
  await mkdir(module);
  await runGit(runner, module, ["init", "--initial-branch=main"]);
  await runGit(runner, module, ["config", "user.name", "git-mcp-server Nested Test"]);
  await runGit(runner, module, ["config", "user.email", "nested@example.test"]);
  await writeFile(join(module, "nested.txt"), "nested\n");
  await runGit(runner, module, ["add", "--", "nested.txt"]);
  await runGit(runner, module, ["commit", "--no-gpg-sign", "-m", "nested"]);
  const nestedHead = (await runGit(runner, module, ["rev-parse", "HEAD"])).trim();
  await runGit(runner, directory, ["update-index", "--add", "--cacheinfo", `160000,${nestedHead},module`]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "add gitlink"]);
  const snapshot = await inspectRepository(runner, directory);
  await rm(module, { recursive: true, force: true });
  runner.commands.length = 0;

  await assert.rejects(prepareAddPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["module"],
  }), rejection("INVALID_INPUT"));
  assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
});

test("stage path policy rejects a FIFO special node before Git", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  const path = join(directory, "src", "a.ts");
  await unlink(path);
  const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  runner.commands.length = 0;

  await assert.rejects(prepareAddPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  }), rejection("INVALID_INPUT"));
  assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
});

test("restore-staged proves the index and cleans its session after caller abort during mutation", async (t) => {
  const { directory, runner: setupRunner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const added = await addPaths(setupRunner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  const staged = await inspectRepository(setupRunner, directory);
  const controller = new AbortController();
  const runner = new AbortAfterMutationRunner(
    await resolveGitExecutable(), process.env, controller,
    ({ args }) => args[0] === "restore" && args[1] === "--staged",
  );

  const restored = await restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  }, controller.signal);

  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(restored.remaining_paths, []);
  assert.equal(await sessions.getStage(added.stage_id!), null);
});

test("restore-staged reconciles session cleanup after runner rejection", async (t) => {
  const { directory, runner: setupRunner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const added = await addPaths(setupRunner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  const staged = await inspectRepository(setupRunner, directory);
  const controller = new AbortController();
  const runner = new RejectAfterMutationRunner(
    await resolveGitExecutable(), process.env, controller,
    ({ args }) => args[0] === "restore" && args[1] === "--staged",
  );

  const restored = await restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  }, controller.signal);

  assert.deepEqual(restored.remaining_paths, []);
  assert.equal(await sessions.getStage(added.stage_id!), null);
  assert.ok(runner.postMutationSignals.length > 0);
  assert.equal(runner.postMutationSignals.every((signal) => signal === undefined), true);
  const mutationIndex = runner.commands.findIndex(({ args }) => args[0] === "restore" && args[1] === "--staged");
  const proofCommands = runner.commands.slice(mutationIndex + 1);
  assert.ok(proofCommands.length > 0);
  assert.equal(proofCommands.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 30_000), true);
});

test("restore-staged rejects and reconciles an over-restore beyond the requested set", async (t) => {
  const { directory, runner: setupRunner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  const added = await addPaths(setupRunner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts", "src/b.ts"],
  });
  const staged = await inspectRepository(setupRunner, directory);
  const runner = new OverRestoreStagedRejectRunner(await resolveGitExecutable(), process.env, "src/b.ts");

  await assert.rejects(restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  }), /exact remaining|over|requested/i);

  assert.equal(await sessions.getStage(added.stage_id!), null);
  assert.equal(await sessions.getActiveSession(snapshot.repositoryId), null);
});

test("restore-staged rejects when an unrequested owned index representation changes", async (t) => {
  const { directory, runner: setupRunner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  const added = await addPaths(setupRunner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts", "src/b.ts"],
  });
  const staged = await inspectRepository(setupRunner, directory);
  await writeFile(join(directory, "src", "b.ts"), "export const b = 3;\n");
  const runner = new AlterRemainingStagedRejectRunner(await resolveGitExecutable(), process.env, "src/b.ts");

  await assert.rejects(restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  }), /representation|outside|unchanged/i);

  assert.equal(await runGit(setupRunner, directory, ["show", ":src/b.ts"]), "export const b = 3;\n");
  assert.equal((await sessions.getStage(added.stage_id!))?.currentIndexTree, staged.indexTree);
  const altered = await inspectRepository(setupRunner, directory);
  await assert.rejects(restoreStaged(runner, sessions, altered, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/b.ts"],
  }), rejection("INDEX_MISMATCH"));
});

test("restore-staged path-set mismatch never adopts an altered unrequested survivor", async (t) => {
  const { directory, runner: setupRunner, sessions } = await fixture(t);
  await writeFile(join(directory, "src", "c.ts"), "export const c = 1;\n");
  await runGit(setupRunner, directory, ["add", "--", "src/c.ts"]);
  await runGit(setupRunner, directory, ["commit", "--no-gpg-sign", "-m", "add c"]);
  const base = await inspectRepository(setupRunner, directory);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(join(directory, "src", "c.ts"), "export const c = 2;\n");
  const added = await addPaths(setupRunner, sessions, base, {
    expectedBranch: "main", expectedHead: base.head, paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
  });
  const staged = await inspectRepository(setupRunner, directory);
  await writeFile(join(directory, "src", "b.ts"), "export const b = 3;\n");
  const runner = new RestoreThenRestageRejectRunner(
    await resolveGitExecutable(), process.env, "src/b.ts", "src/c.ts",
  );

  await assert.rejects(restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: base.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  }), /exact remaining|requested/i);

  assert.equal(await runGit(setupRunner, directory, ["show", ":src/b.ts"]), "export const b = 3;\n");
  assert.equal(await runGit(setupRunner, directory, ["diff", "--cached", "--name-only"]), "src/b.ts\n");
  const altered = await inspectRepository(setupRunner, directory);
  await assert.rejects(prepareCommit(runner, sessions, altered, {
    expectedBranch: "main", expectedHead: base.head, stageId: added.stage_id!, message: "must stay unauthorized",
  }), rejection("INDEX_MISMATCH"));
  const persisted = await sessions.getStage(added.stage_id!);
  assert.equal(persisted?.currentIndexTree, staged.indexTree);
  assert.deepEqual(persisted?.ownedPaths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("restore-staged path-set mismatch never adopts an altered requested survivor", async (t) => {
  const { directory, runner: setupRunner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  const added = await addPaths(setupRunner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts", "src/b.ts"],
  });
  const staged = await inspectRepository(setupRunner, directory);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 3;\n");
  const runner = new RestoreThenRestageRejectRunner(await resolveGitExecutable(), process.env, "src/a.ts");

  await assert.rejects(restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  }), /exact remaining|requested/i);

  assert.equal(await runGit(setupRunner, directory, ["show", ":src/a.ts"]), "export const a = 3;\n");
  const altered = await inspectRepository(setupRunner, directory);
  await assert.rejects(prepareCommit(runner, sessions, altered, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, message: "must stay unauthorized",
  }), rejection("INDEX_MISMATCH"));
  const persisted = await sessions.getStage(added.stage_id!);
  assert.equal(persisted?.currentIndexTree, staged.indexTree);
  assert.deepEqual(persisted?.ownedPaths, ["src/a.ts", "src/b.ts"]);
});

test("restore-staged prepare rejects invalid session before mutation and corrected authority executes once", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  const staged = await inspectRepository(runner, directory);
  runner.commands.length = 0;
  await assert.rejects(prepareRestoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: "missing", paths: ["src/a.ts"],
  }), rejection("SESSION_NOT_FOUND"));
  assert.equal(runner.commands.some(({ args }) => args[0] === "restore"), false);

  const prepared = await prepareRestoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  });
  assert.deepEqual(preparedRestoreStagedObservation(prepared), {
    branch: "main", head: snapshot.head, index_tree: staged.indexTree,
    stage_id: added.stage_id, paths: ["src/a.ts"], staged_paths: ["src/a.ts"],
  });
  const result = await executePreparedRestoreStaged(runner, sessions, prepared);
  assert.deepEqual(result.remaining_paths, []);
  await assert.rejects(executePreparedRestoreStaged(runner, sessions, prepared), rejection("INVALID_INPUT"));
});

test("stage session owns both sides of a rename and partial restore preserves the exact remaining delta", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await rename(join(directory, "src", "a.ts"), join(directory, "src", "renamed.ts"));

  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts", "src/renamed.ts"],
  });
  assert.deepEqual(added.staged_paths, ["src/a.ts", "src/renamed.ts"]);
  assert.deepEqual((await sessions.getStage(added.stage_id!))?.ownedPaths, ["src/a.ts", "src/renamed.ts"]);

  const staged = await inspectRepository(runner, directory);
  const partial = await restoreStaged(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/renamed.ts"],
  });
  assert.deepEqual(partial.remaining_paths, ["src/a.ts"]);
  assert.deepEqual((await sessions.getStage(added.stage_id!))?.ownedPaths, ["src/a.ts"]);

  const partiallyRestored = await inspectRepository(runner, directory);
  const complete = await restoreStaged(runner, sessions, partiallyRestored, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/a.ts"],
  });
  assert.deepEqual(complete.remaining_paths, []);
  assert.equal(complete.stage_id, null);
  assert.equal(await sessions.getStage(added.stage_id!), null);
});

test("stage session rejects malformed, truncated, diagnostic, duplicate, and unsafe complete index deltas", async (t) => {
  const cases: Readonly<Record<string, GitCommandResult>> = {
    malformed: commandResult({ stdout: "src/a.ts" }),
    truncated: commandResult({ stdout: "src/a.ts\0", stdoutTruncated: true }),
    diagnostic: commandResult({ stdout: "src/a.ts\0", stderr: "unexpected diagnostic" }),
    duplicate: commandResult({ stdout: "src/a.ts\0src/a.ts\0" }),
    unsafe: commandResult({ stdout: "../escape\0" }),
  };
  for (const [name, delta] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const { directory, sessions, snapshot } = await fixture(t);
      await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
      const runner = new DeltaOverrideRunner(await resolveGitExecutable(), process.env, delta);
      await assert.rejects(addPaths(runner, sessions, snapshot, {
        expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
      }));
      assert.ok(runner.commands.some(({ args }) => JSON.stringify(args) === JSON.stringify(stagedDeltaArgs)));
      await sessions.assertNoActiveSession(snapshot.repositoryId);
    });
  }
});

test("stage session rejects a missing tracked directory before descendant deletions mutate the index", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await rm(join(directory, "src"), { recursive: true, force: true });
  runner.commands.length = 0;

  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src"],
  }), rejection("INVALID_INPUT"));

  const after = await inspectRepository(runner, directory);
  assert.equal(after.indexTree, snapshot.indexTree);
  assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
});

test("stage path policy strictly rejects malformed, truncated, and diagnostic HEAD metadata", async (t) => {
  const cases: Readonly<Record<string, GitCommandResult>> = {
    malformed: commandResult({ stdout: "garbage\0" }),
    truncated: commandResult({ stdout: `100644 blob ${"a".repeat(40)}\tmissing.ts\0`, stdoutTruncated: true }),
    diagnostic: commandResult({ stdout: `100644 blob ${"a".repeat(40)}\tmissing.ts\0`, stderr: "unexpected" }),
  };
  for (const [name, metadata] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const { sessions, snapshot } = await fixture(t);
      const runner = new HeadMetadataOverrideRunner(await resolveGitExecutable(), process.env, metadata);
      await assert.rejects(addPaths(runner, sessions, snapshot, {
        expectedBranch: "main", expectedHead: snapshot.head, paths: ["missing.ts"],
      }));
      assert.ok(runner.commands.some(({ args }) => JSON.stringify(args) === JSON.stringify(["ls-tree", "-z", "HEAD", "--", "missing.ts"])));
      assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
    });
  }
});

test("stage session rejects leading-colon pathspec magic before unrelated files can be staged", async (t) => {
  const { directory, runner, sessions } = await fixture(t);
  const magic = ":!foo";
  await writeFile(join(directory, magic), "initial\n");
  await runGit(runner, directory, ["--literal-pathspecs", "add", "--", magic]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "add literal colon path"]);
  const snapshot = await inspectRepository(runner, directory);
  await writeFile(join(directory, magic), "changed\n");
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  runner.commands.length = 0;

  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: [magic],
  }), rejection("INVALID_INPUT"));

  assert.equal((await inspectRepository(runner, directory)).indexTree, snapshot.indexTree);
  assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
  assert.equal(relativeGitPath.safeParse(magic).success, false);
});

test("stage session and wire schema reject backslash paths before mutation", async (t) => {
  const { directory, runner, sessions } = await fixture(t);
  const path = "back\\slash.ts";
  await writeFile(join(directory, path), "initial\n");
  await runGit(runner, directory, ["--literal-pathspecs", "add", "--", path]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "add backslash path"]);
  const snapshot = await inspectRepository(runner, directory);
  await writeFile(join(directory, path), "changed\n");
  runner.commands.length = 0;

  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: [path],
  }), rejection("INVALID_INPUT"));

  assert.equal((await inspectRepository(runner, directory)).indexTree, snapshot.indexTree);
  assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
  assert.equal(relativeGitPath.safeParse(path).success, false);
});

test("stage session rejects a pre-existing index and an out-of-band index change before mutation", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await runGit(runner, directory, ["add", "--", "src/a.ts"]);
  const staged = await inspectRepository(runner, directory);
  runner.commands.length = 0;
  await assert.rejects(addPaths(runner, sessions, staged, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  }), rejection("INDEX_NOT_EMPTY"));
  assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);

  await runGit(runner, directory, ["restore", "--staged", "--source=HEAD", "--", "src/a.ts"]);
  const cleanIndex = await inspectRepository(runner, directory);
  const added = await addPaths(runner, sessions, cleanIndex, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  await writeFile(join(directory, "src", "b.ts"), "export const b = 2;\n");
  await runGit(runner, directory, ["add", "--", "src/b.ts"]);
  const outOfBand = await inspectRepository(runner, directory);
  runner.commands.length = 0;
  await assert.rejects(addPaths(runner, sessions, outOfBand, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/b.ts"], stageId: added.stage_id!,
  }), rejection("INDEX_MISMATCH"));
  assert.equal(runner.commands.some(({ args }) => args[0] === "add"), false);
});

test("stage operations fail closed for unsafe, unsupported, wrong-session, and unowned paths", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["../escape"],
  }), rejection("INVALID_INPUT"));
  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"], mergeSessionId: "merge-1",
  }), rejection("UNSUPPORTED_REPOSITORY_STATE"));
  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"], stageId: "missing",
  }), rejection("SESSION_NOT_FOUND"));
  const added = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  const current = await inspectRepository(runner, directory);
  await assert.rejects(restoreStaged(runner, sessions, current, {
    expectedBranch: "main", expectedHead: snapshot.head, stageId: added.stage_id!, paths: ["src/b.ts"],
  }), rejection("SESSION_MISMATCH"));
});

test("active stage session blocks branch creation and a second first-add session", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  const current = await inspectRepository(runner, directory);
  await assert.rejects(switchCreate(runner, sessions, current, {
    expectedBranch: "main", expectedHead: snapshot.head, branch: "blocked",
  }), rejection("SESSION_MISMATCH"));
  await assert.rejects(addPaths(runner, sessions, current, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/b.ts"],
  }), rejection("INDEX_NOT_EMPTY"));
});

test("stage session rejects wrong branch, HEAD, repository binding, and missing activity marker", async (t) => {
  const { directory, runner, sessions, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const stageId = "foreign-stage";
  const foreign: StageRecord = {
    kind: "stage", stageId, repositoryId: "f".repeat(64), branch: "main", baseHead: snapshot.head,
    initialIndexTree: snapshot.indexTree, currentIndexTree: snapshot.indexTree, ownedPaths: ["src/a.ts"],
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
  await sessions.putStage(foreign);
  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"], stageId,
  }), rejection("SESSION_MISMATCH"));

  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "other", expectedHead: snapshot.head, paths: ["src/a.ts"],
  }), rejection("BRANCH_MISMATCH"));
  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: "a".repeat(40), paths: ["src/a.ts"],
  }), rejection("HEAD_MISMATCH"));

  const unmarked: StageRecord = { ...foreign, stageId: "unmarked", repositoryId: snapshot.repositoryId };
  await sessions.putStage(unmarked);
  await assert.rejects(addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"], stageId: unmarked.stageId,
  }), rejection("SESSION_MISMATCH"));
});

test("orphan activity marker remains fail closed while failed record publication rolls back only its claim", async (t) => {
  const { sessions, snapshot } = await fixture(t);
  const record: StageRecord = {
    kind: "stage", stageId: "stage-orphan", repositoryId: snapshot.repositoryId, branch: "main", baseHead: snapshot.head,
    initialIndexTree: snapshot.indexTree, currentIndexTree: snapshot.indexTree, ownedPaths: ["src/a.ts"],
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
  await sessions.createStageSession(record);
  await sessions.deleteStage(record.stageId);
  await assert.rejects(sessions.assertNoActiveSession(snapshot.repositoryId), rejection("SESSION_MISMATCH"));

  const { sessions: rollbackStore, snapshot: rollbackSnapshot } = await fixture(t);
  const collision: StageRecord = { ...record, stageId: "stage-collision", repositoryId: rollbackSnapshot.repositoryId };
  await rollbackStore.putStage(collision);
  await assert.rejects(rollbackStore.createStageSession(collision), /EEXIST|exist/i);
  await rollbackStore.assertNoActiveSession(rollbackSnapshot.repositoryId);
});

test("stage session deletion is idempotent and resumes an exact marker orphan after record unlink", async (t) => {
  const { statePaths, snapshot } = await fixture(t);
  const record: StageRecord = {
    kind: "stage", stageId: "stage-delete", repositoryId: snapshot.repositoryId, branch: "main", baseHead: snapshot.head,
    initialIndexTree: snapshot.indexTree, currentIndexTree: snapshot.indexTree, ownedPaths: ["src/a.ts"],
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const store = new SessionStore(statePaths);
  await store.createStageSession(record);
  await store.deleteStageSession(record);
  await store.deleteStageSession(record);
  assert.equal(await store.getActiveSession(record.repositoryId), null);

  let crashOnce = true;
  const resumable = new SessionStore(statePaths, {
    afterStageRecordUnlink: async () => {
      if (crashOnce) { crashOnce = false; throw new Error("simulated crash boundary"); }
    },
  });
  const resumedRecord = { ...record, stageId: "stage-resume" };
  await resumable.createStageSession(resumedRecord);
  await assert.rejects(resumable.deleteStageSession(resumedRecord), /simulated crash boundary/);
  assert.equal(await resumable.getStage(resumedRecord.stageId), null);
  assert.deepEqual(await resumable.getActiveSession(resumedRecord.repositoryId), {
    kind: "session-activity", repositoryId: resumedRecord.repositoryId, sessionKind: "stage", sessionId: resumedRecord.stageId,
  });
  await resumable.deleteStageSession(resumedRecord);
  assert.equal(await resumable.getActiveSession(resumedRecord.repositoryId), null);
});

test("stage cleanup durably syncs record removal before marker removal", async (t) => {
  const { statePaths, snapshot } = await fixture(t);
  const record: StageRecord = {
    kind: "stage", stageId: "stage-durable-order", repositoryId: snapshot.repositoryId, branch: "main", baseHead: snapshot.head,
    initialIndexTree: snapshot.indexTree, currentIndexTree: snapshot.indexTree, ownedPaths: ["src/a.ts"],
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const steps: string[] = [];
  const crashing = new SessionStore(statePaths, {
    onStageCleanupStep: async (step) => {
      steps.push(step);
      if (step === "record-directory-synced") throw new Error("power loss before marker removal");
    },
  });
  await crashing.createStageSession(record);
  await assert.rejects(crashing.deleteStageSession(record), /power loss/);
  assert.deepEqual(steps, ["record-unlinked", "record-directory-synced"]);
  assert.equal(await crashing.getStage(record.stageId), null);
  assert.ok(await crashing.getActiveSession(record.repositoryId));

  const resumedSteps: string[] = [];
  const resumed = new SessionStore(statePaths, { onStageCleanupStep: async (step) => { resumedSteps.push(step); } });
  await resumed.deleteStageSession(record);
  assert.deepEqual(resumedSteps, ["marker-unlinked", "marker-directory-synced"]);
  assert.equal(await resumed.getActiveSession(record.repositoryId), null);
});

test("no-op add returns no active session", async (t) => {
  const { runner, sessions, snapshot } = await fixture(t);
  const result = await addPaths(runner, sessions, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  });
  assert.deepEqual(result, {
    mode: "stage", stage_id: null, merge_session_id: null, index_tree: snapshot.indexTree,
    staged_paths: [], unresolved_paths: [],
  });
  await sessions.assertNoActiveSession(snapshot.repositoryId);
});

test("stage persistence failure never reports success after the index mutation", async (t) => {
  const { directory, runner, statePaths, snapshot } = await fixture(t);
  await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
  const failing = new class extends SessionStore {
    override async createStageSession(_record: StageRecord): Promise<void> { throw new Error("state device unavailable"); }
  }(statePaths);

  await assert.rejects(addPaths(runner, failing, snapshot, {
    expectedBranch: "main", expectedHead: snapshot.head, paths: ["src/a.ts"],
  }), /state device unavailable/);
  assert.notEqual((await inspectRepository(runner, directory)).indexTree, snapshot.headTree);
});
