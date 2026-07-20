import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DefaultBridgeService } from "../src/app/bridge-service.js";
import { recoverStartedOperations } from "../src/app/startup-recovery.js";
import {
  MutationCoordinator, TerminalResultUnavailable, TerminalResultUnavailableAfterReleaseFailure,
} from "../src/app/mutation-coordinator.js";
import { AuditLog } from "../src/state/audit.js";
import { atomicCreateJson } from "../src/state/atomic-json.js";
import { OperationJournal, type OperationJournalOptions } from "../src/state/journal.js";
import { initializeStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RepositoryLock } from "../src/state/repository-lock.js";
import { RepositoryRegistry } from "../src/state/repository-registry.js";
import { SessionStore } from "../src/state/session-store.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";
import { inspectRepository } from "../src/git/repository.js";

async function gitOperationGet(service: unknown, requestId: string): Promise<unknown> {
  const method = (service as Record<string, (input: { request_id: string }) => Promise<unknown>>)[["git", "operation", "get"].join("_")];
  assert.ok(method);
  return method.call(service, { request_id: requestId });
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

class AliasRetargetingRunner extends GitRunner {
  private completedIdentityReads = 0;
  private retargeted = false;

  constructor(executable: string, environment: NodeJS.ProcessEnv, private readonly alias: string, private readonly target: string) {
    super(executable, environment);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    const result = await super.run(command, signal);
    if (!this.retargeted && command.args[0] === "rev-parse"
      && ["--show-toplevel", "--git-dir", "--git-common-dir"].some((argument) => command.args.includes(argument))) {
      this.completedIdentityReads += 1;
      if (this.completedIdentityReads === 3) {
        this.retargeted = true;
        await rm(this.alias);
        await symlink(this.target, this.alias, "dir");
      }
    }
    return result;
  }
}

class PublicationRunner extends GitRunner {
  readonly commands: GitCommand[] = [];

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

async function mutationFixture(
  t: test.TestContext,
  publishResult: NonNullable<OperationJournalOptions["publishResult"]>,
  options: {
    releaseFails?: boolean;
    releaseDiagnostics?: string[];
    journalOptions?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-publication-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-publication-state-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  });
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Publication Test"]);
  git(repository, ["config", "user.email", "publication@example.invalid"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  const runner = new PublicationRunner(await resolveGitExecutable(), process.env);
  const snapshot = await inspectRepository(runner, repository);
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const concreteLock = new RepositoryLock(paths);
  const lock = options.releaseFails === true
    ? {
        acquire: async (repositoryId: string, signal?: AbortSignal) => {
          const handle = await concreteLock.acquire(repositoryId, signal);
          return {
            owner: handle.owner,
            release: async () => {
              await handle.release();
              throw new Error("private lock release detail");
            },
          };
        },
      } as unknown as RepositoryLock
    : concreteLock;
  const journal = new OperationJournal(paths, {
    ...options.journalOptions,
    publishResult,
  } as unknown as OperationJournalOptions);
  const sessions = new SessionStore(paths);
  const coordinatorDependencies = {
    runner, lock, journal, audit: new AuditLog(paths), registry: new RepositoryRegistry(paths),
    onLockReleaseFailure: async () => { options.releaseDiagnostics?.push("generic release diagnostic"); },
  };
  const coordinator = new MutationCoordinator(coordinatorDependencies);
  const service = new DefaultBridgeService({ runner, lock, journal, sessions, coordinator });
  return { paths, repository, runner, snapshot, journal, service };
}

test("bridge mutation cannot use a stale worktree root when a shared-gitdir alias retargets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-alias-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-alias-state-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  });
  const primary = join(root, "primary");
  const secondary = join(root, "secondary");
  const alias = join(root, "repository");
  await mkdir(primary);
  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.name", "Alias Test"]);
  git(primary, ["config", "user.email", "alias@example.invalid"]);
  git(primary, ["config", "commit.gpgsign", "false"]);
  git(primary, ["commit", "--allow-empty", "-m", "initial"]);
  git(primary, ["branch", "secondary"]);
  git(primary, ["worktree", "add", secondary, "secondary"]);
  await symlink(primary, alias, "dir");

  const executable = await resolveGitExecutable();
  const runner = new AliasRetargetingRunner(executable, process.env, alias, secondary);
  const initial = await inspectRepository(new GitRunner(executable, process.env), primary);
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const lock = new RepositoryLock(paths);
  const journal = new OperationJournal(paths);
  const sessions = new SessionStore(paths);
  const coordinator = new MutationCoordinator({
    runner, lock, journal, audit: new AuditLog(paths), registry: new RepositoryRegistry(paths),
  });
  const service = new DefaultBridgeService({ runner, lock, journal, sessions, coordinator });

  const result = await service.git_switch_create({
    repository: alias,
    request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0040",
    expected_branch: "main",
    expected_head: initial.head,
    branch: "must-not-be-created",
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.error?.code, "BRANCH_MISMATCH");
  assert.equal(spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/must-not-be-created"], { cwd: primary }).status, 1);
  assert.equal(git(primary, ["branch", "--show-current"]), "main");
  assert.equal(git(secondary, ["branch", "--show-current"]), "secondary");
});

test("bridge publishes and reloads fallback indeterminate before returning when normal completion fails", async (t) => {
  const publications: string[] = [];
  const fixture = await mutationFixture(t, async ({ kind, path, record }) => {
    publications.push(kind);
    if (kind === "terminal") throw new Error("simulated normal publication failure");
    await atomicCreateJson(path, record);
  });
  const requestId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0041";
  const result = await fixture.service.git_switch_create({
    repository: fixture.repository, request_id: requestId,
    expected_branch: "main", expected_head: fixture.snapshot.head, branch: "private-output-must-not-persist",
  });

  assert.equal(result.status, "indeterminate");
  assert.equal(result.error?.code, "OPERATION_INDETERMINATE");
  assert.equal(result.data, undefined);
  assert.equal(result.observed_before, undefined);
  const immediate = await gitOperationGet(fixture.service, requestId);
  assert.deepEqual(immediate, result);
  assert.deepEqual(publications, ["terminal", "indeterminate-fallback"]);
  assert.equal(fixture.runner.commands.filter(({ args }) => args[0] === "switch" && args[1] === "-c").length, 1);
  assert.doesNotMatch(await readFile(join(fixture.paths.operations, requestId, "result.json"), "utf8"), /private-output/);
  assert.deepEqual(await fixture.journal.findRecoveryCandidates(), []);
});

test("bridge surfaces publication failure without a terminal result when normal and fallback publication both fail", async (t) => {
  const publications: string[] = [];
  const fixture = await mutationFixture(t, async ({ kind }) => {
    publications.push(kind);
    throw new Error(`simulated ${kind} publication failure`);
  });
  const requestId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0042";
  await assert.rejects(fixture.service.git_switch_create({
    repository: fixture.repository, request_id: requestId,
    expected_branch: "main", expected_head: fixture.snapshot.head, branch: "created-once",
  }), (error: unknown) => error instanceof TerminalResultUnavailable);

  assert.deepEqual(publications, ["terminal", "indeterminate-fallback"]);
  assert.equal(fixture.runner.commands.filter(({ args }) => args[0] === "switch" && args[1] === "-c").length, 1);
  assert.equal(await fixture.journal.get(requestId), null);
  assert.ok((await readFile(join(fixture.paths.operations, requestId, "started.json"), "utf8")).includes(requestId));
  const operationGet = await gitOperationGet(fixture.service, requestId) as { status: string; error?: { code?: string } };
  assert.equal(operationGet.status, "rejected");
  assert.equal(operationGet.error?.code, "SESSION_NOT_FOUND");

  const recovered = await recoverStartedOperations(
    new OperationJournal(fixture.paths),
    new RepositoryLock(fixture.paths),
  );
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.kind, "recovered");
  if (recovered[0]?.kind === "recovered") assert.equal(recovered[0].result.result.status, "indeterminate");
  assert.equal((await new OperationJournal(fixture.paths).get(requestId))?.result.status, "indeterminate");
});

test("bridge preserves terminal-result unavailability when the uncertainty link and lock release also fail", async (t) => {
  const publications: string[] = [];
  const confirmations: string[] = [];
  const fixture = await mutationFixture(t, async (publication) => {
    publications.push(publication.kind);
    return (atomicCreateJson as unknown as (
      path: string,
      record: unknown,
      options: { onStep(step: "linked" | "temporary-unlinked" | "directory-synced"): void },
    ) => Promise<void>)(publication.path, publication.record, {
      onStep: (step) => {
        if (step === "temporary-unlinked") throw new Error(`simulated ${publication.kind} directory fsync failure`);
      },
    });
  }, {
    releaseFails: true,
    journalOptions: {
      syncOperationDirectory: async (directory: string) => {
        confirmations.push(directory);
        throw new Error("simulated operation directory re-sync failure");
      },
    },
  });
  const requestId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0044";

  await assert.rejects(fixture.service.git_switch_create({
    repository: fixture.repository,
    request_id: requestId,
    expected_branch: "main",
    expected_head: fixture.snapshot.head,
    branch: "uncertain-with-release-failure",
  }), (error: unknown) => {
    assert.ok(error instanceof TerminalResultUnavailableAfterReleaseFailure);
    assert.ok(error instanceof TerminalResultUnavailable);
    assert.equal(error.requestId, requestId);
    assert.doesNotMatch(error.message, /lock|sync|private/i);
    return true;
  });

  assert.deepEqual(publications, ["terminal", "durability-fallback"]);
  assert.ok(confirmations.length >= 2);
  await assert.rejects(fixture.journal.get(requestId), /re-sync failure/);
  const restarted = new OperationJournal(fixture.paths, {
    syncOperationDirectory: async () => { throw new Error("simulated operation directory re-sync failure"); },
  } as unknown as OperationJournalOptions);
  await assert.rejects(restarted.get(requestId), /re-sync failure/);
  await assert.rejects(restarted.recoverStarted(requestId), /re-sync failure/);
  assert.ok((await restarted.findRecoveryCandidates()).some(
    (entry) => entry.kind === "corrupt" && entry.requestId === requestId,
  ));
});

test("bridge operation get matches immediate durable success after release failure", async (t) => {
  const releaseDiagnostics: string[] = [];
  const fixture = await mutationFixture(t, async ({ path, record }) => {
    await atomicCreateJson(path, record);
  }, { releaseFails: true, releaseDiagnostics });
  const requestId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0043";

  const immediate = await fixture.service.git_switch_create({
    repository: fixture.repository,
    request_id: requestId,
    expected_branch: "main",
    expected_head: fixture.snapshot.head,
    branch: "durable-despite-release-failure",
  });
  const replay = await gitOperationGet(fixture.service, requestId);

  assert.equal(immediate.status, "succeeded");
  assert.deepEqual(immediate, replay);
  assert.equal(immediate.request_id, requestId);
  assert.equal(immediate.repository_id, fixture.snapshot.repositoryId);
  assert.deepEqual(immediate.data, {
    branch: "durable-despite-release-failure",
    head: fixture.snapshot.head,
  });
  assert.deepEqual(immediate.warnings, []);
  assert.deepEqual(releaseDiagnostics, ["generic release diagnostic"]);
});

test("bridge operation get replays a validated legal colon path without redaction", async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-colon-replay-"));
  t.after(async () => rm(stateHome, { recursive: true, force: true }));
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const journal = new OperationJournal(paths, { now: () => "2026-07-19T01:02:03.000Z", pid: 123 });
  const requestId = "typed-colon-replay";
  const repositoryId = "a".repeat(64);
  const objectId = "b".repeat(40);
  await journal.begin({ requestId, operation: "git_commit", repositoryId, input: {} });
  const durable = await journal.complete(requestId, {
    status: "succeeded", request_id: requestId, repository_id: repositoryId, operation: "git_commit", warnings: [],
    data: {
      commit: objectId, tree: objectId,
      hook_changed_paths: ["dir:name/file.ts"], signing: "disabled_by_policy",
    },
  });
  const service = new DefaultBridgeService({
    runner: new GitRunner(process.execPath, process.env), lock: {} as RepositoryLock,
    journal: new OperationJournal(paths), sessions: new SessionStore(paths), coordinator: {} as MutationCoordinator,
  });

  const replay = await gitOperationGet(service, requestId) as { data: unknown };
  assert.deepEqual(replay, durable.result);
  assert.deepEqual((replay.data as { hook_changed_paths: string[] }).hook_changed_paths, ["dir:name/file.ts"]);
});
