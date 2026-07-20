import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BridgeResult, CommitData } from "../src/domain/result.js";
import { BridgeRejection, commitDataSchema } from "../src/domain/result.js";
import { relativeGitPath } from "../src/domain/inputs.js";
import {
  commitStage,
  createCommitAfterPersistCleanup,
  executePreparedCommit,
  prepareCommit,
  preparedCommitObservation,
  type PreparedCommit,
} from "../src/git/commit.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";
import { addPaths } from "../src/git/stage.js";
import { ProvenMutationOutcome } from "../src/app/mutation-coordinator.js";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../src/state/paths.js";
import type { StageRecord } from "../src/state/records.js";
import { SessionStore } from "../src/state/session-store.js";
import { AuditLog } from "../src/state/audit.js";

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

function commandResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0, ...overrides,
  };
}

class CommitOverrideRunner extends GitRunner {
  constructor(
    private readonly delegate: GitRunner,
    private readonly commitOutcome: GitCommandResult | Error,
  ) { super(process.execPath, process.env); }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (command.args[0] === "commit") {
      if (this.commitOutcome instanceof Error) throw this.commitOutcome;
      return this.commitOutcome;
    }
    return this.delegate.run(command, signal);
  }
}

class AbortOnCommitRunner extends GitRunner {
  constructor(private readonly delegate: GitRunner, private readonly controller: AbortController) {
    super(process.execPath, process.env);
  }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (command.args[0] === "commit") {
      this.controller.abort();
      return commandResult({ exitCode: null, aborted: true });
    }
    return this.delegate.run(command, signal);
  }
}

class ChangedSecondReadSessionStore extends SessionStore {
  private reads = 0;
  override async getStage(id: string): Promise<StageRecord | null> {
    const record = await super.getStage(id);
    this.reads += 1;
    return this.reads < 2 || record === null
      ? record
      : { ...record, updatedAt: "2026-07-19T23:59:59.000Z" };
  }
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 10_000, maxOutputBytes: 64_000, ...(stdin === undefined ? {} : { stdin }) });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function hook(directory: string, name: string, body: string): Promise<void> {
  const path = join(directory, ".hooks", name);
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
}

async function fixture(t: test.TestContext): Promise<{
  directory: string; runner: TrackingRunner; sessions: SessionStore; paths: StatePaths;
  base: RepositorySnapshot; stage: StageRecord;
}> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-commit-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-commit-state-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(stateHome, { recursive: true, force: true }); });
  const runner = new TrackingRunner(await resolveGitExecutable(), { ...process.env, BRIDGE_TEST_SECRET: "must-not-reach-hook" });
  await runGit(runner, directory, ["init", "--initial-branch=main"]);
  await runGit(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
  await runGit(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
  await mkdir(join(directory, ".hooks"));
  await runGit(runner, directory, ["config", "core.hooksPath", ".hooks"]);
  await writeFile(join(directory, "tracked.txt"), "one\n");
  await runGit(runner, directory, ["add", "--", "tracked.txt"]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "initial"]);
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const sessions = new SessionStore(paths);
  const base = await inspectRepository(runner, directory);
  await writeFile(join(directory, "tracked.txt"), "two\n");
  const added = await addPaths(runner, sessions, base, {
    expectedBranch: "main", expectedHead: base.head, paths: ["tracked.txt"],
  });
  assert.ok(added.stage_id);
  const stage = await sessions.getStage(added.stage_id);
  assert.ok(stage);
  runner.commands.length = 0;
  return { directory, runner, sessions, paths, base, stage };
}

function input(base: RepositorySnapshot, stage: StageRecord, message = "subject\n\nbody\n") {
  return { expectedBranch: "main", expectedHead: base.head, stageId: stage.stageId, message };
}

function outcome(error: unknown): ProvenMutationOutcome<CommitData> {
  assert.ok(error instanceof ProvenMutationOutcome);
  return error as ProvenMutationOutcome<CommitData>;
}

test("unsigned commit hooks create exactly one child commit using exact stdin and no forbidden arguments", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  await hook(directory, "commit-msg", 'test "$(cat "$1")" = "subject\n\nbody"');
  await runGit(runner, directory, ["config", "commit.gpgSign", "true"]);
  await runGit(runner, directory, ["config", "gpg.program", "/definitely/missing/gpg"]);
  runner.commands.length = 0;

  const execution = await commitStage(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  const { data } = execution;

  assert.equal(data.signing, "disabled_by_policy");
  assert.equal(await runGit(runner, directory, ["rev-parse", data.commit + "^"]), base.head);
  assert.equal(await runGit(runner, directory, ["rev-parse", data.commit + "^{tree}"]), data.tree);
  const commits = await runGit(runner, directory, ["rev-list", "--count", base.head + "..HEAD"]);
  assert.equal(commits, "1");
  const command = runner.commands.find(({ args }) => args[0] === "commit");
  assert.deepEqual(command?.args, ["commit", "--no-gpg-sign", "--file=-"]);
  assert.equal(command?.stdin, "subject\n\nbody\n");
  assert.equal(command?.args.includes("--no-verify"), false);
  assert.equal(command?.args.some((arg) => arg.includes("core.hooksPath")), false);
  assert.equal(runner.commands.some(({ args }) => args[0] === "config"), false);
  assert.deepEqual(execution.warnings, []);
});

test("commit complete-path proofs use streaming stdout instead of an aggregate cap", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);

  await commitStage(runner, sessions, await inspectRepository(runner, directory), input(base, stage));

  const completePathReads = runner.commands.filter(({ args }) =>
    args.join(" ") === "diff --cached --name-only -z --no-renames HEAD --"
      || args.slice(0, 4).join(" ") === "ls-tree -r -z --full-tree");
  assert.ok(completePathReads.length >= 3);
  for (const command of completePathReads) {
    assert.equal(typeof command.stdoutConsumer, "function", command.args.join(" "));
  }
});

test("commit hooks run with the sanitized inherited environment", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'test -n "\${PATH:-}"\ntest -z "\${BRIDGE_TEST_SECRET:-}"');
  const execution = await commitStage(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  assert.equal(execution.data.commit, await runGit(runner, directory, ["rev-parse", "HEAD"]));
});

test("plain commit failure, including hook rejection, is failed GIT_FAILED without creating a commit", async (t) => {
  for (const hookName of ["pre-commit", "commit-msg"] as const) {
    await t.test(hookName, async (t) => {
      const { directory, runner, sessions, base, stage } = await fixture(t);
      await hook(directory, hookName, 'echo "sensitive hook diagnostic" >&2\nexit 1');
      const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
      let caught: unknown;
      try { await executePreparedCommit(runner, prepared); } catch (error) { caught = error; }
      const proven = outcome(caught);
      assert.equal(proven.result.status, "failed");
      assert.equal(proven.result.error?.code, "GIT_FAILED");
      assert.equal(proven.result.error?.message.includes("sensitive"), false);
      assert.equal(await runGit(runner, directory, ["rev-parse", "HEAD"]), base.head);
    });
  }
});

test("a successful pre-commit index modification records the actual committed tree and both rename sides", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'mv tracked.txt renamed.txt\ngit add -- tracked.txt renamed.txt');

  const { data } = await commitStage(runner, sessions, await inspectRepository(runner, directory), input(base, stage));

  assert.equal(data.tree, await runGit(runner, directory, ["rev-parse", "HEAD^{tree}"]));
  assert.deepEqual(data.hook_changed_paths, ["renamed.txt", "tracked.txt"]);
  assert.equal((await inspectRepository(runner, directory)).indexMatchesHead, true);
});

test("post-commit stderr is a generic warning and never converts the created commit to failure", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  await hook(directory, "post-commit", 'echo "private post commit diagnostic" >&2');

  const execution = await commitStage(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  const { data } = execution;

  assert.equal(data.commit, await runGit(runner, directory, ["rev-parse", "HEAD"]));
  assert.deepEqual(execution.warnings, ["Git emitted diagnostics after the commit was created"]);
  assert.equal(execution.warnings[0]?.includes("private"), false);
});

test("post-commit may preserve newly staged index content while the exact child commit succeeds", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  await hook(directory, "post-commit", 'printf "later\n" > post-staged.txt\ngit add -- post-staged.txt');
  const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  const observedBefore = preparedCommitObservation(prepared);
  const execution = await executePreparedCommit(runner, prepared);
  assert.ok(execution.warnings.includes("The repository index differs from the created commit after native hooks ran"));
  const after = await inspectRepository(runner, directory);
  assert.equal(execution.data.commit, after.head);
  assert.notEqual(after.indexTree, after.headTree);

  const cleanup = createCommitAfterPersistCleanup(sessions, {
    requestId: "post-index", repositoryId: stage.repositoryId, operation: "git_commit",
    stageId: stage.stageId, expectedBranch: stage.branch, expectedHead: stage.baseHead,
  });
  const durable: BridgeResult<CommitData> = {
    status: "succeeded", request_id: "post-index", repository_id: stage.repositoryId,
    operation: "git_commit", observed_before: observedBefore, data: execution.data, warnings: execution.warnings,
  };
  await cleanup(durable);
  await cleanup(durable);
  assert.equal(await sessions.getActiveSession(stage.repositoryId), null);
  assert.notEqual((await inspectRepository(runner, directory)).indexTree, after.headTree);
  await assert.rejects(addPaths(runner, sessions, after, {
    expectedBranch: "main", expectedHead: after.head, paths: ["tracked.txt"],
  }), (error) => error instanceof BridgeRejection && error.error.code === "INDEX_NOT_EMPTY");
});

test("hook-changed output accepts legal Git names that remain forbidden as input pathspecs", async (t) => {
  const { directory, runner, sessions, paths, base, stage } = await fixture(t);
  const names = ["hook*.txt", "hook?.txt", "hook[1].txt", ":hook.txt", ...(process.platform === "win32" ? [] : ["hook\\name.txt"])];
  const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  await hook(directory, "pre-commit", names.map((name) =>
    `printf "hook\\n" > ${shellQuote(name)}\ngit add -- ${shellQuote(`:(literal)${name}`)}`).join("\n"));

  const execution = await commitStage(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  assert.deepEqual(execution.data.hook_changed_paths, [...names].sort());
  assert.equal(commitDataSchema.safeParse(execution.data).success, true);
  for (const name of names) assert.equal(relativeGitPath.safeParse(name).success, false);
  const audit = new AuditLog(paths);
  await audit.append({
    timestamp: "2026-07-19T12:00:00.000Z", requestId: "special-paths", operation: "git_commit",
    repositoryId: stage.repositoryId, status: "succeeded", durationMs: 1,
    hookChangedPaths: execution.data.hook_changed_paths,
  });
});

test("prepare rejects exact stage mismatch and out-of-band HEAD or index changes before commit", async (t) => {
  for (const scenario of ["record", "index", "head"] as const) {
    await t.test(scenario, async (t) => {
      const { directory, runner, sessions, base, stage } = await fixture(t);
      if (scenario === "record") await sessions.updateStageSession({ ...stage, ownedPaths: ["other.txt"] });
      if (scenario === "index") {
        await writeFile(join(directory, "extra.txt"), "extra\n");
        await runGit(runner, directory, ["add", "--", "extra.txt"]);
      }
      if (scenario === "head") await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", "outside"]);
      runner.commands.length = 0;
      await assert.rejects(
        prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage)),
        (error) => error instanceof BridgeRejection,
      );
      assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
    });
  }
});

test("prepare revalidates the exact stage record after its final repository reads", async (t) => {
  const { directory, runner, paths, base, stage } = await fixture(t);
  const changing = new ChangedSecondReadSessionStore(paths);
  await assert.rejects(
    prepareCommit(runner, changing, await inspectRepository(runner, directory), input(base, stage)),
    (error) => error instanceof BridgeRejection && error.error.code === "SESSION_MISMATCH",
  );
  assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
});

test("prepared commit authority is opaque and one-shot", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  await assert.rejects(executePreparedCommit(runner, { stageId: stage.stageId } as PreparedCommit), /invalid|consumed/i);
  const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  await executePreparedCommit(runner, prepared);
  await assert.rejects(executePreparedCommit(runner, prepared), /invalid|consumed/i);
  assert.equal(await runGit(runner, directory, ["rev-list", "--count", base.head + "..HEAD"]), "1");
});

test("a hook that changes the index then rejects is failed GIT_FAILED and leaves the session fail closed", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'printf "hook\n" > hook-added.txt\ngit add -- hook-added.txt\nexit 1');
  const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  let caught: unknown;
  try { await executePreparedCommit(runner, prepared); } catch (error) { caught = error; }
  const proven = outcome(caught);
  assert.equal(proven.result.status, "failed");
  assert.equal(proven.result.error?.code, "GIT_FAILED");
  assert.ok(await sessions.getStage(stage.stageId));
  await assert.rejects(
    prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage)),
    (error) => error instanceof BridgeRejection && error.error.code === "INDEX_MISMATCH",
  );
});

test("timeout, truncated output, and runner exception are durable failures when unchanged HEAD and index are proven", async (t) => {
  const cases = [
    { name: "non-hook nonzero", outcome: commandResult({ exitCode: 1 }), code: "GIT_FAILED" },
    { name: "timeout", outcome: commandResult({ exitCode: null, timedOut: true }), code: "GIT_TIMEOUT" },
    { name: "truncation", outcome: commandResult({ exitCode: 1, stdoutTruncated: true }), code: "OUTPUT_TRUNCATED" },
    { name: "signal", outcome: commandResult({ exitCode: null, signal: "SIGTERM" }), code: "GIT_FAILED" },
    { name: "runner exception", outcome: new Error("spawn transport failed"), code: "GIT_FAILED" },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const { directory, runner, sessions, base, stage } = await fixture(t);
      const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
      let caught: unknown;
      try { await executePreparedCommit(new CommitOverrideRunner(runner, scenario.outcome), prepared); }
      catch (error) { caught = error; }
      const proven = outcome(caught);
      assert.equal(proven.result.status, "failed");
      assert.equal(proven.result.error?.code, scenario.code);
      assert.equal(await runGit(runner, directory, ["rev-parse", "HEAD"]), base.head);
      assert.equal((await inspectRepository(runner, directory)).indexTree, stage.currentIndexTree);
    });
  }
});

test("an abort after mutation starts is reinspected without the canceled caller signal", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  const controller = new AbortController();
  let caught: unknown;
  try { await executePreparedCommit(new AbortOnCommitRunner(runner, controller), prepared, controller.signal); }
  catch (error) { caught = error; }
  const proven = outcome(caught);
  assert.equal(proven.result.status, "failed");
  assert.equal(proven.result.error?.code, "GIT_FAILED");
  assert.equal(await runGit(runner, directory, ["rev-parse", "HEAD"]), base.head);
});

test("afterPersist cleanup consumes only an exactly bound durable commit success and is idempotent", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  const observedBefore = preparedCommitObservation(prepared);
  const { data } = await executePreparedCommit(runner, prepared);
  assert.ok(await sessions.getStage(stage.stageId));
  const cleanup = createCommitAfterPersistCleanup(sessions, {
    requestId: "request-10", repositoryId: stage.repositoryId, operation: "git_commit",
    stageId: stage.stageId, expectedBranch: stage.branch, expectedHead: stage.baseHead,
  });
  const success: BridgeResult<CommitData> = {
    status: "succeeded", request_id: "request-10", repository_id: stage.repositoryId,
    operation: "git_commit", observed_before: observedBefore, data, warnings: [],
  };
  await cleanup(success);
  await cleanup(success);
  assert.equal(await sessions.getStage(stage.stageId), null);
  assert.equal(await sessions.getActiveSession(stage.repositoryId), null);

  const { sessions: otherSessions, stage: otherStage } = await fixture(t);
  const otherCleanup = createCommitAfterPersistCleanup(otherSessions, {
    requestId: "request-10", repositoryId: otherStage.repositoryId, operation: "git_commit",
    stageId: otherStage.stageId, expectedBranch: otherStage.branch, expectedHead: otherStage.baseHead,
  });
  await otherCleanup({ ...success, repository_id: otherStage.repositoryId, status: "failed" });
  assert.ok(await otherSessions.getStage(otherStage.stageId));
});

test("durable success cleanup resumes after process restart without another commit", async (t) => {
  const { directory, runner, paths, base, stage } = await fixture(t);
  const normal = new SessionStore(paths);
  const prepared = await prepareCommit(runner, normal, await inspectRepository(runner, directory), input(base, stage));
  const observedBefore = preparedCommitObservation(prepared);
  const { data } = await executePreparedCommit(runner, prepared);
  const result: BridgeResult<CommitData> = {
    status: "succeeded", request_id: "request-replay", repository_id: stage.repositoryId,
    operation: "git_commit", observed_before: observedBefore, data, warnings: [],
  };
  let crash = true;
  const crashing = new SessionStore(paths, {
    afterStageRecordUnlink: async () => { if (crash) { crash = false; throw new Error("cleanup crash"); } },
  });
  await assert.rejects(
    createCommitAfterPersistCleanup(crashing, {
      requestId: "request-replay", repositoryId: stage.repositoryId, operation: "git_commit",
      stageId: stage.stageId, expectedBranch: stage.branch, expectedHead: stage.baseHead,
    })(result),
    /cleanup crash/,
  );
  assert.equal(await normal.getStage(stage.stageId), null);
  assert.ok(await normal.getActiveSession(stage.repositoryId));

  const restarted = new SessionStore(paths);
  await createCommitAfterPersistCleanup(restarted, {
    requestId: "request-replay", repositoryId: stage.repositoryId, operation: "git_commit",
    stageId: stage.stageId, expectedBranch: stage.branch, expectedHead: stage.baseHead,
  })(result);
  assert.equal(await restarted.getActiveSession(stage.repositoryId), null);
  assert.equal(await runGit(runner, directory, ["rev-list", "--count", base.head + "..HEAD"]), "1");
});

test("restart-safe cleanup refuses a stage record changed after durable commit persistence", async (t) => {
  const { directory, runner, sessions, base, stage } = await fixture(t);
  const prepared = await prepareCommit(runner, sessions, await inspectRepository(runner, directory), input(base, stage));
  const observedBefore = preparedCommitObservation(prepared);
  const { data } = await executePreparedCommit(runner, prepared);
  const result: BridgeResult<CommitData> = {
    status: "succeeded", request_id: "request-mutated", repository_id: stage.repositoryId,
    operation: "git_commit", observed_before: observedBefore, data, warnings: [],
  };
  await sessions.updateStageSession({ ...stage, updatedAt: "2026-07-19T23:59:59.000Z" });
  const cleanup = createCommitAfterPersistCleanup(sessions, {
    requestId: "request-mutated", repositoryId: stage.repositoryId, operation: "git_commit",
    stageId: stage.stageId, expectedBranch: stage.branch, expectedHead: stage.baseHead,
  });
  await assert.rejects(cleanup(result), /changed|hash|match/i);
  assert.ok(await sessions.getStage(stage.stageId));
  assert.ok(await sessions.getActiveSession(stage.repositoryId));
});
