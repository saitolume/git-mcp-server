import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ProvenMutationOutcome } from "../src/app/mutation-coordinator.js";
import type { BridgeResult, MergeAbortData, MergeContinueData, MergeData } from "../src/domain/result.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import {
  abortMerge, addConflictPaths, continueMerge, mergeFetchedRef,
  prepareAbortMerge, prepareContinueMerge, prepareMergeFetchedRef,
  executePreparedAbort, executePreparedContinue, executePreparedMerge,
  createMergeAfterPersistCleanup, mergeIndexStateId,
} from "../src/git/merge.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { parseAllowedRemote } from "../src/git/remote.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../src/state/paths.js";
import type { FetchRecord, MergeRecord } from "../src/state/records.js";
import { mergeRecordHash } from "../src/state/session-store.js";
import { SessionStore } from "../src/state/session-store.js";

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

class MergeCommandOverrideRunner extends GitRunner {
  constructor(
    private readonly delegate: GitRunner,
    private readonly behavior: "execute-then-abort" | "unchanged-failure",
    private readonly controller?: AbortController,
  ) { super(process.execPath, process.env); }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (command.args[0] !== "merge" || command.args[1] !== "--no-gpg-sign") return this.delegate.run(command, signal);
    if (this.behavior === "unchanged-failure") return {
      exitCode: 1, signal: null, stdout: "", stderr: "private failure", stdoutTruncated: false, stderrTruncated: false,
      timedOut: false, aborted: false, durationMs: 0,
    };
    const actual = await this.delegate.run(command, signal);
    this.controller?.abort();
    return { ...actual, exitCode: null, aborted: true };
  }
}

function commandResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0, ...overrides };
}

class MutationActionRunner extends GitRunner {
  constructor(
    private readonly delegate: GitRunner,
    private readonly matches: (command: GitCommand) => boolean,
    private readonly action: (command: GitCommand) => Promise<GitCommandResult>,
  ) { super(process.execPath, process.env); }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    return this.matches(command) ? this.action(command) : this.delegate.run(command, signal);
  }
}

function outcome<T>(error: unknown): ProvenMutationOutcome<T> {
  assert.ok(error instanceof ProvenMutationOutcome);
  return error as ProvenMutationOutcome<T>;
}

async function git(runner: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 15_000, maxOutputBytes: 128_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function commit(runner: GitRunner, cwd: string, path: string, body: string, message: string): Promise<string> {
  await writeFile(join(cwd, path), body);
  await git(runner, cwd, ["add", "--", path]);
  await git(runner, cwd, ["commit", "--no-gpg-sign", "-m", message]);
  return git(runner, cwd, ["rev-parse", "HEAD"]);
}

interface Fixture {
  root: string; local: string; source: string; runner: TrackingRunner; sessions: SessionStore; paths: StatePaths;
  before: RepositorySnapshot; fetch: FetchRecord; target: string;
}

async function fixture(t: test.TestContext, diverged = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-merge-"));
  const state = await mkdtemp(join(tmpdir(), "git-mcp-server-merge-state-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
  let runner = new TrackingRunner(await resolveGitExecutable(), process.env);
  const source = join(root, "source"); const local = join(root, "local"); const bare = join(root, "remote.git");
  await mkdir(source);
  await git(runner, source, ["init", "--initial-branch=main"]);
  for (const repository of [source]) {
    await git(runner, repository, ["config", "user.name", "Bridge Test"]);
    await git(runner, repository, ["config", "user.email", "bridge@example.test"]);
  }
  await commit(runner, source, "shared.txt", "base\n", "base");
  await git(runner, root, ["init", "--bare", bare]);
  await git(runner, source, ["remote", "add", "origin", bare]);
  await git(runner, source, ["push", "origin", "main"]);
  await git(runner, root, ["clone", "--branch", "main", bare, local]);
  await git(runner, local, ["config", "user.name", "Bridge Test"]);
  await git(runner, local, ["config", "user.email", "bridge@example.test"]);
  const shim = join(root, "bin"); await mkdir(shim);
  const execPath = await git(runner, root, ["--exec-path"]);
  const ssh = `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");\nconst command=process.argv.at(-1);\nconst expected=${JSON.stringify(`git-upload-pack '${bare}'`)};\nif(command!==expected)process.exit(90);\nconst child=spawnSync(${JSON.stringify(join(execPath, "git-upload-pack"))},[${JSON.stringify(bare)}],{stdio:"inherit",env:process.env});\nprocess.exit(child.status??91);\n`;
  await writeFile(join(shim, "ssh"), ssh); await chmod(join(shim, "ssh"), 0o755);
  runner = new TrackingRunner(await resolveGitExecutable(), { ...process.env, PATH: `${shim}${delimiter}${process.env.PATH ?? ""}` });
  const origin = `git@fixture:${bare}`;
  await git(runner, local, ["remote", "set-url", "origin", origin]);
  const before = await inspectRepository(runner, local);
  if (diverged) await commit(runner, local, "local.txt", "local\n", "local");
  const target = await commit(runner, source, "remote.txt", "remote\n", "remote");
  await git(runner, source, ["push", "origin", "main"]);
  await git(runner, local, ["fetch", "origin"]);
  const snapshot = await inspectRepository(runner, local);
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: state, env: {} }));
  const sessions = new SessionStore(paths);
  const fetch: FetchRecord = {
    kind: "fetch", fetchId: "fetch-1", repositoryId: snapshot.repositoryId, branch: "main", head: snapshot.head,
    remoteIdentity: parseAllowedRemote(origin),
    refsBefore: {}, refsAfter: { "refs/remotes/origin/main": target }, fetchedAt: "2026-07-19T00:00:00.000Z",
  };
  await sessions.createFetch(fetch);
  runner.commands.length = 0;
  return { root, local, source, runner, sessions, paths, before: snapshot, fetch, target };
}

function request(value: Fixture) {
  return { expectedBranch: "main", expectedHead: value.before.head, fetchId: value.fetch.fetchId,
    remoteRef: "refs/remotes/origin/main", expectedRemoteObject: value.target };
}

test("merge session fast-forwards only an exact fetched origin ref with exact mutation argv", async (t) => {
  const f = await fixture(t);
  const result = await mergeFetchedRef(f.runner, f.sessions, f.before, request(f));
  assert.deepEqual(result.data, { head: f.target, merge_session_id: null, conflicted_paths: [] });
  assert.deepEqual(f.runner.commands.find(({ args }) => args[0] === "merge")?.args, ["merge", "--no-gpg-sign", f.target]);
  assert.equal((await inspectRepository(f.runner, f.local)).head, f.target);
});

test("merge session creates a valid two-parent merge commit", async (t) => {
  const f = await fixture(t, true);
  await git(f.runner, f.local, ["config", "commit.gpgSign", "true"]);
  await git(f.runner, f.local, ["config", "gpg.program", "/definitely/missing/gpg"]);
  const head = f.before.head;
  const result = await mergeFetchedRef(f.runner, f.sessions, f.before, request(f));
  assert.equal(await git(f.runner, f.local, ["rev-parse", result.data.head + "^1"]), head);
  assert.equal(await git(f.runner, f.local, ["rev-parse", result.data.head + "^2"]), f.target);
});

test("merge session accepts real already-up-to-date only after proving target ancestry", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["merge", "--ff-only", f.target]);
  await commit(f.runner, f.local, "local-after.txt", "later\n", "local after remote");
  const local = await inspectRepository(f.runner, f.local);
  await f.sessions.deleteFetch(f.fetch.fetchId);
  const fetch = { ...f.fetch, head: local.head };
  await f.sessions.createFetch(fetch);
  f.runner.commands.length = 0;

  const result = await mergeFetchedRef(f.runner, f.sessions, local, {
    expectedBranch: "main", expectedHead: local.head, fetchId: fetch.fetchId,
    remoteRef: "refs/remotes/origin/main", expectedRemoteObject: f.target,
  });
  assert.deepEqual(result.data, { head: local.head, merge_session_id: null, conflicted_paths: [] });
  assert.deepEqual(f.runner.commands.find(({ args }) => args[0] === "merge")?.args, ["merge", "--no-gpg-sign", f.target]);
});

test("already-up-to-date proof never converts a non-success command at the same HEAD into success", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["merge", "--ff-only", f.target]);
  const local = await inspectRepository(f.runner, f.local);
  await f.sessions.deleteFetch(f.fetch.fetchId);
  const fetch = { ...f.fetch, head: local.head };
  await f.sessions.createFetch(fetch);
  const prepared = await prepareMergeFetchedRef(f.runner, f.sessions, local, {
    expectedBranch: "main", expectedHead: local.head, fetchId: fetch.fetchId,
    remoteRef: "refs/remotes/origin/main", expectedRemoteObject: local.head,
  });
  let caught: unknown;
  try { await executePreparedMerge(new MergeCommandOverrideRunner(f.runner, "unchanged-failure"), f.sessions, prepared); }
  catch (error) { caught = error; }
  assert.equal(outcome<MergeData>(caught).result.status, "failed");
});

test("merge session rejects forged fast-forward ancestry and extra-parent merge topology", async (t) => {
  await t.test("unrelated target moved into HEAD", async (t) => {
    const f = await fixture(t, true);
    const prepared = await prepareMergeFetchedRef(f.runner, f.sessions, f.before, request(f));
    const forged = new MutationActionRunner(f.runner, ({ args }) => args[0] === "merge" && args[1] === "--no-gpg-sign", async () => {
      await git(f.runner, f.local, ["update-ref", "HEAD", f.target]);
      return commandResult();
    });
    let caught: unknown; try { await executePreparedMerge(forged, f.sessions, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeData>(caught).result.status, "indeterminate");
  });
  await t.test("extra parent proof", async (t) => {
    const f = await fixture(t, true);
    const prepared = await prepareMergeFetchedRef(f.runner, f.sessions, f.before, request(f));
    const forged = new MutationActionRunner(f.runner, ({ args }) => args[0] === "rev-list" && args[1] === "--parents", async (command) => {
      const head = command.args.at(-1)!;
      return commandResult({ stdout: `${head} ${f.before.head} ${f.target} ${f.before.head}\n` });
    });
    let caught: unknown; try { await executePreparedMerge(forged, f.sessions, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeData>(caught).result.status, "indeterminate");
  });
  await t.test("wrong parent order proof", async (t) => {
    const f = await fixture(t, true);
    const prepared = await prepareMergeFetchedRef(f.runner, f.sessions, f.before, request(f));
    const forged = new MutationActionRunner(f.runner, ({ args }) => args[0] === "rev-list" && args[1] === "--parents", async (command) => {
      const head = command.args.at(-1)!;
      return commandResult({ stdout: `${head} ${f.target} ${f.before.head}\n` });
    });
    let caught: unknown; try { await executePreparedMerge(forged, f.sessions, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeData>(caught).result.status, "indeterminate");
  });
});

test("merge session rejects an unobserved or moved ref before issuing merge", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareMergeFetchedRef(f.runner, f.sessions, f.before, { ...request(f), expectedRemoteObject: f.before.head }));
  await git(f.runner, f.local, ["update-ref", "refs/remotes/origin/main", f.before.head]);
  await assert.rejects(prepareMergeFetchedRef(f.runner, f.sessions, f.before, request(f)));
  assert.equal(f.runner.commands.some(({ args }) => args[0] === "merge"), false);
});

test("merge session proves success after caller cancellation and classifies an unchanged nonzero failure", async (t) => {
  await t.test("post-cancellation success proof", async (t) => {
    const f = await fixture(t); const controller = new AbortController();
    const prepared = await prepareMergeFetchedRef(f.runner, f.sessions, f.before, request(f));
    const outcome = await executePreparedMerge(new MergeCommandOverrideRunner(f.runner, "execute-then-abort", controller), f.sessions, prepared, controller.signal);
    assert.equal(controller.signal.aborted, true);
    assert.equal(outcome.data.head, f.target);
    assert.ok(outcome.warnings.length > 0);
  });
  await t.test("unchanged failure", async (t) => {
    const f = await fixture(t);
    const prepared = await prepareMergeFetchedRef(f.runner, f.sessions, f.before, request(f));
    let caught: unknown;
    try { await executePreparedMerge(new MergeCommandOverrideRunner(f.runner, "unchanged-failure"), f.sessions, prepared); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof ProvenMutationOutcome);
    assert.equal((caught as ProvenMutationOutcome<MergeData>).result.error?.code, "GIT_FAILED");
    assert.equal((await inspectRepository(f.runner, f.local)).head, f.before.head);
  });
});

async function conflictFixture(t: test.TestContext): Promise<Fixture> {
  const f = await fixture(t);
  await git(f.runner, f.local, ["reset", "--hard", f.before.head]);
  await commit(f.runner, f.local, "shared.txt", "local\n", "local conflict");
  const local = await inspectRepository(f.runner, f.local);
  await git(f.runner, f.source, ["reset", "--hard", f.before.head]);
  const target = await commit(f.runner, f.source, "shared.txt", "remote\n", "remote conflict");
  await git(f.runner, f.source, ["push", "--force", "origin", "main"]);
  await git(f.runner, f.local, ["fetch", "origin"]);
  const fetch: FetchRecord = { ...f.fetch, head: local.head, refsAfter: { "refs/remotes/origin/main": target } };
  await f.sessions.deleteFetch(f.fetch.fetchId); await f.sessions.createFetch(fetch);
  f.runner.commands.length = 0;
  return { ...f, before: local, fetch, target };
}

async function startConflict(f: Fixture, mergeSessionId: string): Promise<MergeRecord> {
  let caught: unknown;
  try { await mergeFetchedRef(f.runner, f.sessions, f.before, request(f), undefined, { generateId: () => mergeSessionId }); }
  catch (error) { caught = error; }
  assert.equal(outcome<MergeData>(caught).result.status, "conflicted");
  const record = await f.sessions.getMerge(mergeSessionId); assert.ok(record); return record;
}

async function twoConflictFixture(t: test.TestContext): Promise<Fixture> {
  const f = await fixture(t);
  await git(f.runner, f.local, ["reset", "--hard", f.before.head]);
  await writeFile(join(f.local, "a.txt"), "local a\n"); await writeFile(join(f.local, "b.txt"), "local b\n");
  await git(f.runner, f.local, ["add", "--", "a.txt", "b.txt"]); await git(f.runner, f.local, ["commit", "--no-gpg-sign", "-m", "local conflicts"]);
  const local = await inspectRepository(f.runner, f.local);
  await git(f.runner, f.source, ["reset", "--hard", f.before.head]);
  await writeFile(join(f.source, "a.txt"), "remote a\n"); await writeFile(join(f.source, "b.txt"), "remote b\n");
  await git(f.runner, f.source, ["add", "--", "a.txt", "b.txt"]); await git(f.runner, f.source, ["commit", "--no-gpg-sign", "-m", "remote conflicts"]);
  const target = await git(f.runner, f.source, ["rev-parse", "HEAD"]);
  await git(f.runner, f.source, ["push", "--force", "origin", "main"]); await git(f.runner, f.local, ["fetch", "origin"]);
  const fetch = { ...f.fetch, head: local.head, refsAfter: { "refs/remotes/origin/main": target } };
  await f.sessions.deleteFetch(f.fetch.fetchId); await f.sessions.createFetch(fetch); f.runner.commands.length = 0;
  return { ...f, before: local, fetch, target };
}

test("merge session reports conflict, tracks exact index state, resolves and continues", async (t) => {
  const f = await conflictFixture(t);
  let caught: unknown;
  try { await mergeFetchedRef(f.runner, f.sessions, f.before, request(f), undefined, { generateId: () => "merge-1", now: () => "2026-07-19T01:00:00.000Z" }); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof ProvenMutationOutcome);
  const conflict = (caught as ProvenMutationOutcome<MergeData>).result;
  assert.equal(conflict.status, "conflicted");
  assert.deepEqual(conflict.data?.conflicted_paths, ["shared.txt"]);
  const stored = await f.sessions.getMerge("merge-1"); assert.ok(stored);
  assert.equal(stored.currentIndexTree, mergeIndexStateId((await inspectRepository(f.runner, f.local)).indexTree));

  await writeFile(join(f.local, "shared.txt"), "resolved\n");
  const added = await addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
    expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "merge-1", paths: ["shared.txt"],
  });
  assert.deepEqual(added.unresolved_paths, []);
  assert.deepEqual([...f.runner.commands].reverse().find(({ args }) => args[0] === "add")?.args, ["add", "--", "shared.txt"]);
  await mkdir(join(f.local, ".hooks"));
  await writeFile(join(f.local, ".hooks", "commit-msg"), "#!/bin/sh\nprintf ran > hook-ran\n");
  await chmod(join(f.local, ".hooks", "commit-msg"), 0o755);
  await git(f.runner, f.local, ["config", "core.hooksPath", ".hooks"]);
  await git(f.runner, f.local, ["config", "commit.gpgSign", "true"]);
  await git(f.runner, f.local, ["config", "gpg.program", "/definitely/missing/gpg"]);
  const continued = await continueMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
    expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "merge-1",
  });
  assert.equal(await git(f.runner, f.local, ["rev-parse", continued.data.commit + "^1"]), f.before.head);
  assert.equal(await git(f.runner, f.local, ["rev-parse", continued.data.commit + "^2"]), f.target);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(f.local, "hook-ran"), "utf8")), "ran");
  assert.deepEqual(f.runner.commands.find(({ args }) => args[0] === "-c")?.args, ["-c", "commit.gpgSign=false", "merge", "--continue"]);
});

test("merge conflict add resolves a real deletion and a real symlink with exact add argv", async (t) => {
  await t.test("deletion", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "delete-resolution");
    await unlink(join(f.local, "shared.txt"));
    const added = await addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "delete-resolution", paths: ["shared.txt"],
    });
    assert.deepEqual(added.unresolved_paths, []);
    assert.deepEqual([...f.runner.commands].reverse().find(({ args }) => args[0] === "add")?.args, ["add", "--", "shared.txt"]);
    assert.ok(f.runner.commands.some(({ args }) => args.join(" ") === "ls-files --stage -z"));
  });
  await t.test("symlink", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "symlink-resolution");
    await unlink(join(f.local, "shared.txt")); await symlink("resolved-target", join(f.local, "shared.txt"));
    const added = await addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "symlink-resolution", paths: ["shared.txt"],
    });
    assert.deepEqual(added.unresolved_paths, []);
    assert.deepEqual([...f.runner.commands].reverse().find(({ args }) => args[0] === "add")?.args, ["add", "--", "shared.txt"]);
    assert.ok(f.runner.commands.some(({ args }) => args.join(" ") === "ls-files --stage -z"));
  });
});

test("merge conflict add rejects concurrent effects outside the exact requested path set", async (t) => {
  await t.test("unrequested conflict also resolves", async (t) => {
    const f = await twoConflictFixture(t); const original = await startConflict(f, "exact-conflicts");
    await writeFile(join(f.local, "a.txt"), "resolved a\n"); await writeFile(join(f.local, "b.txt"), "resolved b\n");
    const runner = new MutationActionRunner(f.runner, ({ args }) => args[0] === "add" && args[1] === "--", async (command) => {
      const result = await f.runner.run(command);
      await git(f.runner, f.local, ["add", "--", "b.txt"]);
      return result;
    });
    let caught: unknown;
    try { await addConflictPaths(runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "exact-conflicts", paths: ["a.txt"],
    }); } catch (error) { caught = error; }
    assert.equal(outcome<unknown>(caught).result.status, "indeterminate");
    assert.equal(mergeRecordHash((await f.sessions.getMerge("exact-conflicts"))!), mergeRecordHash(original));
  });
  await t.test("new unrelated stage-zero entry appears", async (t) => {
    const f = await twoConflictFixture(t); const original = await startConflict(f, "exact-unrelated");
    await writeFile(join(f.local, "a.txt"), "resolved a\n");
    const runner = new MutationActionRunner(f.runner, ({ args }) => args[0] === "add" && args[1] === "--", async (command) => {
      const result = await f.runner.run(command);
      await writeFile(join(f.local, "unrelated.txt"), "unrelated\n"); await git(f.runner, f.local, ["add", "--", "unrelated.txt"]);
      return result;
    });
    let caught: unknown;
    try { await addConflictPaths(runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "exact-unrelated", paths: ["a.txt"],
    }); } catch (error) { caught = error; }
    assert.equal(outcome<unknown>(caught).result.status, "indeterminate");
    assert.equal(mergeRecordHash((await f.sessions.getMerge("exact-unrelated"))!), mergeRecordHash(original));
  });
});

test("non-success merge lifecycle outcomes are failed only when complete pre-state is unchanged", async (t) => {
  await t.test("merge start worktree-only change", async (t) => {
    const f = await fixture(t); const prepared = await prepareMergeFetchedRef(f.runner, f.sessions, f.before, request(f));
    const runner = new MutationActionRunner(f.runner, ({ args }) => args[0] === "merge" && args[1] === "--no-gpg-sign", async () => {
      await writeFile(join(f.local, "shared.txt"), "changed during failed merge\n");
      return commandResult({ exitCode: 1, stderr: "failed" });
    });
    let caught: unknown; try { await executePreparedMerge(runner, f.sessions, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeData>(caught).result.status, "indeterminate");
  });
  await t.test("continue hook worktree-only change", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "continue-worktree");
    await writeFile(join(f.local, "shared.txt"), "resolved\n");
    await addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "continue-worktree", paths: ["shared.txt"],
    });
    await mkdir(join(f.local, ".hooks"));
    await writeFile(join(f.local, ".hooks", "commit-msg"), "#!/bin/sh\nprintf changed > shared.txt\nexit 1\n");
    await chmod(join(f.local, ".hooks", "commit-msg"), 0o755); await git(f.runner, f.local, ["config", "core.hooksPath", ".hooks"]);
    let caught: unknown;
    try { await continueMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "continue-worktree",
    }); } catch (error) { caught = error; }
    assert.equal(outcome<MergeContinueData>(caught).result.status, "indeterminate");
  });
  await t.test("abort partial worktree change", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "abort-partial");
    const runner = new MutationActionRunner(f.runner, ({ args }) => args[0] === "merge" && args[1] === "--abort", async () => {
      await writeFile(join(f.local, "shared.txt"), "partial abort\n");
      return commandResult({ exitCode: 1, stderr: "failed" });
    });
    let caught: unknown;
    try { await abortMerge(runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "abort-partial",
    }); } catch (error) { caught = error; }
    assert.equal(outcome<MergeAbortData>(caught).result.status, "indeterminate");
  });
  await t.test("continue index-only change", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "continue-index");
    await writeFile(join(f.local, "shared.txt"), "resolved\n");
    await addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "continue-index", paths: ["shared.txt"],
    });
    await writeFile(join(f.local, "other.txt"), "other\n");
    const prepared = await prepareContinueMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "continue-index",
    });
    const runner = new MutationActionRunner(f.runner, ({ args }) => args[0] === "-c" && args[2] === "merge", async () => {
      await git(f.runner, f.local, ["add", "--", "other.txt"]);
      return commandResult({ exitCode: 1, stderr: "failed" });
    });
    let caught: unknown; try { await executePreparedContinue(runner, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeContinueData>(caught).result.status, "indeterminate");
  });
  await t.test("abort unresolved proof changes", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "abort-unresolved");
    const prepared = await prepareAbortMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "abort-unresolved",
    });
    const runner = new MutationActionRunner(f.runner,
      ({ args }) => args.join(" ") === "merge --abort" || args.join(" ") === "diff --name-only --diff-filter=U -z --no-renames --",
      async (command) => command.args[0] === "merge"
        ? commandResult({ exitCode: 1, stderr: "failed" })
        : commandResult({ stdout: "" }),
    );
    let caught: unknown; try { await executePreparedAbort(runner, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeAbortData>(caught).result.status, "indeterminate");
  });
  await t.test("unchanged continue is an ordinary failure", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "continue-unchanged");
    await writeFile(join(f.local, "shared.txt"), "resolved\n");
    await addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "continue-unchanged", paths: ["shared.txt"],
    });
    const prepared = await prepareContinueMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "continue-unchanged",
    });
    const runner = new MutationActionRunner(f.runner, ({ args }) => args[0] === "-c" && args[2] === "merge", async () => commandResult({ exitCode: 1, stderr: "failed" }));
    let caught: unknown; try { await executePreparedContinue(runner, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeContinueData>(caught).result.status, "failed");
  });
  await t.test("unchanged abort is an ordinary failure", async (t) => {
    const f = await conflictFixture(t); await startConflict(f, "abort-unchanged");
    const prepared = await prepareAbortMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
      expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "abort-unchanged",
    });
    const runner = new MutationActionRunner(f.runner, ({ args }) => args.join(" ") === "merge --abort", async () => commandResult({ exitCode: 1, stderr: "failed" }));
    let caught: unknown; try { await executePreparedAbort(runner, prepared); } catch (error) { caught = error; }
    assert.equal(outcome<MergeAbortData>(caught).result.status, "failed");
  });
});

test("merge session abort restores the original HEAD and only cleanup removes owned state", async (t) => {
  const f = await conflictFixture(t);
  let conflict!: BridgeResult<MergeData>;
  try { await mergeFetchedRef(f.runner, f.sessions, f.before, request(f), undefined, { generateId: () => "merge-abort" }); }
  catch (error) { assert.ok(error instanceof ProvenMutationOutcome); conflict = error.result as BridgeResult<MergeData>; }
  const aborted = await abortMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
    expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "merge-abort",
  });
  assert.deepEqual(aborted.data, { head: f.before.head });
  assert.deepEqual([...f.runner.commands].reverse().find(({ args }) => args[0] === "merge")?.args, ["merge", "--abort"]);
  assert.ok(await f.sessions.getMerge("merge-abort"));
  const record = await f.sessions.getMerge("merge-abort") as MergeRecord;
  const cleanup = createMergeAfterPersistCleanup(f.sessions, {
    requestId: "request-1", repositoryId: record.repositoryId, operation: "git_merge_abort",
    mergeSessionId: record.mergeSessionId, expectedBranch: record.branch, expectedHead: record.originalHead,
  });
  const durable: BridgeResult<MergeAbortData> = {
    status: "succeeded", request_id: "request-1", repository_id: record.repositoryId, operation: "git_merge_abort",
    observed_before: { merge_session_id: record.mergeSessionId, merge_record_hash: mergeRecordHash(record), branch: record.branch, original_head: record.originalHead },
    data: aborted.data, warnings: [],
  };
  await cleanup(durable); await cleanup(durable);
  assert.equal(await f.sessions.getMerge("merge-abort"), null);
  assert.equal(await f.sessions.getActiveSession(record.repositoryId), null);
  assert.equal(conflict.data?.merge_session_id, "merge-abort");
});

test("merge session rejects external merge metadata and out-of-band index changes", async (t) => {
  const f = await conflictFixture(t);
  await git(f.runner, f.local, ["merge", f.target]).catch(() => "");
  await assert.rejects(abortMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
    expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "external",
  }));

  await git(f.runner, f.local, ["merge", "--abort"]);
  try { await mergeFetchedRef(f.runner, f.sessions, f.before, request(f), undefined, { generateId: () => "owned" }); } catch { /* conflict */ }
  await writeFile(join(f.local, "other.txt"), "other\n"); await git(f.runner, f.local, ["add", "--", "other.txt"]);
  await assert.rejects(addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
    expectedBranch: "main", expectedHead: f.before.head, mergeSessionId: "owned", paths: ["shared.txt"],
  }));
});

test("merge record hashes bind current index and Git-output conflict paths", async () => {
  const record: MergeRecord = {
    kind: "merge", mergeSessionId: "m", repositoryId: "a".repeat(64), branch: "main",
    originalHead: "b".repeat(40), targetObject: "c".repeat(40), fetchId: "f", currentIndexTree: "d".repeat(64),
    conflictedPaths: [":legal-output"], resolvedPaths: [], createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
  assert.match(mergeRecordHash(record), /^[0-9a-f]{64}$/);
});

test("merge session persistence is immutable, resumes marker-orphan creation, and cleanup resumes after record unlink", async (t) => {
  const f = await fixture(t);
  const record: MergeRecord = {
    kind: "merge", mergeSessionId: "crash-window", repositoryId: f.before.repositoryId, branch: "main",
    originalHead: f.before.head, targetObject: f.target, fetchId: f.fetch.fetchId, currentIndexTree: "d".repeat(64),
    conflictedPaths: [":special"], resolvedPaths: [], createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
  await f.sessions.createMerge(record);
  await assert.rejects(f.sessions.putMerge({ ...record, updatedAt: "2026-07-19T00:00:01.000Z" }), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  await f.sessions.deleteMerge(record.mergeSessionId);

  const { atomicCreateJson } = await import("../src/state/atomic-json.js");
  await atomicCreateJson(join(f.paths.stages, `.active-${record.repositoryId}.json`), {
    kind: "session-activity", repositoryId: record.repositoryId, sessionKind: "merge", sessionId: record.mergeSessionId,
  });
  await f.sessions.createMergeSession(record);
  assert.deepEqual(await f.sessions.getMerge(record.mergeSessionId), record);

  const crashing = new SessionStore(f.paths, { afterMergeRecordUnlink: async () => { throw new Error("crash"); } });
  await assert.rejects(crashing.deleteMergeSessionByIdentity({ repositoryId: record.repositoryId, mergeSessionId: record.mergeSessionId, recordHash: mergeRecordHash(record) }), /crash/);
  assert.equal(await f.sessions.getMerge(record.mergeSessionId), null);
  assert.ok(await f.sessions.getActiveSession(record.repositoryId));
  await f.sessions.deleteMergeSessionByIdentity({ repositoryId: record.repositoryId, mergeSessionId: record.mergeSessionId, recordHash: mergeRecordHash(record) });
  await f.sessions.deleteMergeSessionByIdentity({ repositoryId: record.repositoryId, mergeSessionId: record.mergeSessionId, recordHash: mergeRecordHash(record) });
  assert.equal(await f.sessions.getActiveSession(record.repositoryId), null);
});

test("special legal conflict output is reported and cannot become an input pathspec, but remains abortable", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["reset", "--hard", f.before.head]);
  await writeFile(join(f.local, ":special"), "local\n");
  await git(f.runner, f.local, ["--literal-pathspecs", "add", "--", ":special"]);
  await git(f.runner, f.local, ["commit", "--no-gpg-sign", "-m", "local special"]);
  const local = await inspectRepository(f.runner, f.local);
  await git(f.runner, f.source, ["reset", "--hard", f.before.head]);
  await writeFile(join(f.source, ":special"), "remote\n");
  await git(f.runner, f.source, ["--literal-pathspecs", "add", "--", ":special"]);
  await git(f.runner, f.source, ["commit", "--no-gpg-sign", "-m", "remote special"]);
  const target = await git(f.runner, f.source, ["rev-parse", "HEAD"]);
  await git(f.runner, f.source, ["push", "--force", "origin", "main"]); await git(f.runner, f.local, ["fetch", "origin"]);
  await f.sessions.deleteFetch(f.fetch.fetchId);
  await f.sessions.createFetch({ ...f.fetch, head: local.head, refsAfter: { "refs/remotes/origin/main": target } });
  let conflict!: BridgeResult<MergeData>;
  try { await mergeFetchedRef(f.runner, f.sessions, local, { ...request(f), expectedHead: local.head, expectedRemoteObject: target }, undefined, { generateId: () => "special" }); }
  catch (error) { assert.ok(error instanceof ProvenMutationOutcome); conflict = error.result as BridgeResult<MergeData>; }
  assert.deepEqual(conflict.data?.conflicted_paths, [":special"]);
  await assert.rejects(addConflictPaths(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
    expectedBranch: "main", expectedHead: local.head, mergeSessionId: "special", paths: [":special"],
  }));
  const aborted = await abortMerge(f.runner, f.sessions, await inspectRepository(f.runner, f.local), {
    expectedBranch: "main", expectedHead: local.head, mergeSessionId: "special",
  });
  assert.equal(aborted.data.head, local.head);
});
