import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ProvenMutationOutcome } from "../src/app/mutation-coordinator.js";
import { BridgeRejection, fetchDataSchema, type FetchData } from "../src/domain/result.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import {
  executePreparedFetch,
  fetchOrigin,
  listOriginRefs,
  parseAllowedRemote,
  prepareFetchOrigin,
  preparedFetchObservation,
  remoteIdentityString,
  type PreparedFetch,
} from "../src/git/remote.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../src/state/paths.js";
import type { FetchRecord } from "../src/state/records.js";
import { validateFetchRecord } from "../src/state/records.js";
import { SessionStore } from "../src/state/session-store.js";

const CONSTRAINED_FETCH_ARGS = [
  "-c", "remote.origin.tagOpt=--no-tags",
  "-c", "remote.origin.prune=false",
  "-c", "remote.origin.pruneTags=false",
  "-c", "fetch.prune=false",
  "-c", "fetch.pruneTags=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "submodule.recurse=false",
  "-c", "fetch.writeCommitGraph=false",
  "-c", "maintenance.auto=false",
  "-c", "gc.auto=0",
  "-c", "core.logAllRefUpdates=false",
  "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules",
  "--no-write-fetch-head", "--refmap=", "--upload-pack=git-upload-pack", "origin",
  "+refs/heads/*:refs/remotes/origin/*",
] as const;

function isFetchCommand(command: GitCommand): boolean {
  return command.args.includes("fetch");
}

function result(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0, ...overrides,
  };
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

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

class FetchOutcomeRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  constructor(
    private readonly delegate: GitRunner,
    private readonly fetchOutcome: GitCommandResult | Error | "fetch-then-fail",
  ) { super(process.execPath, process.env); }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    if (!isFetchCommand(command)) return this.delegate.run(command, signal);
    if (this.fetchOutcome === "fetch-then-fail") {
      await this.delegate.run(command, signal);
      return result({ exitCode: 1, stderr: "private remote diagnostic" });
    }
    if (this.fetchOutcome instanceof Error) throw this.fetchOutcome;
    return this.fetchOutcome;
  }
}

class OriginChangingRunner extends GitRunner {
  constructor(private readonly delegate: GitRunner, private readonly replacement: string) { super(process.execPath, process.env); }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    const outcome = await this.delegate.run(command, signal);
    if (isFetchCommand(command)) {
      await this.delegate.run({ ...command, args: ["remote", "set-url", "origin", this.replacement] });
    }
    return outcome;
  }
}

class OutsideRefChangingFetchRunner extends GitRunner {
  constructor(private readonly delegate: GitRunner, private readonly objectId: string) { super(process.execPath, process.env); }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (!isFetchCommand(command)) return this.delegate.run(command, signal);
    await this.delegate.run({ ...command, args: ["update-ref", "refs/tags/unobserved-fetch-effect", this.objectId] });
    return result({ exitCode: 1, stderr: "private failed-fetch diagnostic" });
  }
}

class FailingFetchStore extends SessionStore {
  override async createFetch(_record: FetchRecord): Promise<void> { throw new Error("persistence secret"); }
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  const command = await runner.run({ cwd, args, timeoutMs: 15_000, maxOutputBytes: 128_000, ...(stdin === undefined ? {} : { stdin }) });
  assert.equal(command.exitCode, 0, command.stderr);
  return command.stdout.trim();
}

async function addCommit(runner: GitRunner, directory: string, body: string): Promise<string> {
  await writeFile(join(directory, "tracked.txt"), body);
  await runGit(runner, directory, ["add", "--", "tracked.txt"]);
  await runGit(runner, directory, ["commit", "--no-gpg-sign", "-m", body.trim()]);
  return runGit(runner, directory, ["rev-parse", "HEAD"]);
}

async function readRef(runner: GitRunner, directory: string, ref: string): Promise<string | null> {
  const command = await runner.run({
    cwd: directory, args: ["rev-parse", "--verify", "--quiet", ref], timeoutMs: 15_000, maxOutputBytes: 128_000,
  });
  if (command.exitCode === 1 && command.signal === null && command.stdout === "" && command.stderr === ""
    && !command.timedOut && !command.aborted && !command.stdoutTruncated && !command.stderrTruncated) return null;
  assert.equal(command.exitCode, 0, command.stderr);
  return command.stdout.trim();
}

async function readOptionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface FetchFixture {
  readonly source: string;
  readonly local: string;
  readonly fixturePath: string;
  readonly origin: string;
  readonly runner: TrackingRunner;
  readonly sessions: SessionStore;
  readonly paths: StatePaths;
  readonly before: RepositorySnapshot;
  readonly remoteHead: string;
}

async function fetchFixture(t: test.TestContext): Promise<FetchFixture> {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-fetch-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-fetch-state-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(stateHome, { recursive: true, force: true }); });
  const bootstrap = new GitRunner(await resolveGitExecutable(), process.env);
  const source = join(root, "source");
  const local = join(root, "local");
  const fixturePath = join(root, "remote.git");
  const shim = join(root, "bin");
  await mkdir(source);
  await runGit(bootstrap, source, ["init", "--initial-branch=main"]);
  await runGit(bootstrap, source, ["config", "user.name", "git-mcp-server Test"]);
  await runGit(bootstrap, source, ["config", "user.email", "git-mcp-server@example.test"]);
  await addCommit(bootstrap, source, "one\n");
  await runGit(bootstrap, root, ["init", "--bare", fixturePath]);
  await runGit(bootstrap, source, ["remote", "add", "origin", fixturePath]);
  await runGit(bootstrap, source, ["push", "origin", "main"]);
  await runGit(bootstrap, root, ["clone", "--branch", "main", fixturePath, local]);
  const remoteHead = await addCommit(bootstrap, source, "two\n");
  await runGit(bootstrap, source, ["push", "origin", "main"]);

  const execPath = await runGit(bootstrap, root, ["--exec-path"]);
  await mkdir(shim);
  const upload = join(execPath, "git-upload-pack");
  const receive = join(execPath, "git-receive-pack");
  const ssh = `#!/usr/bin/env node\n`
    + `const { spawnSync } = require("node:child_process");\n`
    + `const args = process.argv.slice(2);\n`
    + `const command = args.at(-1);\n`
    + `const host = args.at(-2);\n`
    + `const allowedOptions = args.slice(0, -2).join(" ");\n`
    + `if (host !== "git@fixture" || (allowedOptions !== "" && allowedOptions !== "-o SendEnv=GIT_PROTOCOL")) process.exit(90);\n`
    + `const uploadCommand = ${JSON.stringify(`git-upload-pack '${fixturePath}'`)};\n`
    + `const receiveCommand = ${JSON.stringify(`git-receive-pack '${fixturePath}'`)};\n`
    + `const helper = command === uploadCommand ? ${JSON.stringify(upload)} : command === receiveCommand ? ${JSON.stringify(receive)} : null;\n`
    + `if (helper === null) process.exit(91);\n`
    + `const child = spawnSync(helper, [${JSON.stringify(fixturePath)}], { stdio: "inherit", env: process.env });\n`
    + `process.exit(child.status ?? 92);\n`;
  await writeFile(join(shim, "ssh"), ssh);
  await chmod(join(shim, "ssh"), 0o755);
  const runner = new TrackingRunner(await resolveGitExecutable(), { ...process.env, PATH: `${shim}${delimiter}${process.env.PATH ?? ""}` });
  const origin = `git@fixture:${fixturePath}`;
  await runGit(runner, local, ["remote", "set-url", "origin", origin]);
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const sessions = new SessionStore(paths);
  const before = await inspectRepository(runner, local);
  runner.commands.length = 0;
  return { source, local, fixturePath, origin, runner, sessions, paths, before, remoteHead };
}

function rejection(error: unknown): BridgeRejection {
  assert.ok(error instanceof BridgeRejection);
  return error;
}

function proven(error: unknown): ProvenMutationOutcome<FetchData> {
  assert.ok(error instanceof ProvenMutationOutcome);
  return error as ProvenMutationOutcome<FetchData>;
}

test("remote URL policy accepts only sanitized HTTPS, ssh URL, and scp-like identities", () => {
  const values = [
    parseAllowedRemote("https://Example.COM/org/repo.git"),
    parseAllowedRemote("ssh://git@Example.COM/org/repo.git"),
    parseAllowedRemote("git@Example.COM:org/repo.git"),
  ];
  assert.deepEqual(values.map(({ scheme, host }) => ({ scheme, host })), [
    { scheme: "https", host: "example.com" },
    { scheme: "ssh", host: "example.com" },
    { scheme: "ssh", host: "example.com" },
  ]);
  assert.notEqual(values[1]?.pathHash, values[2]?.pathHash);
  for (const identity of values) {
    assert.match(identity.pathHash, /^[0-9a-f]{64}$/);
    const wire = remoteIdentityString(identity);
    assert.equal(wire.includes("git@"), false);
    assert.equal(wire.includes("repo.git"), false);
    assert.equal(wire.includes("org/"), false);
  }
});

test("remote identity binds syntax, path mode, username discriminator, and port into the path hash", () => {
  const identities = [
    parseAllowedRemote("ssh://git@example.test/org/repo.git"),
    parseAllowedRemote("ssh://alice@example.test/org/repo.git"),
    parseAllowedRemote("git@example.test:org/repo.git"),
    parseAllowedRemote("alice@example.test:org/repo.git"),
    parseAllowedRemote("git@example.test:/org/repo.git"),
    parseAllowedRemote("ssh://git@example.test:2222/org/repo.git"),
  ];
  assert.equal(new Set(identities.map(({ pathHash }) => pathHash)).size, identities.length);
  for (const identity of identities) {
    const serialized = JSON.stringify(identity);
    assert.equal(serialized.includes("git@"), false);
    assert.equal(serialized.includes("alice"), false);
    assert.equal(serialized.includes("org/repo"), false);
  }
  assert.equal(identities.at(-1)?.host, "example.test:2222");
});

test("remote URL policy rejects credential and transport injection without echoing secrets", () => {
  const rejected = [
    "/tmp/repo.git", "../repo.git", "./repo.git", "file:///tmp/repo.git", "git:///repo.git",
    "ext::sh -c secret", "helper::secret", "https://user:secret@example.test/org/repo.git",
    "https://user@example.test/org/repo.git", "https://example.test/org/repo.git?token=secret",
    "https://example.test/org/repo.git#secret", "https://example.test/org/%2Frepo.git",
    "https://example.test/org/%2erepo.git", "ssh://git@example.test/org/%5Crepo.git",
    "git@example.test:org/repo.git:secret", "git@[::1]:org/repo.git", "git@:repo.git",
    "git@example.test:", "git@example.test:../repo.git", "git@example.test:org//repo.git",
    "git@example.test:org repo.git", "git@example.test:org/repo.git\nsecret",
    "git@-bad.example:org/repo.git", "git@bad-.example:org/repo.git", "git@bad..example:org/repo.git",
    "git@exa_mple.test:org/repo.git", "https://bad..example/org/repo.git",
    "https://example.test/org/repo.git?", "https://example.test/org/repo.git#",
    "https://example.test\\@evil.test/org/repo.git", "https://@example.test/org/repo.git",
    "https://user@example.test/org/repo.git", "https://example.test/org/@repo.git",
    "ssh://@example.test/org/repo.git", "ssh://git:@example.test/org/repo.git",
    "ssh://git@@example.test/org/repo.git", "ssh://-oProxyCommand@example.test/org/repo.git",
    "ssh://git@example.test\\evil/org/repo.git", "git@-oProxyCommand:org/repo.git",
    "https://example.test/", "https:///org/repo.git", "ssh://git@/org/repo.git",
  ];
  for (const raw of rejected) {
    assert.throws(() => parseAllowedRemote(raw), (error) => {
      const bridge = rejection(error);
      assert.equal(bridge.error.code, "REMOTE_URL_REJECTED");
      assert.equal(bridge.message.includes(raw), false);
      assert.equal(bridge.message.includes("secret"), false);
      return true;
    }, raw);
  }
});

test("origin ref listing uses one exact bounded command and rejects malformed or duplicate output", async () => {
  const valid = new QueueRunner([result({
    stdout: `refs/remotes/origin/HEAD\0${"1".repeat(40)}\nrefs/remotes/origin/main\0${"2".repeat(40)}\n`,
  })]);
  assert.deepEqual(await listOriginRefs(valid, "/repo"), {
    "refs/remotes/origin/HEAD": "1".repeat(40),
    "refs/remotes/origin/main": "2".repeat(40),
  });
  assert.deepEqual(valid.commands[0]?.args, [
    "for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)", "refs/remotes/origin",
  ]);
  assert.equal(typeof valid.commands[0]?.stdoutConsumer, "function");

  for (const output of [
    `refs/remotes/origin/main\0${"1".repeat(39)}\n`,
    `refs/heads/main\0${"1".repeat(40)}\n`,
    `refs/remotes/origin/main\0${"1".repeat(40)}\nrefs/remotes/origin/main\0${"2".repeat(40)}\n`,
    `refs/remotes/origin/main\0${"1".repeat(40)}\0extra\n`,
    `refs/remotes/origin/main\0${"1".repeat(40)}�\n`,
    `refs/remotes/origin/bad..name\0${"1".repeat(40)}\n`,
    `refs/remotes/origin/name.lock\0${"1".repeat(40)}\n`,
  ]) {
    await assert.rejects(listOriginRefs(new QueueRunner([result({ stdout: output })]), "/repo"), /origin refs/i);
  }
  await assert.rejects(listOriginRefs(new QueueRunner([result({ stdoutTruncated: true })]), "/repo"), /origin refs/i);
  await assert.rejects(listOriginRefs(new QueueRunner([result({ stderr: "private" })]), "/repo"), /origin refs/i);
});

test("fetch origin binds an opaque constrained policy, exact refspec, and a hermetic SSH transport", async (t) => {
  const fixture = await fetchFixture(t);
  const prepared = await prepareFetchOrigin(fixture.runner, fixture.sessions, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  });
  const observed = preparedFetchObservation(prepared);
  assert.equal(JSON.stringify(observed).includes(fixture.fixturePath), false);
  assert.equal(JSON.stringify(observed).includes("git@"), false);
  assert.match(observed.fetch_policy_hash, /^[0-9a-f]{64}$/);
  fixture.runner.commands.length = 0;

  const data = await executePreparedFetch(fixture.runner, fixture.sessions, prepared);
  assert.deepEqual(fixture.runner.commands[0]?.args, CONSTRAINED_FETCH_ARGS);
  assert.equal(fixture.runner.commands.filter(isFetchCommand).length, 1);
  assert.equal(data.refs_after["refs/remotes/origin/main"], fixture.remoteHead);
  assert.notEqual(data.refs_before["refs/remotes/origin/main"], fixture.remoteHead);
  assert.equal(data.remote_identity.includes(fixture.fixturePath), false);
  assert.equal(data.remote_identity.includes("git@"), false);
  assert.deepEqual(fetchDataSchema.parse(data), data);

  const after = await inspectRepository(fixture.runner, fixture.local);
  assert.equal(after.repositoryId, fixture.before.repositoryId);
  assert.equal(after.branch, fixture.before.branch);
  assert.equal(after.head, fixture.before.head);
  assert.equal(after.indexTree, fixture.before.indexTree);
  const record = await fixture.sessions.getFetch(data.fetch_id);
  assert.ok(record);
  assert.equal(record.branch, fixture.before.branch);
  assert.equal(record.head, fixture.before.head);
  assert.deepEqual(record.refsBefore, data.refs_before);
  assert.deepEqual(record.refsAfter, data.refs_after);
  const persistent = await readFile(join(fixture.paths.fetches, `${data.fetch_id}.json`), "utf8");
  assert.equal(persistent.includes(fixture.fixturePath), false);
  assert.equal(persistent.includes("git@"), false);
  assert.equal(persistent.includes(fixture.origin), false);

  await assert.rejects(executePreparedFetch(fixture.runner, fixture.sessions, prepared), /invalid|consumed/i);
  await assert.rejects(executePreparedFetch(fixture.runner, fixture.sessions, { remoteIdentity: "forged" } as PreparedFetch), /invalid|consumed/i);
});

test("fetch origin convenience API accepts no remote name and preserves local state", async (t) => {
  const fixture = await fetchFixture(t);
  const data = await fetchOrigin(fixture.runner, fixture.sessions, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  });
  assert.equal(data.refs_after["refs/remotes/origin/main"], fixture.remoteHead);
  const fetchCommands = fixture.runner.commands.filter(isFetchCommand);
  assert.deepEqual(fetchCommands.map(({ args }) => args), [CONSTRAINED_FETCH_ARGS]);
});

test("fetch policy overrides configured refspec, tag, prune, recursion, helper, and maintenance expansion", async (t) => {
  const fixture = await fetchFixture(t);
  await runGit(fixture.runner, fixture.source, ["tag", "remote-only-tag", fixture.remoteHead]);
  await runGit(fixture.runner, fixture.source, ["push", "origin", "refs/tags/remote-only-tag"]);
  await runGit(fixture.runner, fixture.local, ["update-ref", "refs/remotes/origin/stale", fixture.before.head]);
  for (const [key, value] of [
    ["remote.origin.tagOpt", "--tags"],
    ["remote.origin.prune", "true"],
    ["remote.origin.pruneTags", "true"],
    ["fetch.prune", "true"],
    ["fetch.pruneTags", "true"],
    ["fetch.recurseSubmodules", "on-demand"],
    ["submodule.recurse", "true"],
    ["fetch.writeCommitGraph", "true"],
    ["maintenance.auto", "true"],
    ["gc.auto", "1"],
    ["remote.origin.uploadpack", "forbidden-upload-pack"],
  ] as const) await runGit(fixture.runner, fixture.local, ["config", key, value]);
  await runGit(fixture.runner, fixture.local, [
    "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/expanded/*",
  ]);
  const fetchHead = join(fixture.before.gitDir, "FETCH_HEAD");
  await writeFile(fetchHead, "fetch-head-sentinel\n");
  const remoteMainLog = join(fixture.before.gitDir, "logs", "refs", "remotes", "origin", "main");
  const reflogBefore = await readOptionalFile(remoteMainLog);
  fixture.runner.commands.length = 0;

  const data = await fetchOrigin(fixture.runner, fixture.sessions, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  });

  const fetchCommands = fixture.runner.commands.filter(isFetchCommand);
  assert.deepEqual(fetchCommands.map(({ args }) => args), [CONSTRAINED_FETCH_ARGS]);
  assert.equal(data.refs_after["refs/remotes/origin/main"], fixture.remoteHead);
  assert.equal(await readRef(fixture.runner, fixture.local, "refs/remotes/origin/stale"), fixture.before.head);
  assert.equal(await readRef(fixture.runner, fixture.local, "refs/remotes/expanded/main"), null);
  assert.equal(await readRef(fixture.runner, fixture.local, "refs/tags/remote-only-tag"), null);
  assert.equal(await readFile(fetchHead, "utf8"), "fetch-head-sentinel\n");
  assert.equal(await readOptionalFile(remoteMainLog), reflogBefore);
});

test("fetch policy rejects config-driven transport and ref effects before transport", async (t) => {
  const fixture = await fetchFixture(t);
  const cases: readonly (readonly [string, string])[] = [
    ["extensions.partialClone", "origin"],
    ["fetch.bundleURI", "https://bundle.example/private.bundle"],
    ["remote.origin.serverOption", "private-option"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialCloneFilter", "blob:none"],
    ["remote.origin.followRemoteHEAD", "always"],
    ["remote.origin.proxy", "http://private-proxy.example"],
    ["remote.origin.proxyAuthMethod", "basic"],
    ["remote.origin.vcs", "privatevcs"],
    ["remote.origin.unrecognizedPolicy", "enabled"],
  ];
  for (const [key, value] of cases) {
    if (key === "extensions.partialClone") {
      await runGit(fixture.runner, fixture.local, ["config", "core.repositoryFormatVersion", "1"]);
    }
    await runGit(fixture.runner, fixture.local, ["config", key, value]);
    fixture.runner.commands.length = 0;
    await assert.rejects(prepareFetchOrigin(fixture.runner, fixture.sessions, fixture.before, {
      expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
    }), (error) => rejection(error).error.code === "REMOTE_URL_REJECTED", key);
    assert.equal(fixture.runner.commands.some(isFetchCommand), false, key);
    await runGit(fixture.runner, fixture.local, ["config", "--unset-all", key]);
    if (key === "extensions.partialClone") {
      await runGit(fixture.runner, fixture.local, ["config", "core.repositoryFormatVersion", "0"]);
    }
  }
});

test("fetch origin proves unchanged refs before classifying nonzero, abort, timeout, truncation, or runner error", async (t) => {
  const cases: readonly [string, GitCommandResult | Error, string][] = [
    ["nonzero", result({ exitCode: 1, stderr: "secret" }), "GIT_FAILED"],
    ["abort", result({ exitCode: null, aborted: true }), "GIT_FAILED"],
    ["timeout", result({ exitCode: null, timedOut: true }), "GIT_TIMEOUT"],
    ["truncation", result({ exitCode: 1, stdoutTruncated: true }), "OUTPUT_TRUNCATED"],
    ["runner error", new Error("secret runner failure"), "GIT_FAILED"],
  ];
  for (const [name, command, code] of cases) {
    await t.test(name, async (t) => {
      const fixture = await fetchFixture(t);
      const runner = new FetchOutcomeRunner(fixture.runner, command);
      const prepared = await prepareFetchOrigin(runner, fixture.sessions, fixture.before, {
        expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
      });
      let caught: unknown;
      try { await executePreparedFetch(runner, fixture.sessions, prepared); } catch (error) { caught = error; }
      const outcome = proven(caught);
      assert.equal(outcome.result.status, "failed");
      assert.equal(outcome.result.error?.code, code);
      assert.equal(JSON.stringify(outcome.result).includes("secret"), false);
      assert.equal(await fixture.sessions.getFetch(prepared.fetchId), null);
    });
  }
});

test("failed fetch requires unchanged refs across all namespaces", async (t) => {
  const fixture = await fetchFixture(t);
  const runner = new OutsideRefChangingFetchRunner(fixture.runner, fixture.before.head);
  const prepared = await prepareFetchOrigin(runner, fixture.sessions, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  });
  let caught: unknown;
  try { await executePreparedFetch(runner, fixture.sessions, prepared); } catch (error) { caught = error; }
  const outcome = proven(caught);
  assert.equal(outcome.result.status, "indeterminate");
  assert.equal(outcome.result.error?.code, "OPERATION_INDETERMINATE");
  assert.equal(await fixture.sessions.getFetch(prepared.fetchId), null);
});

test("fetch origin is indeterminate when refs changed despite command failure", async (t) => {
  const fixture = await fetchFixture(t);
  const runner = new FetchOutcomeRunner(fixture.runner, "fetch-then-fail");
  const prepared = await prepareFetchOrigin(runner, fixture.sessions, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  });
  let caught: unknown;
  try { await executePreparedFetch(runner, fixture.sessions, prepared); } catch (error) { caught = error; }
  const outcome = proven(caught);
  assert.equal(outcome.result.status, "indeterminate");
  assert.equal(outcome.result.error?.code, "OPERATION_INDETERMINATE");
  assert.equal(await fixture.sessions.getFetch(prepared.fetchId), null);
});

test("fetch origin is indeterminate if origin changes across the fetch trust boundary", async (t) => {
  const fixture = await fetchFixture(t);
  const runner = new OriginChangingRunner(fixture.runner, "git@other.example:org/repo.git");
  const prepared = await prepareFetchOrigin(runner, fixture.sessions, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  });
  let caught: unknown;
  try { await executePreparedFetch(runner, fixture.sessions, prepared); } catch (error) { caught = error; }
  assert.equal(proven(caught).result.status, "indeterminate");
  assert.equal(await fixture.sessions.getFetch(prepared.fetchId), null);
});

test("fetch origin never claims success when durable record publication fails", async (t) => {
  const fixture = await fetchFixture(t);
  const store = new FailingFetchStore(fixture.paths);
  const prepared = await prepareFetchOrigin(fixture.runner, store, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  });
  let caught: unknown;
  try { await executePreparedFetch(fixture.runner, store, prepared); } catch (error) { caught = error; }
  const outcome = proven(caught);
  assert.equal(outcome.result.status, "indeterminate");
  assert.equal(JSON.stringify(outcome.result).includes("persistence secret"), false);
});

test("fetch IDs are collision-checked before mutation and a publication race never overwrites", async (t) => {
  const fixture = await fetchFixture(t);
  const remote = parseAllowedRemote(fixture.origin);
  const collisionId = "00000000-0000-4000-8000-000000000001";
  const selectedId = "00000000-0000-4000-8000-000000000002";
  const existing: FetchRecord = {
    kind: "fetch", fetchId: collisionId, repositoryId: fixture.before.repositoryId,
    branch: fixture.before.branch!, head: fixture.before.head, remoteIdentity: remote,
    refsBefore: {}, refsAfter: {}, fetchedAt: "2026-07-19T00:00:00.000Z",
  };
  await fixture.sessions.createFetch(existing);
  const ids = [collisionId, selectedId];
  const prepared = await prepareFetchOrigin(fixture.runner, fixture.sessions, fixture.before, {
    expectedBranch: fixture.before.branch!, expectedHead: fixture.before.head,
  }, undefined, { generateId: () => ids.shift() ?? "unexpected" });
  assert.equal(prepared.fetchId, selectedId);
  assert.equal(fixture.runner.commands.some(isFetchCommand), false);

  const raced: FetchRecord = { ...existing, fetchId: selectedId, fetchedAt: "2026-07-19T00:00:01.000Z" };
  await fixture.sessions.createFetch(raced);
  let caught: unknown;
  try { await executePreparedFetch(fixture.runner, fixture.sessions, prepared); } catch (error) { caught = error; }
  assert.equal(proven(caught).result.status, "indeterminate");
  assert.deepEqual(await fixture.sessions.getFetch(selectedId), raced);
  assert.deepEqual(await fixture.sessions.getFetch(collisionId), existing);
});

test("FetchRecord accepts only safe remote identity and exact origin tracking refs", () => {
  const record: FetchRecord = {
    kind: "fetch", fetchId: "00000000-0000-4000-8000-000000000001",
    repositoryId: "a".repeat(64), branch: "main", head: "b".repeat(40),
    remoteIdentity: { scheme: "ssh", host: "example.test", pathHash: "c".repeat(64) },
    refsBefore: { "refs/remotes/origin/main": "d".repeat(40) }, refsAfter: {},
    fetchedAt: "2026-07-19T00:00:00.000Z",
  };
  assert.deepEqual(validateFetchRecord(record), record);
  assert.throws(() => validateFetchRecord({ ...record, refsBefore: { "refs/heads/main": "d".repeat(40) } }), /ref/i);
  for (const ref of [
    "refs/remotes/origin/a b", "refs/remotes/origin/a\tb", "refs/remotes/origin/a~b",
    "refs/remotes/origin/a^b", "refs/remotes/origin/a:b", "refs/remotes/origin/a?b",
    "refs/remotes/origin/a*b", "refs/remotes/origin/a[b", "refs/remotes/origin/a\\b",
    "refs/remotes/origin/a..b", "refs/remotes/origin/a@{b", "refs/remotes/origin//main",
    "refs/remotes/origin/.hidden", "refs/remotes/origin/main.", "refs/remotes/origin/main.lock",
    "refs/remotes/origin/replacement�name", "refs/remotes/origin/high\uD800name",
    "refs/remotes/origin/low\uDC00name",
  ]) {
    assert.throws(() => validateFetchRecord({ ...record, refsBefore: { [ref]: "d".repeat(40) } }), /ref/i, ref);
  }
  assert.deepEqual(validateFetchRecord({
    ...record, refsBefore: { "refs/remotes/origin/feature-😀": "d".repeat(40) },
  }).refsBefore, { "refs/remotes/origin/feature-😀": "d".repeat(40) });
  assert.equal(validateFetchRecord({ ...record, branch: "feature/😀" }).branch, "feature/😀");
  assert.throws(() => validateFetchRecord({ ...record, remoteIdentity: { ...record.remoteIdentity, scheme: "file" } }), /scheme/i);
  assert.throws(() => validateFetchRecord({ ...record, remoteIdentity: { ...record.remoteIdentity, host: "User@example.test" } }), /host/i);
  assert.throws(() => validateFetchRecord({ ...record, remoteIdentity: { ...record.remoteIdentity, host: "bad..example" } }), /host/i);
});

test("fetch result schema accepts only exact origin tracking ref map keys", () => {
  const valid = {
    fetch_id: "fetch-1",
    refs_before: { "refs/remotes/origin/main": "a".repeat(40) },
    refs_after: { "refs/remotes/origin/main": "b".repeat(40) },
    remote_identity: `ssh://example.test/${"c".repeat(64)}`,
    fetched_at: "2026-07-19T01:02:03.000Z",
  };
  assert.deepEqual(fetchDataSchema.parse(valid), valid);
  for (const ref of ["refs/heads/main", "refs/remotes/upstream/main", "refs/remotes/origin/../main"]) {
    assert.throws(() => fetchDataSchema.parse({
      ...valid,
      refs_after: { [ref]: "b".repeat(40) },
    }), /origin ref|invalid/i);
  }
});

test("every public fetch write API is immutable and never overwrites an existing ID", async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-fetch-immutable-"));
  t.after(async () => rm(stateHome, { recursive: true, force: true }));
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const sessions = new SessionStore(paths);
  const original: FetchRecord = {
    kind: "fetch", fetchId: "00000000-0000-4000-8000-000000000001",
    repositoryId: "a".repeat(64), branch: "main", head: "b".repeat(40),
    remoteIdentity: { scheme: "ssh", host: "example.test", pathHash: "c".repeat(64) },
    refsBefore: {}, refsAfter: {}, fetchedAt: "2026-07-19T00:00:00.000Z",
  };
  await sessions.putFetch(original);
  await assert.rejects(sessions.putFetch({ ...original, head: "d".repeat(40) }), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  await assert.rejects(sessions.createFetch({ ...original, head: "e".repeat(40) }), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  assert.deepEqual(await sessions.getFetch(original.fetchId), original);
});
