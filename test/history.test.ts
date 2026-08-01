import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executePreparedCommitRangeValidation,
  executePreparedReword,
  inspectLinearCommitRange,
  parseRefLines,
  prepareCommitRangeValidation,
  prepareReword,
  sameRefLines,
  validateMessagesWithNativeHook,
} from "../src/git/history.js";
import { withDeadline, withReconciliationDeadline } from "../src/deadline.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult, type GitStreamingCommand } from "../src/git/runner.js";
import { initializeStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { SessionStore } from "../src/state/session-store.js";
import { createBridgeRuntime } from "../src/app/bridge-service.js";
import type { StatePaths } from "../src/state/paths.js";

async function git(runner: GitRunner, cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 10_000, maxOutputBytes: 64_000, ...(stdin === undefined ? {} : { stdin }) });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t: test.TestContext, hookBody: string): Promise<{
  directory: string; runner: GitRunner; sessions: SessionStore; paths: StatePaths; base: string; head: RepositorySnapshot;
}> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-history-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-history-state-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(stateHome, { recursive: true, force: true }); });
  const runner = new GitRunner(await resolveGitExecutable(), process.env);
  await git(runner, directory, ["init", "--initial-branch=main"]);
  await git(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
  await git(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
  await mkdir(join(directory, ".hooks"));
  await git(runner, directory, ["config", "core.hooksPath", ".hooks"]);
  await writeFile(join(directory, ".gitignore"), ".hooks\n");
  await writeFile(join(directory, "tracked.txt"), "base\n");
  await git(runner, directory, ["add", "--", ".gitignore", "tracked.txt"]);
  await git(runner, directory, ["commit", "--no-gpg-sign", "-m", "chore(base): initial"]);
  const base = await git(runner, directory, ["rev-parse", "HEAD"]);
  await writeFile(join(directory, "tracked.txt"), "one\n");
  await git(runner, directory, ["commit", "--no-gpg-sign", "-am", "feat(first): one"]);
  await writeFile(join(directory, "tracked.txt"), "two\n");
  await git(runner, directory, ["commit", "--no-gpg-sign", "-am", "fix(second): two"]);
  await writeFile(join(directory, ".hooks", "commit-msg"), `#!/bin/sh\nset -eu\n${hookBody}\n`);
  await chmod(join(directory, ".hooks", "commit-msg"), 0o755);
  const head = await inspectRepository(runner, directory);
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  return { directory, runner, sessions: new SessionStore(paths), paths, base, head };
}

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];

  override async run(command: GitCommand, signal?: AbortSignal) {
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

class QueueRunner extends GitRunner {
  constructor(private readonly replies: readonly GitCommandResult[]) { super(process.execPath, process.env); }
  private index = 0;

  get calls(): number { return this.index; }

  override async run(): Promise<GitCommandResult> {
    const result = this.replies[this.index++];
    if (result === undefined) throw new Error("Unexpected Git command");
    return result;
  }
}

class RawRangeRunner extends QueueRunner {
  constructor(replies: readonly GitCommandResult[], private readonly chunks: readonly Buffer[]) { super(replies); }

  override async runStreaming(_command: GitStreamingCommand, consume: (chunk: Buffer) => void, _signal?: AbortSignal): Promise<GitCommandResult> {
    for (const chunk of this.chunks) consume(chunk);
    return commandResult();
  }
}

class AbortDuringHookRunner extends TrackingRunner {
  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly controller: AbortController) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (command.args[0] === "hook") setTimeout(() => this.controller.abort(), 5_000).unref();
    return super.run(command, signal);
  }
}

class ThrowAfterHookRunner extends TrackingRunner {
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    const result = await super.run(command, signal);
    if (command.args[0] === "hook") throw new Error("simulated runner failure");
    return result;
  }
}

class RewordFailureRunner extends TrackingRunner {
  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly point: "commit-tree" | "before-ref" | "after-ref") {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (this.point === "commit-tree" && command.args.includes("commit-tree")) throw new Error("injected before object creation");
    if (this.point === "before-ref" && command.args[0] === "update-ref") throw new Error("injected before ref movement");
    const result = await super.run(command, signal);
    if (this.point === "after-ref" && command.args[0] === "update-ref") throw new Error("injected after ref movement");
    return result;
  }
}

class OwnershipBeforeRefRunner extends TrackingRunner {
  private injected = false;
  private readonly sideRunner: GitRunner;

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly linkedWorktree: string) {
    super(executable, environment);
    this.sideRunner = new GitRunner(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!this.injected && command.args[0] === "update-ref" && command.args[1] === "refs/heads/feature/taken") {
      this.injected = true;
      await git(this.sideRunner, command.cwd, ["worktree", "add", "-b", "feature/taken", this.linkedWorktree]);
      await git(this.sideRunner, command.cwd, ["update-ref", "-d", "refs/heads/feature/taken"]);
    }
    return super.run(command, signal);
  }
}

function assertGenericMutationFailure(error: unknown): true {
  const result = (error as { result: { error?: unknown } }).result;
  assert.deepEqual(result.error, { code: "GIT_FAILED", message: "Native commit-msg hook changed the repository" });
  return true;
}

function commitObject(tree: string, parent: string): string {
  return `tree ${tree}\nparent ${parent}\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\nfeat(scope): message\n`;
}

test("validates every commit in an exact linear range", async (t) => {
  const { runner, sessions, base, head } = await fixture(t, "case \"$(head -n 1 \"$1\")\" in *'():'*) exit 1 ;; esac");
  const prepared = await prepareCommitRangeValidation(runner, sessions, head, {
    expectedBranch: "main", expectedHead: head.head, base,
  });

  assert.deepEqual(await executePreparedCommitRangeValidation(runner, prepared), {
    base, head: head.head, commit_count: 2, hook: "commit-msg",
  });
});

test("rewords the current branch with pairwise tree invariance", async (t) => {
  const { directory, runner, sessions, base, head } = await fixture(t, "exit 0");
  await git(runner, directory, ["branch", "-m", "feature/history"]);
  const before = await inspectRepository(runner, directory);
  const oldCommits = (await git(runner, directory, ["rev-list", "--reverse", `${base}..${before.head}`])).split("\n");
  const describe = async (commits: readonly string[]) => Promise.all(commits.map(async (commit) =>
    (await git(runner, directory, ["show", "-s", "--format=%T%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", commit])).split("\0")));
  const oldMetadata = await describe(oldCommits);
  const oldTrees = oldMetadata.map(([tree]) => tree);
  const oldAuthors = oldMetadata.map(([, name, email, date]) => [name, email, date]);
  const oldCommitters = oldMetadata.map(([, , , , name, email, date]) => [name, email, date]);
  const worktreeSnapshotBefore = await git(runner, directory, ["hash-object", "tracked.txt"]);

  const prepared = await prepareReword(runner, sessions, before, {
    expectedBranch: "feature/history",
    expectedHead: before.head,
    base,
    commits: [
      { commit: oldCommits[0]!, message: "feat(first): reworded one" },
      { commit: oldCommits[1]!, message: "fix(second): reworded two" },
    ],
    destination: { mode: "current_branch" },
  });
  const result = await executePreparedReword(runner, prepared);
  const after = await inspectRepository(runner, directory);
  const newCommits = (await git(runner, directory, ["rev-list", "--reverse", `${base}..${after.head}`])).split("\n");
  const newMetadata = await describe(newCommits);
  const newTrees = newMetadata.map(([tree]) => tree);
  const newAuthors = newMetadata.map(([, name, email, date]) => [name, email, date]);
  const newCommitters = newMetadata.map(([, , , , name, email, date]) => [name, email, date]);

  assert.equal(after.branch, "feature/history");
  assert.equal(after.head, result.data.head);
  assert.equal((await runner.run({ cwd: directory, args: ["cat-file", "-e", `${head.head}^{commit}`], timeoutMs: 10_000, maxOutputBytes: 64_000 })).exitCode, 0);
  assert.deepEqual(newTrees, oldTrees);
  assert.deepEqual(newAuthors, oldAuthors);
  assert.deepEqual(newCommitters, oldCommitters);
  assert.equal(await git(runner, directory, ["hash-object", "tracked.txt"]), worktreeSnapshotBefore);
  assert.equal(after.indexTree, before.indexTree);
});

test("rewords onto a new branch while preserving the source ref and worktree", async (t) => {
  const { directory, runner, sessions, base } = await fixture(t, "exit 0");
  await git(runner, directory, ["branch", "-m", "feature/source"]);
  const before = await inspectRepository(runner, directory);
  const sourceHead = await git(runner, directory, ["show-ref", "--verify", "--hash", "refs/heads/feature/source"]);
  const commits = (await git(runner, directory, ["rev-list", "--reverse", `${base}..${before.head}`])).split("\n");
  const worktreeBefore = await git(runner, directory, ["hash-object", "tracked.txt"]);

  const prepared = await prepareReword(runner, sessions, before, {
    expectedBranch: "feature/source", expectedHead: before.head, base,
    commits: commits.map((commit, index) => ({ commit, message: `feat(reword): replacement ${index + 1}\n` })),
    destination: { mode: "new_branch", branch: "feature/reworded" },
  });
  const result = await executePreparedReword(runner, prepared);
  const after = await inspectRepository(runner, directory);

  assert.equal(after.branch, "feature/reworded");
  assert.equal(after.head, result.data.head);
  assert.equal(await git(runner, directory, ["show-ref", "--verify", "--hash", "refs/heads/feature/source"]), sourceHead);
  assert.equal(await git(runner, directory, ["show-ref", "--verify", "--hash", "refs/heads/feature/reworded"]), result.data.head);
  assert.equal(await git(runner, directory, ["hash-object", "tracked.txt"]), worktreeBefore);
  assert.equal(after.indexTree, before.indexTree);
});

test("reword interruption is failed before ref movement and reconciled after exact ref movement", async (t) => {
  for (const point of ["commit-tree", "before-ref", "after-ref"] as const) {
    await t.test(point, async (t) => {
      const fixtureState = await fixture(t, "exit 0");
      await git(fixtureState.runner, fixtureState.directory, ["branch", "-m", "feature/history"]);
      const runner = new RewordFailureRunner(await resolveGitExecutable(), process.env, point);
      const before = await inspectRepository(runner, fixtureState.directory);
      const commits = (await git(runner, fixtureState.directory, ["rev-list", "--reverse", `${fixtureState.base}..${before.head}`])).split("\n");
      const prepared = await prepareReword(runner, fixtureState.sessions, before, {
        expectedBranch: "feature/history", expectedHead: before.head, base: fixtureState.base,
        commits: commits.map((commit, index) => ({ commit, message: `feat(interrupt): ${index + 1}\n` })),
        destination: { mode: "current_branch" },
      });
      if (point === "after-ref") {
        const outcome = await executePreparedReword(runner, prepared);
        assert.notEqual(outcome.data.head, before.head);
        assert.deepEqual(outcome.warnings, ["Git completion diagnostics were incomplete after reword success was proven"]);
      } else {
        await assert.rejects(executePreparedReword(runner, prepared), (error) => {
          const result = (error as { result: { status?: string; error?: { code?: string } } }).result;
          assert.equal(result.status, "failed");
          assert.equal(result.error?.code, "GIT_FAILED");
          return true;
        });
        assert.equal((await inspectRepository(runner, fixtureState.directory)).head, before.head);
      }
    });
  }
});

test("reference-transaction rejection leaves the current branch at its old head", async (t) => {
  const { directory, runner, sessions, base } = await fixture(t, "exit 0");
  await git(runner, directory, ["branch", "-m", "feature/history"]);
  await writeFile(join(directory, ".hooks", "reference-transaction"), "#!/bin/sh\n[ \"$1\" != prepared ]\n");
  await chmod(join(directory, ".hooks", "reference-transaction"), 0o755);
  const before = await inspectRepository(runner, directory);
  const commits = (await git(runner, directory, ["rev-list", "--reverse", `${base}..${before.head}`])).split("\n");
  const prepared = await prepareReword(runner, sessions, before, {
    expectedBranch: "feature/history", expectedHead: before.head, base,
    commits: commits.map((commit, index) => ({ commit, message: `feat(ref-hook): ${index + 1}\n` })),
    destination: { mode: "current_branch" },
  });
  await assert.rejects(executePreparedReword(runner, prepared), (error) => {
    assert.equal((error as { result: { status?: string } }).result.status, "failed");
    return true;
  });
  assert.equal((await inspectRepository(runner, directory)).head, before.head);
});

test("reword validates every proposed message before creating commit objects", async (t) => {
  const fixtureState = await fixture(t, "grep -q 'rejected' \"$1\" && exit 17\nexit 0");
  await git(fixtureState.runner, fixtureState.directory, ["branch", "-m", "feature/history"]);
  const runner = new TrackingRunner(await resolveGitExecutable(), process.env);
  const before = await inspectRepository(runner, fixtureState.directory);
  const commits = (await git(runner, fixtureState.directory, ["rev-list", "--reverse", `${fixtureState.base}..${before.head}`])).split("\n");
  const prepared = await prepareReword(runner, fixtureState.sessions, before, {
    expectedBranch: "feature/history", expectedHead: before.head, base: fixtureState.base,
    commits: [
      { commit: commits[0]!, message: "feat(valid): accepted" },
      { commit: commits[1]!, message: "fix(rejected): denied" },
    ],
    destination: { mode: "current_branch" },
  });
  await assert.rejects(executePreparedReword(runner, prepared), (error) => {
    assert.equal((error as { result: { error?: { code?: string } } }).result.error?.code, "HOOK_FAILED");
    return true;
  });
  assert.equal(runner.commands.some(({ args }) => args.includes("commit-tree")), false);
  assert.equal(runner.commands.some(({ args }) => args[0] === "update-ref"), false);
});

test("replacement ownership created by a message hook is re-proved before object creation", async (t) => {
  const linked = await mkdtemp(join(tmpdir(), "git-mcp-server-history-hook-worktree-"));
  await rm(linked, { recursive: true, force: true });
  t.after(async () => { await rm(linked, { recursive: true, force: true }); });
  const fixtureState = await fixture(t, [
    `git worktree add -b feature/taken '${linked}' >/dev/null`,
    "git update-ref -d refs/heads/feature/taken",
  ].join("\n"));
  await git(fixtureState.runner, fixtureState.directory, ["branch", "-m", "feature/source"]);
  const runner = new TrackingRunner(await resolveGitExecutable(), process.env);
  const before = await inspectRepository(runner, fixtureState.directory);
  const commits = (await git(runner, fixtureState.directory, ["rev-list", "--reverse", `${fixtureState.base}..${before.head}`])).split("\n");
  const prepared = await prepareReword(runner, fixtureState.sessions, before, {
    expectedBranch: "feature/source", expectedHead: before.head, base: fixtureState.base,
    commits: commits.map((commit, index) => ({ commit, message: `feat(ownership): ${index + 1}` })),
    destination: { mode: "new_branch", branch: "feature/taken" },
  });
  await assert.rejects(executePreparedReword(runner, prepared), (error) => {
    assert.equal((error as { result: { status?: string } }).result.status, "failed");
    return true;
  });
  assert.equal(runner.commands.some(({ args }) => args.includes("commit-tree") || args[0] === "update-ref"), false);
});

test("post-switch hook mutation makes replacement-branch reword indeterminate", async (t) => {
  const { directory, runner, sessions, base } = await fixture(t, "exit 0");
  await git(runner, directory, ["branch", "-m", "feature/source"]);
  await writeFile(join(directory, ".hooks", "post-checkout"), "#!/bin/sh\nprintf 'hook mutation\\n' > tracked.txt\n");
  await chmod(join(directory, ".hooks", "post-checkout"), 0o755);
  const before = await inspectRepository(runner, directory);
  const commits = (await git(runner, directory, ["rev-list", "--reverse", `${base}..${before.head}`])).split("\n");
  const prepared = await prepareReword(runner, sessions, before, {
    expectedBranch: "feature/source", expectedHead: before.head, base,
    commits: commits.map((commit, index) => ({ commit, message: `feat(post-checkout): ${index + 1}\n` })),
    destination: { mode: "new_branch", branch: "feature/reworded" },
  });
  await assert.rejects(executePreparedReword(runner, prepared), (error) => {
    const result = (error as { result: { status?: string; error?: { code?: string } } }).result;
    assert.equal(result.status, "indeterminate");
    assert.equal(result.error?.code, "OPERATION_INDETERMINATE");
    return true;
  });
});

test("ownership race after the final proof reconciles the visible destination ref as indeterminate", async (t) => {
  const fixtureState = await fixture(t, "exit 0");
  await git(fixtureState.runner, fixtureState.directory, ["branch", "-m", "feature/source"]);
  const linked = await mkdtemp(join(tmpdir(), "git-mcp-server-history-race-worktree-"));
  await rm(linked, { recursive: true, force: true });
  t.after(async () => { await rm(linked, { recursive: true, force: true }); });
  const runner = new OwnershipBeforeRefRunner(await resolveGitExecutable(), process.env, linked);
  const before = await inspectRepository(runner, fixtureState.directory);
  const commits = (await git(runner, fixtureState.directory, ["rev-list", "--reverse", `${fixtureState.base}..${before.head}`])).split("\n");
  const prepared = await prepareReword(runner, fixtureState.sessions, before, {
    expectedBranch: "feature/source", expectedHead: before.head, base: fixtureState.base,
    commits: commits.map((commit, index) => ({ commit, message: `feat(race): ${index + 1}` })),
    destination: { mode: "new_branch", branch: "feature/taken" },
  });
  await assert.rejects(executePreparedReword(runner, prepared), (error) => {
    const result = (error as { result: { status?: string; error?: { code?: string } } }).result;
    assert.equal(result.status, "indeterminate");
    assert.equal(result.error?.code, "OPERATION_INDETERMINATE");
    return true;
  });
  assert.notEqual(await git(runner, fixtureState.directory, ["show-ref", "--verify", "--hash", "refs/heads/feature/taken"]), before.head);
  assert.equal((await inspectRepository(runner, fixtureState.directory)).branch, "feature/source");
});

test("replacement-branch reword rejects collisions including another worktree owner before hooks", async (t) => {
  for (const scenario of ["collision", "other-worktree"] as const) {
    await t.test(scenario, async (t) => {
      const fixtureState = await fixture(t, "exit 0");
      await git(fixtureState.runner, fixtureState.directory, ["branch", "-m", "feature/source"]);
      if (scenario === "collision") {
        await git(fixtureState.runner, fixtureState.directory, ["branch", "feature/taken"]);
      } else {
        const worktree = await mkdtemp(join(tmpdir(), "git-mcp-server-history-worktree-"));
        await rm(worktree, { recursive: true, force: true });
        t.after(async () => { await rm(worktree, { recursive: true, force: true }); });
        await git(fixtureState.runner, fixtureState.directory, ["worktree", "add", "-b", "feature/taken", worktree]);
        await git(fixtureState.runner, fixtureState.directory, ["update-ref", "-d", "refs/heads/feature/taken"]);
        assert.equal((await git(fixtureState.runner, fixtureState.directory, ["worktree", "list", "--porcelain"])).includes("branch refs/heads/feature/taken"), true);
      }
      const runner = new TrackingRunner(await resolveGitExecutable(), process.env);
      const before = await inspectRepository(runner, fixtureState.directory);
      const commits = (await git(runner, fixtureState.directory, ["rev-list", "--reverse", `${fixtureState.base}..${before.head}`])).split("\n");
      await assert.rejects(prepareReword(runner, fixtureState.sessions, before, {
        expectedBranch: "feature/source", expectedHead: before.head, base: fixtureState.base,
        commits: commits.map((commit, index) => ({ commit, message: `feat(collision): ${index + 1}` })),
        destination: { mode: "new_branch", branch: "feature/taken" },
      }), /already exists|destination|worktree/i);
      assert.equal(runner.commands.some(({ args }) => args[0] === "hook" || args.includes("commit-tree") || args[0] === "update-ref"), false);
    });
  }
});

test("reports only HOOK_FAILED when the second range message is rejected", async (t) => {
  const { runner, sessions, base, head } = await fixture(t, "case \"$(head -n 1 \"$1\")\" in 'fix(second): two') exit 17 ;; esac");
  const prepared = await prepareCommitRangeValidation(runner, sessions, head, {
    expectedBranch: "main", expectedHead: head.head, base,
  });
  await assert.rejects(executePreparedCommitRangeValidation(runner, prepared), (error) => {
    assert.equal((error as { result?: unknown }).constructor.name, "ProvenMutationOutcome");
    const result = (error as { result: { error?: unknown } }).result;
    assert.deepEqual(result.error, {
      code: "HOOK_FAILED", message: "A native commit hook rejected the commit", details: { hook: "commit-msg" },
    });
    return true;
  });
});

test("a native hook that changes the worktree or refs cannot validate the range", async (t) => {
  for (const hookBody of [
    "printf 'private worktree mutation\\n' > hook-mutated.txt",
    "printf 'private index mutation\\n' > hook-index.txt\ngit add -- hook-index.txt",
    "git update-ref refs/heads/hook-mutated HEAD",
  ]) {
    const { runner, sessions, base, head } = await fixture(t, hookBody);
    const prepared = await prepareCommitRangeValidation(runner, sessions, head, {
      expectedBranch: "main", expectedHead: head.head, base,
    });
    await assert.rejects(executePreparedCommitRangeValidation(runner, prepared), (error) => {
      const result = (error as { result: { error?: { code?: string; message?: string } } }).result;
      assert.deepEqual(result.error, {
        code: "GIT_FAILED", message: "Native commit-msg hook changed the repository",
      });
      return true;
    });
  }
});

test("a hook mutation wins over its private rejection and cleans its temporary message", async (t) => {
  const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith("git-mcp-server-commit-msg-")));
  const { runner, sessions, base, head } = await fixture(t, "git update-ref refs/heads/hook-mutated HEAD\nprintf 'private reject' >&2\nexit 17");
  const prepared = await prepareCommitRangeValidation(runner, sessions, head, {
    expectedBranch: "main", expectedHead: head.head, base,
  });
  await assert.rejects(executePreparedCommitRangeValidation(runner, prepared), assertGenericMutationFailure);
  const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith("git-mcp-server-commit-msg-") && !before.has(entry));
  assert.deepEqual(after, []);
});

test("post-hook state proof receives a fresh budget after deadline, caller abort, and runner failure", async (t) => {
  await t.test("expired operation deadline", async (t) => {
    const { directory, sessions, base, head } = await fixture(t, "git update-ref refs/heads/hook-mutated HEAD\nsleep 12");
    const runner = new TrackingRunner(await resolveGitExecutable(), process.env);
    const prepared = await prepareCommitRangeValidation(runner, sessions, await inspectRepository(runner, directory), {
      expectedBranch: "main", expectedHead: head.head, base,
    });
    await assert.rejects(withDeadline(10_000, undefined, async (signal) =>
      executePreparedCommitRangeValidation(runner, prepared, signal)), assertGenericMutationFailure);
    assert.equal(runner.commands.filter(({ args }) => args[0] === "hook").length, 1);
  });

  await t.test("caller abort", async (t) => {
    const { directory, sessions, base, head } = await fixture(t, "git update-ref refs/heads/hook-mutated HEAD\nsleep 12");
    const controller = new AbortController();
    const runner = new AbortDuringHookRunner(await resolveGitExecutable(), process.env, controller);
    const prepared = await prepareCommitRangeValidation(runner, sessions, await inspectRepository(runner, directory), {
      expectedBranch: "main", expectedHead: head.head, base,
    });
    await assert.rejects(executePreparedCommitRangeValidation(runner, prepared, controller.signal), assertGenericMutationFailure);
    assert.equal(runner.commands.filter(({ args }) => args[0] === "hook").length, 1);
  });

  await t.test("runner failure", async (t) => {
    const { directory, sessions, base, head } = await fixture(t, "git update-ref refs/heads/hook-mutated HEAD");
    const runner = new ThrowAfterHookRunner(await resolveGitExecutable(), process.env);
    const prepared = await prepareCommitRangeValidation(runner, sessions, await inspectRepository(runner, directory), {
      expectedBranch: "main", expectedHead: head.head, base,
    });
    await assert.rejects(executePreparedCommitRangeValidation(runner, prepared), assertGenericMutationFailure);
    assert.equal(runner.commands.filter(({ args }) => args[0] === "hook").length, 1);
  });
});

test("wrapper setup and cleanup failures still run the mandatory proof before another hook", async () => {
  let proofs = 0;
  const setupRunner = new QueueRunner([]);
  await assert.rejects(validateMessagesWithNativeHook(
    setupRunner, "/repo", "/hooks", ["first", "second"], undefined,
    async () => { proofs += 1; },
    async () => { throw new Error("simulated wrapper setup failure"); },
  ), /setup failure/);
  assert.equal(proofs, 1);
  assert.equal(setupRunner.calls, 0);

  const cleanupRunner = new QueueRunner([commandResult()]);
  let cleanupCalls = 0;
  await assert.rejects(validateMessagesWithNativeHook(
    cleanupRunner, "/repo", "/hooks", ["first", "second"], undefined,
    async () => { proofs += 1; },
    async () => ({
      directory: "/private/wrappers", failureConsumer: () => {}, rejectedHook: () => undefined,
      nativeCommit: () => undefined,
      cleanup: async () => { cleanupCalls += 1; throw new Error("simulated wrapper cleanup failure"); },
    }),
  ), /cleanup failure/);
  assert.equal(proofs, 2);
  assert.equal(cleanupCalls, 1);
  assert.equal(cleanupRunner.calls, 1);
});

test("a mutation after the first message stops validation before the second hook can restore or reject", async (t) => {
  const { directory, base, head, sessions } = await fixture(t, [
    "case \"$(head -n 1 \"$1\")\" in",
    "  'feat(first): one') git update-ref refs/heads/hook-mutated HEAD ;;",
    "  'fix(second): two') git update-ref -d refs/heads/hook-mutated; exit 17 ;;",
    "esac",
  ].join("\n"));
  const runner = new TrackingRunner(await resolveGitExecutable(), process.env);
  const prepared = await prepareCommitRangeValidation(runner, sessions, await inspectRepository(runner, directory), {
    expectedBranch: "main", expectedHead: head.head, base,
  });
  await assert.rejects(executePreparedCommitRangeValidation(runner, prepared), (error) => {
    const result = (error as { result: { error?: unknown } }).result;
    assert.deepEqual(result.error, { code: "GIT_FAILED", message: "Native commit-msg hook changed the repository" });
    return true;
  });
  assert.equal(runner.commands.filter(({ args }) => args[0] === "hook").length, 1);
});

test("native hook diagnostics do not change success or redacted rejection semantics", async (t) => {
  const success = await fixture(t, "printf 'private stdout\\n'\nprintf 'private stderr\\n' >&2\nexit 0");
  const valid = await prepareCommitRangeValidation(success.runner, success.sessions, success.head, {
    expectedBranch: "main", expectedHead: success.head.head, base: success.base,
  });
  assert.equal((await executePreparedCommitRangeValidation(success.runner, valid)).commit_count, 2);

  const rejected = await fixture(t, "i=0\nwhile [ \"$i\" -lt 200000 ]; do printf x; i=$((i + 1)); done\nprintf 'private stderr\\n' >&2\nexit 17");
  const invalid = await prepareCommitRangeValidation(rejected.runner, rejected.sessions, rejected.head, {
    expectedBranch: "main", expectedHead: rejected.head.head, base: rejected.base,
  });
  await assert.rejects(executePreparedCommitRangeValidation(rejected.runner, invalid), (error) => {
    const result = (error as { result: { error?: unknown } }).result;
    assert.deepEqual(result.error, {
      code: "HOOK_FAILED", message: "A native commit hook rejected the commit", details: { hook: "commit-msg" },
    });
    assert.doesNotMatch(JSON.stringify(result), /private|stderr|exit|xxxxx/);
    return true;
  });
});

test("range parser accepts only NUL-framed exact same-width IDs and the 128-commit boundary", async () => {
  const base = "a".repeat(40);
  const ids = Array.from({ length: 128 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
  const head = ids.at(-1)!;
  const range = ids.map((id, index) => `${index === 0 ? "" : "\n"}${id}\0${index === 0 ? base : ids[index - 1]}\0`).join("") + "\n";
  const replies = [commandResult(), commandResult({ stdout: range }), ...ids.map((id, index) =>
    commandResult({ stdout: commitObject("f".repeat(40), index === 0 ? base : ids[index - 1]!) }))];
  const values = await inspectLinearCommitRange(new QueueRunner(replies), "/repo", base, head);
  assert.equal(values.length, 128);

  const overflow = Array.from({ length: 129 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
  const overflowRange = overflow.map((id, index) => `${index === 0 ? "" : "\n"}${id}\0${index === 0 ? base : overflow[index - 1]}\0`).join("") + "\n";
  await assert.rejects(inspectLinearCommitRange(new QueueRunner([commandResult(), commandResult({ stdout: overflowRange })]), "/repo", base, overflow.at(-1)!),
    /range|maximum|malformed/i);
});

test("complete ref comparison is linear and cooperatively bounded by reconciliation deadline", async () => {
  const lines = Array.from({ length: 50_000 }, (_, index) => `${index.toString(16).padStart(40, "0")} refs/heads/ref-${index}`);
  await withReconciliationDeadline(async (signal) => {
    assert.equal(sameRefLines(lines, [...lines].reverse(), signal), true);
  });
  assert.equal(sameRefLines(lines, [...lines.slice(0, -1), `${"f".repeat(40)} refs/heads/different`]), false);
  assert.equal(sameRefLines([lines[0]!, lines[0]!], [lines[0]!, lines[0]!]), false);

  let now = 0;
  await assert.rejects(withReconciliationDeadline(async (signal) => {
    sameRefLines(lines, lines, signal);
  }, { monotonicNow: () => { now += 10_000; return now; } }), /deadline/i);
});

test("complete ref parser requires exact repository-width object IDs and strict full refs", () => {
  const oid40 = "a".repeat(40);
  assert.deepEqual(parseRefLines(`${oid40} HEAD\n${oid40} refs/heads/main\n`, 40), [
    `${oid40} HEAD`, `${oid40} refs/heads/main`,
  ]);
  for (const width of [39, 41, 63, 65]) {
    assert.throws(() => parseRefLines(`${"b".repeat(width)} refs/heads/topic\n`, 40), /ref|object|width|malformed/i, `${width}`);
  }
  assert.throws(() => parseRefLines(`${oid40} HEAD\n${"c".repeat(64)} refs/heads/topic\n`, 40), /ref|object|width|malformed/i);
  for (const ref of ["refs/heads/topic..bad", "refs/heads/.hidden", "refs/heads/topic.lock", "refs/heads/trailing.", "refs/heads/topic@{bad}"]) {
    assert.throws(() => parseRefLines(`${oid40} ${ref}\n`, 40), /ref|malformed/i, ref);
  }
});

test("range parser rejects raw invalid UTF-8 and accepts a complete 64-bit object-id family", async () => {
  const base64 = "a".repeat(64);
  const head64 = "b".repeat(64);
  const valid64 = `${head64}\0${base64}\0\n`;
  const accepted = await inspectLinearCommitRange(new QueueRunner([
    commandResult(), commandResult({ stdout: valid64 }), commandResult({ stdout: commitObject("c".repeat(64), base64) }),
  ]), "/repo", base64, head64);
  assert.equal(accepted[0]?.commit, head64);

  await assert.rejects(inspectLinearCommitRange(new RawRangeRunner([commandResult()], [
    Buffer.concat([Buffer.from(`${head64}\0${base64}\0`), Buffer.from([0xff]), Buffer.from("\n")]),
  ]), "/repo", base64, head64), /range|object|malformed/i);
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  await assert.rejects(inspectLinearCommitRange(new QueueRunner([
    commandResult(), commandResult({ stdout: `${head}\0${base}\0\n` }),
    commandResult({ stdout: `${commitObject("c".repeat(40), base)}\uFFFD` }),
  ]), "/repo", base, head), /UTF-8|metadata|object/i);
});

test("range parser rejects malformed IDs, records, UTF-8, and commit metadata before hooks", async () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  for (const malformed of ["c".repeat(39), "c".repeat(41), "c".repeat(63), "c".repeat(65), "c".repeat(64), "c".repeat(40) + " extra", "bad\uFFFD"]) {
    const range = `${malformed}\0${base}\0\n`;
    await assert.rejects(inspectLinearCommitRange(new QueueRunner([commandResult(), commandResult({ stdout: range })]), "/repo", base, head),
      /range|object|malformed/i);
  }
  const range = `${head}\0${base}\0\n`;
  for (const object of [
    commitObject("d".repeat(41), base),
    commitObject("d".repeat(40), "e".repeat(40)),
    `tree ${"d".repeat(40)}\nparent ${base}\nauthor Test <test@example.test> 0 +0000\nauthor Duplicate <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\nmessage`,
    `tree ${"d".repeat(40)}\nparent ${base}\nparent ${base}\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\nmessage`,
    `tree ${"d".repeat(40)}\nparent ${base}\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\ngpgsig signed metadata\n continuation\n\nmessage`,
    `tree ${"d".repeat(40)}\nparent ${base}\n gpgsig continuation\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\nmessage`,
  ]) {
    await assert.rejects(inspectLinearCommitRange(new QueueRunner([commandResult(), commandResult({ stdout: range }), commandResult({ stdout: object })]), "/repo", base, head),
      /metadata|parent|object/i);
  }
});

test("private commit-message files are removed after native validation", async (t) => {
  const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith("git-mcp-server-commit-msg-")));
  const { runner, sessions, base, head } = await fixture(t, "exit 0");
  const prepared = await prepareCommitRangeValidation(runner, sessions, head, {
    expectedBranch: "main", expectedHead: head.head, base,
  });
  await executePreparedCommitRangeValidation(runner, prepared);
  const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith("git-mcp-server-commit-msg-") && !before.has(entry));
  assert.deepEqual(after, []);
});

test("dirty, detached, in-progress, active-session, and moved state reject before any hook process", async (t) => {
  for (const scenario of ["dirty", "untracked", "detached", "merge", "rebase", "cherry-pick", "session", "moved-head"] as const) {
    const { directory, runner, sessions, base, head } = await fixture(t, "exit 0");
    const tracked = new TrackingRunner(await resolveGitExecutable(), process.env);
    if (scenario === "dirty") await writeFile(join(directory, "tracked.txt"), "dirty\n");
    if (scenario === "untracked") await writeFile(join(directory, "untracked.txt"), "untracked\n");
    if (scenario === "detached") await git(runner, directory, ["switch", "--detach"]);
    if (scenario === "merge") await writeFile(join(head.gitDir, "MERGE_HEAD"), head.head);
    if (scenario === "rebase") await mkdir(join(head.gitDir, "rebase-merge"));
    if (scenario === "cherry-pick") await writeFile(join(head.gitDir, "CHERRY_PICK_HEAD"), head.head);
    if (scenario === "session") await sessions.createStageSession({
      kind: "stage", stageId: "active-stage", repositoryId: head.repositoryId, branch: "main", baseHead: head.head,
      initialIndexTree: head.indexTree, currentIndexTree: head.indexTree, ownedPaths: ["tracked.txt"],
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const current = await inspectRepository(runner, directory);
    if (scenario === "moved-head") await git(runner, directory, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "chore(move): outside"]);
    const action = async () => {
      const prepared = await prepareCommitRangeValidation(tracked, sessions, current, {
        expectedBranch: "main", expectedHead: head.head, base,
      });
      if (scenario === "moved-head") await executePreparedCommitRangeValidation(tracked, prepared);
    };
    await assert.rejects(action, /clean|detached|operation|session|head|repository|validation/i);
    assert.equal(tracked.commands.filter(({ args }) => args[0] === "hook").length, 0, scenario);
  }
});

test("branch/reference movement and real merge or signed objects reject before hooks", async (t) => {
  await t.test("named branch and base anchor movement", async (t) => {
    const { directory, runner, sessions, base, head } = await fixture(t, "git update-ref refs/heads/base-anchor HEAD");
    await git(runner, directory, ["update-ref", "refs/heads/base-anchor", base]);
    const tracked = new TrackingRunner(await resolveGitExecutable(), process.env);
    const prepared = await prepareCommitRangeValidation(tracked, sessions, await inspectRepository(tracked, directory), {
      expectedBranch: "main", expectedHead: head.head, base,
    });
    await assert.rejects(executePreparedCommitRangeValidation(tracked, prepared), assertGenericMutationFailure);
    assert.equal(tracked.commands.filter(({ args }) => args[0] === "hook").length, 1);
  });

  await t.test("actual merge commit", async (t) => {
    const { directory, runner, sessions, base } = await fixture(t, "exit 0");
    await git(runner, directory, ["switch", "-c", "side"]);
    await writeFile(join(directory, "side.txt"), "side\n");
    await git(runner, directory, ["add", "--", "side.txt"]);
    await git(runner, directory, ["commit", "--no-gpg-sign", "-m", "feat(side): commit"]);
    await git(runner, directory, ["switch", "main"]);
    await writeFile(join(directory, "main.txt"), "main\n");
    await git(runner, directory, ["add", "--", "main.txt"]);
    await git(runner, directory, ["commit", "--no-gpg-sign", "-m", "feat(main): commit"]);
    await git(runner, directory, ["merge", "--no-ff", "--no-gpg-sign", "side", "-m", "merge side"]);
    const current = await inspectRepository(runner, directory);
    const tracked = new TrackingRunner(await resolveGitExecutable(), process.env);
    await assert.rejects(prepareCommitRangeValidation(tracked, sessions, current, {
      expectedBranch: "main", expectedHead: current.head, base,
    }), /parent|linear|range|metadata/i);
    assert.equal(tracked.commands.filter(({ args }) => args[0] === "hook").length, 0);
  });

  await t.test("actual signed-header commit object", async (t) => {
    const { directory, runner, sessions, base, head } = await fixture(t, "exit 0");
    const tree = await git(runner, directory, ["rev-parse", "HEAD^{tree}"]);
    const object = [
      `tree ${tree}`, `parent ${head.head}`,
      "author Test <test@example.test> 0 +0000", "committer Test <test@example.test> 0 +0000",
      "gpgsig fake-signature", " continuation", "", "feat(signed): rejected", "",
    ].join("\n");
    const signed = await git(runner, directory, ["hash-object", "-t", "commit", "-w", "--stdin"], object);
    await git(runner, directory, ["update-ref", "refs/heads/main", signed, head.head]);
    const current = await inspectRepository(runner, directory);
    const tracked = new TrackingRunner(await resolveGitExecutable(), process.env);
    await assert.rejects(prepareCommitRangeValidation(tracked, sessions, current, {
      expectedBranch: "main", expectedHead: signed, base,
    }), /metadata|unsupported|parent/i);
    assert.equal(tracked.commands.filter(({ args }) => args[0] === "hook").length, 0);
  });
});

test("service persists only the redacted hook failure and replays it by exact request identity", async (t) => {
  const secret = "range-hook-secret-9f8a";
  const { directory, paths, base, head } = await fixture(t, `printf '${secret}\\n'\nprintf '${secret}\\n' >&2\nexit 17`);
  const runtime = await createBridgeRuntime(paths);
  const input = {
    repository: directory, request_id: "b2326b9a-5e56-4d1b-b1e2-2d6f27602222",
    expected_branch: "main", expected_head: head.head, base,
  };
  const result = await runtime.service.git_commit_range_validate(input);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, {
    code: "HOOK_FAILED", message: "A native commit hook rejected the commit", details: { hook: "commit-msg" },
  });
  const stored = await runtime.journal.get(input.request_id);
  assert.deepEqual(stored?.result, result);
  assert.doesNotMatch(JSON.stringify({ result, stored }), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify({ result, stored }), /git-mcp-server-commit-msg-|exit.?17/i);
  assert.deepEqual(await runtime.service.git_commit_range_validate(input), result);
  const reused = await runtime.service.git_commit_range_validate({ ...input, base: "a".repeat(40) });
  assert.equal(reused.error?.code, "REQUEST_ID_REUSED");
});

test("service durably replays the generic mutation-precedence failure without private hook details", async (t) => {
  const secret = "range-mutation-secret-13c2";
  const { directory, paths, base, head } = await fixture(t, `git update-ref refs/heads/hook-mutated HEAD\nprintf '${secret} stdout\\n'\nprintf '${secret} stderr\\n' >&2\nexit 17`);
  const runtime = await createBridgeRuntime(paths);
  const input = {
    repository: directory, request_id: "b2326b9a-5e56-4d1b-b1e2-2d6f27602223",
    expected_branch: "main", expected_head: head.head, base,
  };
  const result = await runtime.service.git_commit_range_validate(input);
  assert.equal(result.status, "failed");
  assert.equal(result.request_id, input.request_id);
  assert.equal(result.repository_id, head.repositoryId);
  assert.equal(result.operation, "git_commit_range_validate");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.error, { code: "GIT_FAILED", message: "Native commit-msg hook changed the repository" });
  const stored = await runtime.journal.get(input.request_id);
  assert.deepEqual(stored?.result, result);
  assert.deepEqual(await runtime.service.git_commit_range_validate(input), result);
  const reused = await runtime.service.git_commit_range_validate({ ...input, base: "a".repeat(40) });
  assert.equal(reused.error?.code, "REQUEST_ID_REUSED");
  const encoded = JSON.stringify({ result, stored, reused });
  assert.doesNotMatch(encoded, new RegExp(`${secret}|stdout|stderr|exit|git-mcp-server-commit-msg-|hook-mutated|feat\\(first\\)|fix\\(second\\)`, "i"));
  assert.equal(result.error?.details, undefined);
});

test("service durably replays a proven current-branch reword without repeating mutation", async (t) => {
  const { directory, paths, base, head, runner } = await fixture(t, "exit 0");
  await git(runner, directory, ["branch", "-m", "feature/history"]);
  const before = await inspectRepository(runner, directory);
  const commits = (await git(runner, directory, ["rev-list", "--reverse", `${base}..${before.head}`])).split("\n");
  const runtime = await createBridgeRuntime(paths);
  const input = {
    repository: directory, request_id: "b2326b9a-5e56-4d1b-b1e2-2d6f27602300",
    expected_branch: "feature/history", expected_head: before.head, base,
    commits: commits.map((commit, index) => ({ commit, message: `feat(replay): message ${index + 1}\n` })),
    destination: { mode: "current_branch" as const },
  };
  const result = await runtime.service.git_reword(input);
  assert.equal(result.status, "succeeded");
  assert.equal(result.data?.old_head, head.head);
  assert.deepEqual(await runtime.service.git_reword(input), result);
  assert.equal((await runtime.service.git_reword({ ...input, base: "a".repeat(40) })).error?.code, "REQUEST_ID_REUSED");
  assert.deepEqual((await runtime.journal.get(input.request_id))?.result, result);
});
