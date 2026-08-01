import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BridgeResult, CommitAmendData } from "../src/domain/result.js";
import { BridgeRejection } from "../src/domain/result.js";
import {
  createAmendAfterPersistCleanup,
  executePreparedCommitAmend,
  prepareCommitAmend,
  preparedCommitAmendObservation,
} from "../src/git/amend.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { readStatus } from "../src/git/read.js";
import { inspectRepository, type RepositorySnapshot } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";
import { addPaths } from "../src/git/stage.js";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../src/state/paths.js";
import type { StageRecord } from "../src/state/records.js";
import { SessionStore } from "../src/state/session-store.js";
import { ProvenMutationOutcome } from "../src/app/mutation-coordinator.js";
import { createBridgeRuntime } from "../src/app/bridge-service.js";

class TrackingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];
  override async run(command: GitCommand, signal?: AbortSignal) {
    this.commands.push(command);
    return super.run(command, signal);
  }
}

function commandResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 0,
    ...overrides,
  };
}

class AmendOverrideRunner extends GitRunner {
  constructor(private readonly delegate: GitRunner, private readonly outcome: GitCommandResult) {
    super(process.execPath, process.env);
  }
  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    if (command.args[0] === "commit") return this.outcome;
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
      : { ...record, updatedAt: "2026-08-01T23:59:59.000Z" };
  }
}

async function git(runner: GitRunner, cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  const result = await runner.run({
    cwd,
    args,
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
    ...(stdin === undefined ? {} : { stdin }),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function hook(directory: string, name: string, body: string): Promise<void> {
  const path = join(directory, ".hooks", name);
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
}

async function fixture(t: test.TestContext): Promise<{
  directory: string;
  runner: TrackingRunner;
  sessions: SessionStore;
  paths: StatePaths;
  snapshot: RepositorySnapshot;
  stage: StageRecord;
  worktreeSnapshotId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-amend-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-amend-state-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  });
  const runner = new TrackingRunner(await resolveGitExecutable(), {
    ...process.env,
    BRIDGE_TEST_SECRET: "must-not-reach-amend-hook",
  });
  await git(runner, directory, ["init", "--initial-branch=main"]);
  await git(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
  await git(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
  await mkdir(join(directory, ".hooks"));
  await git(runner, directory, ["config", "core.hooksPath", ".hooks"]);
  await writeFile(join(directory, "owned.txt"), "base\n");
  await writeFile(join(directory, "unstaged.txt"), "base\n");
  await git(runner, directory, ["add", "--", "owned.txt", "unstaged.txt"]);
  await git(runner, directory, ["commit", "--no-gpg-sign", "-m", "root"]);
  await writeFile(join(directory, "owned.txt"), "head\n");
  await git(runner, directory, ["add", "--", "owned.txt"]);
  await git(runner, directory, ["commit", "--no-gpg-sign", "-m", "head"]);

  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const sessions = new SessionStore(paths);
  const head = await inspectRepository(runner, directory);
  await writeFile(join(directory, "owned.txt"), "amended\n");
  await writeFile(join(directory, "unstaged.txt"), "keep unstaged\n");
  const added = await addPaths(runner, sessions, head, {
    expectedBranch: "main",
    expectedHead: head.head,
    paths: ["owned.txt"],
  });
  assert.ok(added.stage_id);
  const stage = await sessions.getStage(added.stage_id);
  assert.ok(stage);
  const snapshot = await inspectRepository(runner, directory);
  const status = await readStatus(runner, snapshot);
  runner.commands.length = 0;
  return { directory, runner, sessions, paths, snapshot, stage, worktreeSnapshotId: status.worktree_snapshot_id };
}

test("amends exact staged content without including unstaged changes", async (t) => {
  const { directory, runner, sessions, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  const oldParents = await git(runner, directory, ["show", "-s", "--format=%P", snapshot.head]);
  const ownedIndexTree = await git(runner, directory, ["write-tree"]);
  runner.commands.length = 0;

  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: amend exact staged content\n",
  });
  const observedBefore = preparedCommitAmendObservation(prepared);
  const execution = await executePreparedCommitAmend(runner, prepared);

  const newParents = await git(runner, directory, ["show", "-s", "--format=%P", execution.data.commit]);
  assert.equal(newParents, oldParents);
  assert.equal(execution.data.old_commit, snapshot.head);
  assert.equal(execution.data.old_tree, snapshot.headTree);
  assert.equal(execution.data.tree, ownedIndexTree);
  assert.equal(await git(runner, directory, ["show", "HEAD:owned.txt"]), "amended");
  assert.equal(await git(runner, directory, ["show", "HEAD:unstaged.txt"]), "base");
  assert.equal(await readFile(join(directory, "unstaged.txt"), "utf8"), "keep unstaged\n");
  assert.notEqual(await git(runner, directory, ["diff", "--", "unstaged.txt"]), "");
  assert.ok(await sessions.getStage(stage.stageId));
  assert.deepEqual(runner.commands.find(({ args }) => args[0] === "commit")?.args,
    ["commit", "--amend", "--no-gpg-sign", "--file=-"]);

  const cleanup = createAmendAfterPersistCleanup(sessions, {
    requestId: "amend-primary",
    repositoryId: stage.repositoryId,
    operation: "git_commit_amend",
    stageId: stage.stageId,
    expectedBranch: stage.branch,
    expectedHead: stage.baseHead,
  });
  const durable: BridgeResult<CommitAmendData> = {
    status: "succeeded",
    request_id: "amend-primary",
    repository_id: stage.repositoryId,
    operation: "git_commit_amend",
    observed_before: observedBefore,
    data: execution.data,
    warnings: execution.warnings,
  };
  await cleanup(durable);
  assert.equal(await sessions.getStage(stage.stageId), null);
  assert.equal(await sessions.getActiveSession(stage.repositoryId), null);
});

test("preserves the complete parent set of a merge HEAD", async (t) => {
  const { directory, runner, sessions, snapshot, stage } = await fixture(t);
  const tree = await git(runner, directory, ["rev-parse", `${snapshot.head}^{tree}`]);
  const root = await git(runner, directory, ["rev-parse", `${snapshot.head}^`]);
  const merge = await git(runner, directory, ["commit-tree", tree, "-p", snapshot.head, "-p", root], "merge head\n");
  await git(runner, directory, ["update-ref", "refs/heads/main", merge, snapshot.head]);
  await sessions.updateStageSession({ ...stage, baseHead: merge });
  const mergeSnapshot = await inspectRepository(runner, directory);
  const worktreeSnapshotId = (await readStatus(runner, mergeSnapshot)).worktree_snapshot_id;
  const prepared = await prepareCommitAmend(runner, sessions, mergeSnapshot, {
    expectedBranch: "main",
    expectedHead: merge,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: preserve merge parents\n",
  });
  const execution = await executePreparedCommitAmend(runner, prepared);

  assert.equal(await git(runner, directory, ["show", "-s", "--format=%P", execution.data.commit]),
    `${snapshot.head} ${root}`);
});

test("rejects a stale complete worktree snapshot before amend", async (t) => {
  const { directory, runner, sessions, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  await writeFile(join(directory, "unstaged.txt"), "changed after snapshot\n");
  runner.commands.length = 0;

  await assert.rejects(prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: stale snapshot\n",
  }), (error) => error instanceof BridgeRejection && error.error.code === "UNSUPPORTED_REPOSITORY_STATE");
  assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
  assert.ok(await sessions.getStage(stage.stageId));
});

test("rejects a stage record that no longer owns the active stage marker", async (t) => {
  const { runner, sessions, paths, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  await rm(join(paths.stages, `.active-${stage.repositoryId}.json`));
  runner.commands.length = 0;

  await assert.rejects(prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: wrong stage ownership\n",
  }), (error) => error instanceof BridgeRejection && error.error.code === "SESSION_MISMATCH");
  assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
  assert.ok(await sessions.getStage(stage.stageId));
});

test("rejects a stage record that omits a staged path from its ownership", async (t) => {
  const { directory, runner, sessions, stage } = await fixture(t);
  await writeFile(join(directory, "unowned-staged.txt"), "must not amend\n");
  await git(runner, directory, ["add", "--", "unowned-staged.txt"]);
  const changed = await inspectRepository(runner, directory);
  await sessions.updateStageSession({ ...stage, currentIndexTree: changed.indexTree });
  const status = await readStatus(runner, changed);
  runner.commands.length = 0;

  await assert.rejects(prepareCommitAmend(runner, sessions, changed, {
    expectedBranch: "main",
    expectedHead: changed.head,
    stageId: stage.stageId,
    worktreeSnapshotId: status.worktree_snapshot_id,
    message: "fix: incomplete ownership\n",
  }), (error) => error instanceof BridgeRejection && error.error.code === "SESSION_MISMATCH");
  assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
});

test("revalidates the exact stage record after final repository proofs", async (t) => {
  const { runner, paths, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  const changing = new ChangedSecondReadSessionStore(paths);
  await assert.rejects(prepareCommitAmend(runner, changing, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: changed stage record\n",
  }), (error) => error instanceof BridgeRejection && error.error.code === "SESSION_MISMATCH");
});

test("rejects a moved HEAD before running the native amend", async (t) => {
  const { directory, runner, sessions, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: moved head\n",
  });
  const headTree = await git(runner, directory, ["rev-parse", `${snapshot.head}^{tree}`]);
  const moved = await git(runner, directory, ["commit-tree", headTree, "-p", snapshot.head], "outside\n");
  await git(runner, directory, ["update-ref", "refs/heads/main", moved, snapshot.head]);
  runner.commands.length = 0;

  await assert.rejects(executePreparedCommitAmend(runner, prepared), (error) =>
    error instanceof BridgeRejection && error.error.code === "HEAD_MISMATCH");
  assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
  assert.equal(await git(runner, directory, ["rev-parse", "HEAD"]), moved);
  assert.ok(await sessions.getStage(stage.stageId));
});

test("rejects a signed HEAD before running native amend hooks", async (t) => {
  const { directory, runner, sessions, snapshot, stage } = await fixture(t);
  const tree = await git(runner, directory, ["rev-parse", `${snapshot.head}^{tree}`]);
  const parents = await git(runner, directory, ["show", "-s", "--format=%P", snapshot.head]);
  const object = [
    `tree ${tree}`,
    ...parents.split(" ").filter(Boolean).map((parent) => `parent ${parent}`),
    "author Test <test@example.test> 0 +0000",
    "committer Test <test@example.test> 0 +0000",
    "gpgsig fake-signature",
    " continuation",
    "",
    "signed head",
    "",
  ].join("\n");
  const signed = await git(runner, directory, ["hash-object", "-t", "commit", "-w", "--stdin"], object);
  await git(runner, directory, ["update-ref", "refs/heads/main", signed, snapshot.head]);
  const signedSnapshot = await inspectRepository(runner, directory);
  await sessions.updateStageSession({ ...stage, baseHead: signed });
  const status = await readStatus(runner, signedSnapshot);
  runner.commands.length = 0;

  await assert.rejects(prepareCommitAmend(runner, sessions, signedSnapshot, {
    expectedBranch: "main",
    expectedHead: signed,
    stageId: stage.stageId,
    worktreeSnapshotId: status.worktree_snapshot_id,
    message: "fix: signed head rejected\n",
  }), (error) => error instanceof BridgeRejection && error.error.code === "UNSUPPORTED_REPOSITORY_STATE");
  assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
});

test("hook rejection retains the exact stage session for retry", async (t) => {
  const { directory, runner, sessions, snapshot, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'echo "private amend hook diagnostic" >&2\nexit 31');
  const worktreeSnapshotId = (await readStatus(runner, snapshot)).worktree_snapshot_id;
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: hook rejection\n",
  });
  let caught: unknown;
  try { await executePreparedCommitAmend(runner, prepared); } catch (error) { caught = error; }

  assert.ok(caught instanceof ProvenMutationOutcome);
  assert.equal(caught.result.status, "failed");
  assert.deepEqual(caught.result.error, {
    code: "HOOK_FAILED",
    message: "A native commit hook rejected the commit",
    details: { hook: "pre-commit" },
  });
  assert.doesNotMatch(JSON.stringify(caught.result), /private|31/);
  assert.equal(await git(runner, directory, ["rev-parse", "HEAD"]), snapshot.head);
  assert.ok(await sessions.getStage(stage.stageId));
});

test("amend hooks run with the sanitized inherited environment", async (t) => {
  const { directory, runner, sessions, snapshot, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'test -n "${PATH:-}"\ntest -z "${BRIDGE_TEST_SECRET:-}"');
  const worktreeSnapshotId = (await readStatus(runner, snapshot)).worktree_snapshot_id;
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: sanitized hook environment\n",
  });
  const execution = await executePreparedCommitAmend(runner, prepared);
  assert.equal(execution.data.commit, await git(runner, directory, ["rev-parse", "HEAD"]));
});

test("hook index mutation cannot change the prepared amend tree", async (t) => {
  const { directory, runner, sessions, snapshot, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'printf "hook\n" > hook-added.txt\ngit add -- hook-added.txt');
  const worktreeSnapshotId = (await readStatus(runner, snapshot)).worktree_snapshot_id;
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: hook index mutation\n",
  });
  let caught: unknown;
  try { await executePreparedCommitAmend(runner, prepared); } catch (error) { caught = error; }

  assert.ok(caught instanceof ProvenMutationOutcome);
  assert.equal(caught.result.status, "indeterminate");
  assert.equal(caught.result.error?.code, "OPERATION_INDETERMINATE");
  assert.ok(await sessions.getStage(stage.stageId));
});

test("rejects unstaged worktree mutation after preparation before native amend", async (t) => {
  const { directory, runner, sessions, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: worktree drift\n",
  });
  await writeFile(join(directory, "unstaged.txt"), "mutated after prepare\n");
  runner.commands.length = 0;

  await assert.rejects(executePreparedCommitAmend(runner, prepared), (error) =>
    error instanceof BridgeRejection && error.error.code === "UNSUPPORTED_REPOSITORY_STATE");
  assert.equal(runner.commands.some(({ args }) => args[0] === "commit"), false);
  assert.equal(await git(runner, directory, ["rev-parse", "HEAD"]), snapshot.head);
  assert.ok(await sessions.getStage(stage.stageId));
});

test("post-hook unstaged mutation makes amend indeterminate", async (t) => {
  const { directory, runner, sessions, snapshot, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'printf "hook changed unstaged\n" > unstaged.txt');
  const worktreeSnapshotId = (await readStatus(runner, snapshot)).worktree_snapshot_id;
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: hook worktree mutation\n",
  });
  let caught: unknown;
  try { await executePreparedCommitAmend(runner, prepared); } catch (error) { caught = error; }

  assert.ok(caught instanceof ProvenMutationOutcome);
  assert.equal(caught.result.status, "indeterminate");
  assert.equal(caught.result.error?.code, "OPERATION_INDETERMINATE");
  assert.ok(await sessions.getStage(stage.stageId));
});

test("post-hook unstaged mutation of an owned path makes amend indeterminate", async (t) => {
  const { directory, runner, sessions, snapshot, stage } = await fixture(t);
  await hook(directory, "pre-commit", 'printf "hook changed owned worktree\n" > owned.txt');
  const worktreeSnapshotId = (await readStatus(runner, snapshot)).worktree_snapshot_id;
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: hook owned worktree mutation\n",
  });
  let caught: unknown;
  try { await executePreparedCommitAmend(runner, prepared); } catch (error) { caught = error; }

  assert.ok(caught instanceof ProvenMutationOutcome);
  assert.equal(caught.result.status, "indeterminate");
  assert.equal(caught.result.error?.code, "OPERATION_INDETERMINATE");
  assert.ok(await sessions.getStage(stage.stageId));
});

test("timeout with unchanged HEAD is a proven failure retaining the stage session", async (t) => {
  const { runner, sessions, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: timeout\n",
  });
  let caught: unknown;
  try {
    await executePreparedCommitAmend(
      new AmendOverrideRunner(runner, commandResult({ exitCode: null, timedOut: true })),
      prepared,
    );
  } catch (error) { caught = error; }

  assert.ok(caught instanceof ProvenMutationOutcome);
  assert.equal(caught.result.status, "failed");
  assert.equal(caught.result.error?.code, "GIT_TIMEOUT");
  assert.ok(await sessions.getStage(stage.stageId));
});

test("service durably replays amend and resumes replay-safe stage cleanup", async (t) => {
  const { directory, runner, sessions, paths, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  const runtime = await createBridgeRuntime(paths);
  const input = {
    repository: directory,
    request_id: "b2326b9a-5e56-4d1b-b1e2-2d6f27602400",
    expected_branch: "main",
    expected_head: snapshot.head,
    stage_id: stage.stageId,
    worktree_snapshot_id: worktreeSnapshotId,
    message: "fix: durable amend replay\n",
  };

  const result = await runtime.service.git_commit_amend(input);
  assert.equal(result.status, "succeeded");
  assert.equal(result.data?.old_commit, snapshot.head);
  assert.equal(await sessions.getStage(stage.stageId), null);
  const amendedHead = await git(runner, directory, ["rev-parse", "HEAD"]);
  assert.deepEqual(await runtime.service.git_commit_amend(input), result);
  assert.equal(await git(runner, directory, ["rev-parse", "HEAD"]), amendedHead);
  assert.deepEqual((await runtime.journal.get(input.request_id))?.result, result);
  assert.equal((await runtime.service.git_commit_amend({ ...input, message: "fix: changed request\n" })).error?.code,
    "REQUEST_ID_REUSED");
});

test("durable amend cleanup resumes after a crash between record and marker deletion", async (t) => {
  const { runner, sessions, paths, snapshot, stage, worktreeSnapshotId } = await fixture(t);
  const prepared = await prepareCommitAmend(runner, sessions, snapshot, {
    expectedBranch: "main",
    expectedHead: snapshot.head,
    stageId: stage.stageId,
    worktreeSnapshotId,
    message: "fix: restart-safe cleanup\n",
  });
  const observedBefore = preparedCommitAmendObservation(prepared);
  const execution = await executePreparedCommitAmend(runner, prepared);
  const result: BridgeResult<CommitAmendData> = {
    status: "succeeded",
    request_id: "amend-cleanup-replay",
    repository_id: stage.repositoryId,
    operation: "git_commit_amend",
    observed_before: observedBefore,
    data: execution.data,
    warnings: execution.warnings,
  };
  let crash = true;
  const crashing = new SessionStore(paths, {
    afterStageRecordUnlink: async () => {
      if (crash) {
        crash = false;
        throw new Error("cleanup crash");
      }
    },
  });
  const binding = {
    requestId: "amend-cleanup-replay" as const,
    repositoryId: stage.repositoryId,
    operation: "git_commit_amend" as const,
    stageId: stage.stageId,
    expectedBranch: stage.branch,
    expectedHead: stage.baseHead,
  };
  await assert.rejects(createAmendAfterPersistCleanup(crashing, binding)(result), /cleanup crash/);
  assert.equal(await sessions.getStage(stage.stageId), null);
  assert.ok(await sessions.getActiveSession(stage.repositoryId));

  const restarted = new SessionStore(paths);
  await createAmendAfterPersistCleanup(restarted, binding)(result);
  assert.equal(await restarted.getActiveSession(stage.repositoryId), null);
});
