import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executePreparedCommitRangeValidation,
  prepareCommitRangeValidation,
} from "../src/git/history.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner } from "../src/git/runner.js";
import { initializeStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { SessionStore } from "../src/state/session-store.js";

async function git(runner: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 10_000, maxOutputBytes: 64_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t: test.TestContext, hookBody: string): Promise<{
  directory: string; runner: GitRunner; sessions: SessionStore; base: string; head: RepositorySnapshot;
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
  return { directory, runner, sessions: new SessionStore(paths), base, head };
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
