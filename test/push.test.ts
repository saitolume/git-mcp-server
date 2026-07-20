import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ProvenMutationOutcome } from "../src/app/mutation-coordinator.js";
import { BridgeRejection, pushDataSchema, type PushData } from "../src/domain/result.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import {
  executePreparedPush,
  preparePushOrigin,
  preparedPushObservation,
  pushCurrentBranch,
  readRemoteBranchHead,
  type PreparedPush,
} from "../src/git/remote.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";

function commandResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0, ...overrides,
  };
}

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

class QueueRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  constructor(private readonly replies: readonly (GitCommandResult | Error)[]) { super(process.execPath, process.env); }
  override async run(command: GitCommand): Promise<GitCommandResult> {
    this.commands.push(command);
    const reply = this.replies[this.commands.length - 1];
    if (reply === undefined) throw new Error("Unexpected command");
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

class PushOutcomeRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  constructor(
    private readonly delegate: GitRunner,
    private readonly pushOutcome: GitCommandResult | Error | "push-then-fail" | "push-then-timeout" | "push-then-cancel",
  ) { super(process.execPath, process.env); }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    if (command.args[0] !== "push") return this.delegate.run(command, signal);
    if (this.pushOutcome === "push-then-fail" || this.pushOutcome === "push-then-timeout" || this.pushOutcome === "push-then-cancel") {
      await this.delegate.run(command, signal);
      if (this.pushOutcome === "push-then-timeout") return commandResult({ exitCode: null, timedOut: true });
      if (this.pushOutcome === "push-then-cancel") return commandResult({ exitCode: null, aborted: true });
      return commandResult({ exitCode: 1, stderr: "private transport diagnostic" });
    }
    if (this.pushOutcome instanceof Error) throw this.pushOutcome;
    return this.pushOutcome;
  }
}

class AfterPushActionRunner extends GitRunner {
  constructor(private readonly delegate: GitRunner, private readonly action: () => Promise<void>) {
    super(process.execPath, process.env);
  }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    const result = await this.delegate.run(command, signal);
    if (command.args[0] === "push") await this.action();
    return result;
  }
}

class AfterFirstRemoteReadRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  private reads = 0;
  constructor(private readonly delegate: GitRunner, private readonly action: () => Promise<void>) {
    super(process.execPath, process.env);
  }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    const result = await this.delegate.run(command, signal);
    if (command.args[0] === "ls-remote" && ++this.reads === 1) await this.action();
    return result;
  }
}

async function git(runner: GitRunner, cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 15_000, maxOutputBytes: 128_000, ...(stdin === undefined ? {} : { stdin }) });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function hasRef(runner: GitRunner, cwd: string, ref: string): Promise<boolean> {
  const result = await runner.run({ cwd, args: ["show-ref", "--verify", "--quiet", ref], timeoutMs: 15_000, maxOutputBytes: 8_192 });
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(result.exitCode === 0 || result.exitCode === 1);
  return result.exitCode === 0;
}

async function commit(runner: GitRunner, directory: string, name: string, content: string): Promise<string> {
  await writeFile(join(directory, name), content);
  await git(runner, directory, ["add", "--", name]);
  await git(runner, directory, ["commit", "--no-gpg-sign", "-m", content.trim()]);
  return git(runner, directory, ["rev-parse", "HEAD"]);
}

async function hook(directory: string, body: string): Promise<void> {
  const path = join(directory, ".hooks", "pre-push");
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
}

interface PushFixture {
  readonly root: string;
  readonly local: string;
  readonly other: string;
  readonly bare: string;
  readonly origin: string;
  readonly runner: TrackingRunner;
  readonly bootstrap: GitRunner;
  readonly initial: RepositorySnapshot;
}

async function fixture(t: test.TestContext): Promise<PushFixture> {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-push-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const bootstrap = new GitRunner(await resolveGitExecutable(), process.env);
  const local = join(root, "local");
  const other = join(root, "other");
  const bare = join(root, "remote.git");
  const shim = join(root, "bin");
  await mkdir(local);
  await git(bootstrap, local, ["init", "--initial-branch=main"]);
  await git(bootstrap, local, ["config", "user.name", "git-mcp-server Test"]);
  await git(bootstrap, local, ["config", "user.email", "git-mcp-server@example.test"]);
  await mkdir(join(local, ".hooks"));
  await git(bootstrap, local, ["config", "core.hooksPath", ".hooks"]);
  await commit(bootstrap, local, "tracked.txt", "one\n");
  await git(bootstrap, root, ["init", "--bare", bare]);

  const execPath = await git(bootstrap, root, ["--exec-path"]);
  await mkdir(shim);
  const upload = join(execPath, "git-upload-pack");
  const receive = join(execPath, "git-receive-pack");
  const ssh = `#!/usr/bin/env node\n`
    + `const { spawnSync } = require("node:child_process");\n`
    + `const args = process.argv.slice(2);\n`
    + `const command = args.at(-1);\n`
    + `const host = args.at(-2);\n`
    + `const options = args.slice(0, -2).join(" ");\n`
    + `if (host !== "git@fixture" || (options !== "" && options !== "-o SendEnv=GIT_PROTOCOL")) process.exit(90);\n`
    + `const uploadCommand = ${JSON.stringify(`git-upload-pack '${bare}'`)};\n`
    + `const receiveCommand = ${JSON.stringify(`git-receive-pack '${bare}'`)};\n`
    + `const helper = command === uploadCommand ? ${JSON.stringify(upload)} : command === receiveCommand ? ${JSON.stringify(receive)} : null;\n`
    + `if (helper === null) process.exit(91);\n`
    + `const child = spawnSync(helper, [${JSON.stringify(bare)}], { stdio: "inherit", env: process.env });\n`
    + `process.exit(child.status ?? 92);\n`;
  await writeFile(join(shim, "ssh"), ssh);
  await chmod(join(shim, "ssh"), 0o755);
  const runner = new TrackingRunner(await resolveGitExecutable(), { ...process.env, PATH: `${shim}${delimiter}${process.env.PATH ?? ""}` });
  const origin = `git@fixture:${bare}`;
  await git(runner, local, ["remote", "add", "origin", origin]);
  const initial = await inspectRepository(runner, local);
  runner.commands.length = 0;
  return { root, local, other, bare, origin, runner, bootstrap, initial };
}

async function cloneOther(value: PushFixture): Promise<void> {
  await git(value.runner, value.root, ["clone", "--branch", "main", value.origin, value.other]);
  await git(value.runner, value.other, ["config", "user.name", "Other Writer"]);
  await git(value.runner, value.other, ["config", "user.email", "other@example.test"]);
}

async function advanceOther(value: PushFixture, content = "other\n"): Promise<string> {
  await cloneOther(value);
  const head = await commit(value.runner, value.other, "other.txt", content);
  await git(value.runner, value.other, ["push", "origin", "main"]);
  return head;
}

async function addGitlink(value: PushFixture): Promise<RepositorySnapshot> {
  const nested = join(value.local, "submodule");
  await mkdir(nested);
  await git(value.runner, nested, ["init", "--initial-branch=main"]);
  await git(value.runner, nested, ["config", "user.name", "Nested Test"]);
  await git(value.runner, nested, ["config", "user.email", "nested@example.test"]);
  const nestedHead = await commit(value.runner, nested, "nested.txt", "nested one\n");
  await git(value.runner, value.local, ["update-index", "--add", "--cacheinfo", "160000", nestedHead, "submodule"]);
  await git(value.runner, value.local, ["commit", "--no-gpg-sign", "-m", "add gitlink"]);
  return inspectRepository(value.runner, value.local);
}

function request(snapshot: RepositorySnapshot, expectedRemoteHead: string | null) {
  return { expectedBranch: snapshot.branch!, expectedHead: snapshot.head, expectedRemoteHead };
}

function rejection(error: unknown): BridgeRejection {
  assert.ok(error instanceof BridgeRejection);
  return error;
}

function proven(error: unknown): ProvenMutationOutcome<PushData> {
  assert.ok(error instanceof ProvenMutationOutcome);
  return error as ProvenMutationOutcome<PushData>;
}

test("push origin reads one exact remote branch ref with bounded strict parsing", async () => {
  const oid = "a".repeat(40);
  const runner = new QueueRunner([commandResult({ stdout: `${oid}\trefs/heads/topic/test\n` })]);
  assert.equal(await readRemoteBranchHead(runner, "/repo", "topic/test"), oid);
  assert.deepEqual(runner.commands[0]?.args, ["ls-remote", "--heads", "origin", "refs/heads/topic/test"]);
  assert.ok((runner.commands[0]?.maxOutputBytes ?? Infinity) <= 32_768);

  const absent = new QueueRunner([commandResult()]);
  assert.equal(await readRemoteBranchHead(absent, "/repo", "main"), null);

  const malformed = [
    `${oid}\trefs/heads/main`,
    `${oid}\trefs/heads/other\n`,
    `${oid}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/main\n`,
    `${oid.slice(1)}\trefs/heads/main\n`,
    `${oid}\trefs/heads/main�\n`,
  ];
  for (const stdout of malformed) {
    await assert.rejects(readRemoteBranchHead(new QueueRunner([commandResult({ stdout })]), "/repo", "main"), /remote branch head/i);
  }
  await assert.rejects(readRemoteBranchHead(new QueueRunner([commandResult({ stdoutTruncated: true })]), "/repo", "main"), /remote branch head/i);
  await assert.rejects(readRemoteBranchHead(new QueueRunner([commandResult({ stderr: "private URL" })]), "/repo", "main"), (error) => {
    assert.equal(String(error).includes("private URL"), false);
    return true;
  });
});

test("push origin rejects invalid branch refs before invoking Git", async () => {
  for (const branch of ["", "-danger", "bad..name", "bad name", "bad@{name", "bad.lock", "bad/", ".hidden", "bad�name", "bad\uD800name"]) {
    const runner = new QueueRunner([]);
    await assert.rejects(readRemoteBranchHead(runner, "/repo", branch), /branch/i);
    assert.equal(runner.commands.length, 0);
  }
});

test("push origin preserves a valid astral branch ref", async () => {
  const branch = "topic/😀";
  const head = "a".repeat(40);
  const runner = new QueueRunner([commandResult({ stdout: `${head}\trefs/heads/${branch}\n` })]);
  assert.equal(await readRemoteBranchHead(runner, "/repo", branch), head);
  assert.deepEqual(runner.commands[0]?.args, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
});

test("push origin creates an expected-absent branch through one opaque exact lease", async (t) => {
  const f = await fixture(t);
  const prepared = await preparePushOrigin(f.runner, f.initial, request(f.initial, null));
  const observation = preparedPushObservation(prepared);
  assert.equal(observation.remote_head, null);
  assert.match(observation.push_policy_hash, /^[0-9a-f]{64}$/);
  assert.match(observation.tracked_worktree_snapshot_id, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(observation, "worktree_snapshot_id"), false);
  assert.equal(JSON.stringify(observation).includes(f.bare), false);
  assert.equal(JSON.stringify(observation).includes("git@"), false);
  f.runner.commands.length = 0;

  const execution = await executePreparedPush(f.runner, prepared);
  assert.deepEqual(f.runner.commands[0]?.args, [
    "push", "--force-with-lease=refs/heads/main:", "origin", "HEAD:refs/heads/main",
  ]);
  assert.equal(f.runner.commands.filter(({ args }) => args[0] === "push").length, 1);
  assert.equal(f.runner.commands.some(({ args }) => args.some((arg) => ["--force", "--delete", "--set-upstream", "--tags"].includes(arg))), false);
  assert.deepEqual(execution.data, { local_head: f.initial.head, remote_head: f.initial.head });
  assert.deepEqual(pushDataSchema.parse(execution.data), execution.data);
  assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/main"]), f.initial.head);
  await assert.rejects(executePreparedPush(f.runner, prepared), /invalid|consumed/i);
  await assert.rejects(executePreparedPush(f.runner, {} as PreparedPush), /invalid|consumed/i);
});

test("push origin rejects effective endpoint redirection or fanout before mutation", async (t) => {
  await t.test("different pushurl", async (t) => {
    const f = await fixture(t);
    await git(f.runner, f.local, ["remote", "set-url", "--push", "origin", "git@other.example:org/repository.git"]);
    await assert.rejects(preparePushOrigin(f.runner, await inspectRepository(f.runner, f.local), request(f.initial, null)),
      (error) => error instanceof BridgeRejection && error.error.code === "REMOTE_URL_REJECTED");
    assert.equal(f.runner.commands.some(({ args }) => args[0] === "push"), false);
  });

  await t.test("multiple pushurls", async (t) => {
    const f = await fixture(t);
    await git(f.runner, f.local, ["remote", "set-url", "--add", "--push", "origin", f.origin]);
    await git(f.runner, f.local, ["remote", "set-url", "--add", "--push", "origin", "git@other.example:org/repository.git"]);
    f.runner.commands.length = 0;
    await assert.rejects(preparePushOrigin(f.runner, f.initial, request(f.initial, null)),
      (error) => error instanceof BridgeRejection && error.error.code === "REMOTE_URL_REJECTED");
    assert.equal(f.runner.commands.some(({ args }) => args[0] === "push"), false);
  });

  await t.test("pushInsteadOf", async (t) => {
    const f = await fixture(t);
    await git(f.runner, f.local, ["config", "url.git@other.example:.pushInsteadOf", "git@fixture:"]);
    f.runner.commands.length = 0;
    await assert.rejects(preparePushOrigin(f.runner, f.initial, request(f.initial, null)),
      (error) => error instanceof BridgeRejection && error.error.code === "REMOTE_URL_REJECTED");
    assert.equal(f.runner.commands.some(({ args }) => args[0] === "push"), false);
  });
});

test("push origin rejects effect-expanding push configuration before any external write", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["push.recurseSubmodules", "on-demand"],
    ["submodule.recurse", "true"],
    ["push.pushOption", "private-option"],
    ["remote.origin.mirror", "true"],
    ["remote.origin.receivepack", "private-receive-pack"],
    ["remote.origin.uploadpack", "private-upload-pack"],
    ["remote.origin.push", "+refs/heads/*:refs/heads/*"],
    ["push.gpgSign", "true"],
    ["remote.origin.proxy", "http://private-proxy.example"],
    ["remote.origin.proxyAuthMethod", "basic"],
    ["remote.origin.serverOption", "private-option"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialCloneFilter", "blob:none"],
  ];
  for (const [key, value] of cases) {
    await t.test(key, async (t) => {
      const f = await fixture(t);
      await git(f.runner, f.local, ["config", key, value]);
      f.runner.commands.length = 0;
      await assert.rejects(preparePushOrigin(f.runner, f.initial, request(f.initial, null)),
        (error) => error instanceof BridgeRejection && error.error.code === "REMOTE_URL_REJECTED");
      assert.equal(f.runner.commands.some(({ args }) => args[0] === "push"), false);
      assert.equal(await hasRef(f.bootstrap, f.bare, "refs/heads/main"), false);
    });
  }

  await t.test("push.followTags", async (t) => {
    const f = await fixture(t);
    await git(f.runner, f.local, ["tag", "-a", "release", "-m", "release"]);
    await git(f.runner, f.local, ["config", "push.followTags", "true"]);
    f.runner.commands.length = 0;
    await assert.rejects(preparePushOrigin(f.runner, f.initial, request(f.initial, null)),
      (error) => error instanceof BridgeRejection && error.error.code === "REMOTE_URL_REJECTED");
    assert.equal(await hasRef(f.bootstrap, f.bare, "refs/heads/main"), false);
    assert.equal(await hasRef(f.bootstrap, f.bare, "refs/tags/release"), false);
  });
});

test("push origin rejects remote vcs before a configured transport helper can start", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "custom-helper-started");
  const helper = join(f.root, "bin", "git-remote-privatevcs");
  await writeFile(helper, `#!/bin/sh\nprintf started > ${JSON.stringify(marker)}\nexit 99\n`);
  await chmod(helper, 0o755);
  await git(f.runner, f.local, ["config", "remote.origin.vcs", "privatevcs"]);
  f.runner.commands.length = 0;

  await assert.rejects(preparePushOrigin(f.runner, f.initial, request(f.initial, null)),
    (error) => error instanceof BridgeRejection && error.error.code === "REMOTE_URL_REJECTED");
  await assert.rejects(access(marker), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(f.runner.commands.some(({ args }) => args[0] === "push"), false);
});

test("push origin permits fetch-only remote configuration while binding its audited key set", async (t) => {
  const f = await fixture(t);
  const values: readonly [string, string][] = [
    ["remote.origin.tagOpt", "--tags"],
    ["remote.origin.skipDefaultUpdate", "true"],
    ["remote.origin.skipFetchAll", "true"],
    ["remote.origin.prune", "true"],
    ["remote.origin.pruneTags", "true"],
  ];
  for (const [key, value] of values) await git(f.runner, f.local, ["config", key, value]);
  const snapshot = await inspectRepository(f.runner, f.local);
  const execution = await pushCurrentBranch(f.runner, snapshot, request(snapshot, null));
  assert.equal(execution.data.remote_head, snapshot.head);
});

test("push origin rejects an initial collision and accepts an exact existing remote head", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["push", "origin", "main"]);
  await assert.rejects(preparePushOrigin(f.runner, await inspectRepository(f.runner, f.local), request(f.initial, null)), (error) => {
    assert.equal(rejection(error).error.code, "REMOTE_HEAD_MISMATCH");
    return true;
  });

  const remoteBefore = f.initial.head;
  await commit(f.runner, f.local, "next.txt", "next\n");
  const local = await inspectRepository(f.runner, f.local);
  const execution = await pushCurrentBranch(f.runner, local, request(local, remoteBefore));
  assert.deepEqual(execution.data, { local_head: local.head, remote_head: local.head });
  assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/main"]), local.head);
});

test("push origin rejects non-fast-forward expected remote ancestry before mutation", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["push", "origin", "main"]);
  await cloneOther(f);
  await commit(f.runner, f.local, "local.txt", "local\n");
  const remoteHead = await commit(f.runner, f.other, "other.txt", "other\n");
  await git(f.runner, f.other, ["push", "origin", "main"]);
  await git(f.runner, f.local, ["fetch", "origin", "main"]);
  const local = await inspectRepository(f.runner, f.local);
  f.runner.commands.length = 0;

  await assert.rejects(preparePushOrigin(f.runner, local, request(local, remoteHead)), (error) => {
    assert.equal(rejection(error).error.code, "REMOTE_HEAD_MISMATCH");
    return true;
  });
  assert.equal(f.runner.commands.some(({ args }) => args[0] === "push"), false);
});

test("push origin rejects stale remote state during its final preflight without pushing", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["push", "origin", "main"]);
  const before = await inspectRepository(f.runner, f.local);
  const runner = new AfterFirstRemoteReadRunner(f.runner, async () => { await advanceOther(f); });
  let caught: unknown;
  try { await preparePushOrigin(runner, before, request(before, before.head)); } catch (error) { caught = error; }
  assert.equal(rejection(caught).error.code, "REMOTE_HEAD_MISMATCH");
  assert.equal(runner.commands.some(({ cwd, args }) => cwd === f.local && args[0] === "push"), false);
});

test("push origin lease rejects an ancestor advance after preparation", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["push", "origin", "main"]);
  const advanced = await commit(f.runner, f.local, "ancestor.txt", "ancestor\n");
  await commit(f.runner, f.local, "local.txt", "local\n");
  const local = await inspectRepository(f.runner, f.local);
  const prepared = await preparePushOrigin(f.runner, local, request(local, f.initial.head));
  await git(f.runner, f.local, ["push", "origin", `${advanced}:refs/heads/main`]);
  f.runner.commands.length = 0;
  let caught: unknown;
  try { await executePreparedPush(f.runner, prepared); } catch (error) { caught = error; }
  const outcome = proven(caught).result;
  assert.equal(outcome.status, "indeterminate");
  assert.equal(outcome.error?.code, "OPERATION_INDETERMINATE");
  assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/main"]), advanced);
  assert.deepEqual(f.runner.commands[0]?.args, [
    "push", `--force-with-lease=refs/heads/main:${f.initial.head}`, "origin", "HEAD:refs/heads/main",
  ]);
});

test("push origin lease rejects an expected-absence collision after preparation", async (t) => {
  const f = await fixture(t);
  await commit(f.runner, f.local, "local.txt", "local\n");
  const local = await inspectRepository(f.runner, f.local);
  const prepared = await preparePushOrigin(f.runner, local, request(local, null));
  await git(f.runner, f.local, ["push", "origin", `${f.initial.head}:refs/heads/main`]);
  f.runner.commands.length = 0;
  let caught: unknown;
  try { await executePreparedPush(f.runner, prepared); } catch (error) { caught = error; }
  const outcome = proven(caught).result;
  assert.equal(outcome.status, "indeterminate");
  assert.equal(outcome.error?.code, "OPERATION_INDETERMINATE");
  assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/main"]), f.initial.head);
  assert.deepEqual(f.runner.commands[0]?.args, [
    "push", "--force-with-lease=refs/heads/main:", "origin", "HEAD:refs/heads/main",
  ]);
});

test("push origin reports pre-push rejection and transport failure only after proving the remote unchanged", async (t) => {
  await t.test("pre-push hook", async (t) => {
    const f = await fixture(t);
    await hook(f.local, 'echo "private hook diagnostic" >&2\nexit 1');
    const prepared = await preparePushOrigin(f.runner, f.initial, request(f.initial, null));
    let caught: unknown;
    try { await executePreparedPush(f.runner, prepared); } catch (error) { caught = error; }
    const outcome = proven(caught).result;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.code, "GIT_FAILED");
    assert.equal(JSON.stringify(outcome).includes("private"), false);
    assert.equal(await readRemoteBranchHead(f.runner, f.local, "main"), null);
  });

  await t.test("transport failure", async (t) => {
    const f = await fixture(t);
    const runner = new PushOutcomeRunner(f.runner, commandResult({ exitCode: 1, stderr: "private URL" }));
    const prepared = await preparePushOrigin(runner, f.initial, request(f.initial, null));
    let caught: unknown;
    try { await executePreparedPush(runner, prepared); } catch (error) { caught = error; }
    const outcome = proven(caught).result;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.code, "GIT_FAILED");
    assert.equal(JSON.stringify(outcome).includes("private"), false);
  });
});

test("push origin stays indeterminate when failure, timeout, or cancellation disagrees with the remote head", async (t) => {
  for (const mode of ["push-then-fail", "push-then-timeout", "push-then-cancel"] as const) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const runner = new PushOutcomeRunner(f.runner, mode);
      const prepared = await preparePushOrigin(runner, f.initial, request(f.initial, null));
      let caught: unknown;
      try { await executePreparedPush(runner, prepared); } catch (error) { caught = error; }
      const outcome = proven(caught).result;
      assert.equal(outcome.status, "indeterminate");
      assert.equal(outcome.error?.code, "OPERATION_INDETERMINATE");
      assert.equal(outcome.data, undefined);
      assert.equal(JSON.stringify(outcome).includes("private"), false);
      assert.equal(runner.commands.filter(({ args }) => args[0] === "push").length, 1);
    });
  }
});

test("push origin is indeterminate when origin identity changes after the push", async (t) => {
  const f = await fixture(t);
  const runner = new AfterPushActionRunner(f.runner, async () => {
    await git(f.runner, f.local, ["remote", "set-url", "origin", "git@other.example:org/repository.git"]);
  });
  const prepared = await preparePushOrigin(runner, f.initial, request(f.initial, null));
  let caught: unknown;
  try { await executePreparedPush(runner, prepared); } catch (error) { caught = error; }
  assert.equal(proven(caught).result.status, "indeterminate");
});

test("push origin is indeterminate when effective push policy changes after the push", async (t) => {
  const f = await fixture(t);
  const runner = new AfterPushActionRunner(f.runner, async () => {
    await git(f.runner, f.local, ["config", "push.followTags", "true"]);
  });
  const prepared = await preparePushOrigin(runner, f.initial, request(f.initial, null));
  let caught: unknown;
  try { await executePreparedPush(runner, prepared); } catch (error) { caught = error; }
  assert.equal(proven(caught).result.status, "indeterminate");
});

test("push origin uses the canonical full branch ref despite short-name ambiguity", async (t) => {
  const f = await fixture(t);
  await git(f.runner, f.local, ["tag", "main"]);
  await git(f.runner, f.local, ["switch", "-c", "heads/main"]);
  const snapshot = await inspectRepository(f.runner, f.local);
  assert.equal(snapshot.branch, "heads/main");
  assert.equal(snapshot.branchRef, "refs/heads/heads/main");
  const prepared = await preparePushOrigin(f.runner, snapshot, request(snapshot, null));
  f.runner.commands.length = 0;
  const execution = await executePreparedPush(f.runner, prepared);
  assert.deepEqual(f.runner.commands[0]?.args, [
    "push", "--force-with-lease=refs/heads/heads/main:", "origin", "HEAD:refs/heads/heads/main",
  ]);
  assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/heads/main"]), execution.data.local_head);
});

test("push origin is indeterminate when native hooks mutate local HEAD, index, or worktree", async (t) => {
  const cases: readonly [string, string][] = [
    ["worktree", 'printf "changed\\n" > tracked.txt'],
    ["index", 'printf "staged\\n" > staged.txt\ngit add -- staged.txt'],
    ["HEAD", 'printf "hook commit\\n" > hook.txt\ngit add -- hook.txt\ngit commit --no-gpg-sign --no-verify -m "hook commit"'],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await hook(f.local, body);
      const prepared = await preparePushOrigin(f.runner, f.initial, request(f.initial, null));
      let caught: unknown;
      try { await executePreparedPush(f.runner, prepared); } catch (error) { caught = error; }
      assert.equal(proven(caught).result.status, "indeterminate");
      assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/main"]), f.initial.head);
    });
  }
});

test("push origin permits untracked content rewrites outside the tracked worktree proof", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.local, "scratch.txt"), "before\n");
  await hook(f.local, 'printf "after\\n" > scratch.txt');
  const snapshot = await inspectRepository(f.runner, f.local);
  const prepared = await preparePushOrigin(f.runner, snapshot, request(snapshot, null));
  const execution = await executePreparedPush(f.runner, prepared);
  assert.equal(execution.data.remote_head, snapshot.head);
  assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/main"]), snapshot.head);
});

test("push origin permits nested gitlink HEAD changes outside the superproject proof", async (t) => {
  const f = await fixture(t);
  const snapshot = await addGitlink(f);
  await hook(f.local,
    'printf "nested two\\n" > submodule/next.txt\n'
    + 'git -C submodule add -- next.txt\n'
    + 'git -C submodule commit --no-gpg-sign -m "nested update"');
  const prepared = await preparePushOrigin(f.runner, snapshot, request(snapshot, null));
  const execution = await executePreparedPush(f.runner, prepared);
  assert.equal(execution.data.remote_head, snapshot.head);
  assert.equal(await git(f.runner, f.bare, ["rev-parse", "refs/heads/main"]), snapshot.head);
});

test("push origin binds the outer gitlink path existence, file type, and mode", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["mode", "chmod 0700 submodule"],
    ["regular", 'rm -rf submodule\nprintf "replacement\\n" > submodule'],
    ["missing", "rm -rf submodule"],
    ...(process.platform === "win32" ? [] : [
      ["symlink", "rm -rf submodule\nln -s tracked.txt submodule"],
      ["fifo", "rm -rf submodule\nmkfifo submodule"],
    ] as const),
  ];
  for (const [name, body] of cases) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const snapshot = await addGitlink(f);
      await hook(f.local, body);
      const prepared = await preparePushOrigin(f.runner, snapshot, request(snapshot, null));
      let caught: unknown;
      try { await executePreparedPush(f.runner, prepared); } catch (error) { caught = error; }
      assert.equal(proven(caught).result.status, "indeterminate");
    });
  }
});
