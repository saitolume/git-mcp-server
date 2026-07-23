import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BridgeResult, CommitData } from "../src/domain/result.js";
import type { RepositoryIdentity, RepositorySnapshot } from "../src/git/repository.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import { GitRunner } from "../src/git/runner.js";
import {
  MutationCoordinator, ProvenMutationOutcome, TerminalResultUnavailable,
  type MutationCallbacks, type MutationCoordinatorDependencies,
} from "../src/app/mutation-coordinator.js";
import { classifyOperationError, DefaultBridgeService } from "../src/app/bridge-service.js";
import { throwIfDeadlineExceeded, withDeadline, withReconciliationDeadline } from "../src/deadline.js";
import { OperationJournal, type BeginResult, type ResultPublication } from "../src/state/journal.js";
import { atomicCreateJson } from "../src/state/atomic-json.js";
import { SessionStore } from "../src/state/session-store.js";
import type { LockHandle, RepositoryLock } from "../src/state/repository-lock.js";
import type { AuditLog } from "../src/state/audit.js";
import type { RepositoryRegistry } from "../src/state/repository-registry.js";
import type { OperationRequestRecord, OperationResultRecord } from "../src/state/records.js";
import { initializeStatePaths, resolveStatePaths } from "../src/state/paths.js";

const repositoryId = "a".repeat(64);
const objectId = "b".repeat(40);
const commitData: CommitData = {
  commit: objectId,
  tree: objectId,
  hook_changed_paths: [],
  signing: "disabled_by_policy",
};
const request: OperationRequestRecord = {
  requestId: "request-1",
  requestHash: "c".repeat(64),
  operation: "git_commit",
  repositoryId,
  input: { repository: "/repo", message: "hello" },
  createdAt: "2026-07-19T01:02:03.000Z",
};
const identity: RepositoryIdentity = {
  repositoryId, root: "/repo", gitDir: "/repo/.git", commonGitDir: "/repo/.git",
};
const snapshot: RepositorySnapshot = {
  ...identity, branch: "main", branchRef: "refs/heads/main", head: objectId, headTree: objectId,
  indexTree: "d".repeat(64), indexMatchesHead: true, operationState: "none",
};

type PublicationStep = "linked" | "temporary-unlinked" | "directory-synced";
type FaultInjectableAtomicCreate = (
  target: string,
  value: unknown,
  options: { onStep(step: PublicationStep): void | Promise<void> },
) => Promise<{ cleanup: "complete" | "incomplete" }>;
const faultInjectableAtomicCreate = atomicCreateJson as unknown as FaultInjectableAtomicCreate;

async function gitOperationGet(service: unknown, requestId: string): Promise<BridgeResult<unknown>> {
  const method = (service as Record<string, (input: { request_id: string }) => Promise<BridgeResult<unknown>>>)[["git", "operation", "get"].join("_")];
  assert.ok(method);
  return method.call(service, { request_id: requestId });
}

function terminal<T>(result: BridgeResult<T>): OperationResultRecord {
  return { requestId: request.requestId, completedAt: "2026-07-19T01:02:04.000Z", result };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  const timeout = Symbol("timeout");
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<typeof timeout>((resolve) => { timer = setTimeout(() => resolve(timeout), timeoutMs); }),
    ]);
    assert.notEqual(value, timeout, `operation did not settle within ${timeoutMs} ms`);
    return value as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function makeCoordinator(order: string[], overrides: {
  begin?: () => Promise<BeginResult>;
  complete?: (result: BridgeResult<unknown>) => Promise<OperationResultRecord>;
  audit?: () => Promise<void>;
  inspect?: () => Promise<RepositorySnapshot>;
  release?: () => Promise<void>;
  releaseDiagnostic?: () => void | Promise<void>;
} = {}): MutationCoordinator {
  const handle: LockHandle = {
    owner: { pid: 1, nonce: "lock", repositoryId, createdAt: request.createdAt, heartbeatAt: request.createdAt },
    release: async () => { order.push("release"); await overrides.release?.(); },
  };
  const lock = {
    acquire: async () => { order.push("lock"); return handle; },
  } as unknown as RepositoryLock;
  const journal = {
    begin: async () => { order.push("journal begin"); return overrides.begin?.() ?? { kind: "execute" as const }; },
    complete: async (_requestId: string, result: BridgeResult<unknown>) => {
      order.push("journal complete");
      return overrides.complete?.(result) ?? terminal(result);
    },
  } as unknown as OperationJournal;
  const audit = {
    append: async () => { order.push("audit"); await overrides.audit?.(); },
  } as unknown as AuditLog;
  const registry = {
    put: async () => { order.push("registry"); },
  } as unknown as RepositoryRegistry;
  const dependencies: MutationCoordinatorDependencies & {
    onLockReleaseFailure?: (requestId: string) => void | Promise<void>;
  } = {
    runner: new GitRunner(process.execPath, process.env), lock, journal, audit, registry,
    resolveIdentity: async () => { order.push("identity"); return identity; },
    inspect: async () => { order.push("inspect"); return overrides.inspect?.() ?? snapshot; },
    now: () => "2026-07-19T01:02:04.000Z",
    monotonicNow: (() => { let value = 100; return () => value++; })(),
    onLockReleaseFailure: async (requestId) => {
      assert.equal(requestId, request.requestId);
      order.push("release diagnostic");
      await overrides.releaseDiagnostic?.();
    },
  };
  return new MutationCoordinator(dependencies);
}

function callbacks(order: string[], overrides: Partial<MutationCallbacks<CommitData>> = {}): MutationCallbacks<CommitData> {
  return {
    preflight: async () => { order.push("preflight"); return { head: objectId }; },
    mutate: async () => { order.push("mutation"); return commitData; },
    postflight: async () => { order.push("postflight"); return { head: objectId }; },
    classify: (error) => ({
      status: "failed", operation: request.operation, warnings: [],
      error: { code: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error) },
    }),
    afterPersist: async () => { order.push("afterPersist"); },
    ...overrides,
  };
}

test("mutation coordinator durably orders first execution before release", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);

  const result = await coordinator.execute(request, callbacks(order));

  assert.equal(result.status, "succeeded");
  assert.equal(result.request_id, request.requestId);
  assert.equal(result.repository_id, repositoryId);
  assert.deepEqual(result.observed_before, { head: objectId });
  assert.deepEqual(result.observed_after, { head: objectId });
  assert.deepEqual(order, [
    "identity", "lock", "inspect", "journal begin", "registry", "preflight", "mutation", "postflight",
    "journal complete", "afterPersist", "audit", "release",
  ]);
});

test("mutation progress brackets real preflight, execution, and proven postflight", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);
  const execution = {
    request,
    callbacks: callbacks(order),
    progress: async (phase: "preflight" | "executing" | "postflight") => { order.push(`progress ${phase}`); },
  };

  const result = await coordinator.execute(execution);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(order, [
    "identity", "lock", "inspect", "journal begin", "registry",
    "progress preflight", "preflight", "progress executing", "mutation", "postflight", "progress postflight",
    "journal complete", "afterPersist", "audit", "release",
  ]);
});

test("mutation progress omits phases that terminal failures never reach", async () => {
  const preflightOrder: string[] = [];
  const preflightCoordinator = makeCoordinator(preflightOrder);
  const preflightResult = await preflightCoordinator.execute({
    request,
    callbacks: callbacks(preflightOrder, {
      preflight: async () => { preflightOrder.push("preflight"); throw new Error("rejected before mutation"); },
    }),
    progress: async (phase: "preflight" | "executing" | "postflight") => { preflightOrder.push(`progress ${phase}`); },
  });
  assert.equal(preflightResult.status, "failed");
  assert.deepEqual(preflightOrder.filter((entry) => entry.startsWith("progress ")), ["progress preflight"]);

  const mutationOrder: string[] = [];
  const mutationCoordinator = makeCoordinator(mutationOrder);
  const mutationResult = await mutationCoordinator.execute({
    request,
    callbacks: callbacks(mutationOrder, {
      mutate: async () => {
        mutationOrder.push("mutation");
        throw new ProvenMutationOutcome({
          status: "failed", operation: request.operation, warnings: [],
          error: { code: "GIT_FAILED", message: "proven mutation failure" },
        });
      },
    }),
    progress: async (phase: "preflight" | "executing" | "postflight") => { mutationOrder.push(`progress ${phase}`); },
  });
  assert.equal(mutationResult.status, "failed");
  assert.deepEqual(mutationOrder.filter((entry) => entry.startsWith("progress ")), [
    "progress preflight", "progress executing",
  ]);
});

test("never-settling mutation progress cannot retain the deadline, authority, terminal result, or lock", async (t) => {
  for (const stalledPhase of ["preflight", "executing", "postflight"] as const) {
    await t.test(stalledPhase, async () => {
      const order: string[] = [];
      const coordinator = makeCoordinator(order);
      const never = new Promise<void>(() => undefined);
      let now = 1_000;
      const result = await settleWithin(withDeadline(10, undefined, (signal) => coordinator.execute({
        request,
        callbacks: callbacks(order, { classify: (error) => classifyOperationError(request.operation, error) }),
        progress: (phase) => {
          order.push(`progress ${phase}`);
          if (phase !== stalledPhase) return;
          now += 11;
          return never;
        },
      }, signal), { monotonicNow: () => now }));

      if (stalledPhase === "postflight") {
        assert.equal(result.status, "succeeded");
        assert.equal(order.includes("mutation"), true);
        assert.equal(order.includes("postflight"), true);
      } else {
        assert.equal(result.status, "failed");
        assert.equal(result.error?.code, "GIT_TIMEOUT");
        assert.equal(order.includes("mutation"), false);
        assert.equal(order.includes("preflight"), stalledPhase === "executing");
      }
      assert.equal(order.includes("journal complete"), true);
      assert.equal(order.at(-1), "release");
    });
  }
});

test("never-settling read progress is best-effort and cannot retain the repository lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-progress-read-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const runner = new GitRunner(await resolveGitExecutable(), process.env);
  const runGit = async (args: readonly string[]): Promise<void> => {
    const result = await runner.run({ cwd: directory, args, timeoutMs: 10_000, maxOutputBytes: 32_768 });
    assert.equal(result.exitCode, 0, result.stderr);
  };
  await runGit(["init", "--initial-branch=main"]);
  await runGit(["config", "user.name", "git-mcp-server Test"]);
  await runGit(["config", "user.email", "git-mcp-server@example.test"]);
  await writeFile(join(directory, "tracked.txt"), "tracked\n");
  await runGit(["add", "--", "tracked.txt"]);
  await runGit(["commit", "--no-gpg-sign", "-m", "initial"]);

  const phases: string[] = [];
  let releases = 0;
  const never = new Promise<void>(() => undefined);
  const lock = {
    acquire: async () => ({
      owner: {},
      release: async () => { releases += 1; },
    }),
  } as unknown as RepositoryLock;
  const service = new DefaultBridgeService({
    runner,
    lock,
    journal: {} as OperationJournal,
    sessions: {} as SessionStore,
    coordinator: {} as MutationCoordinator,
  });

  const result = await settleWithin(service.git_status({ repository: directory }, undefined, (phase) => {
    phases.push(phase);
    return never;
  }), 2_000);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(phases, ["preflight", "executing", "postflight"]);
  assert.equal(releases, 1);
});

test("mutation coordinator passes the exact locked snapshot into preflight", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);
  let received: RepositorySnapshot | undefined;
  const result = await coordinator.execute(request, callbacks(order, {
    preflight: async (lockedSnapshot) => {
      received = lockedSnapshot;
      return { root: lockedSnapshot.root, git_dir: lockedSnapshot.gitDir };
    },
  }));
  assert.equal(result.status, "succeeded");
  assert.equal(received, snapshot);
  assert.deepEqual(result.observed_before, { root: snapshot.root, git_dir: snapshot.gitDir });
});

test("deadline expiry before coordinator reservation leaves journal and mutation authority untouched", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);
  let authorityPrepared = false;
  let authorityConsumed = false;

  await assert.rejects(withDeadline(0, undefined, (signal) => coordinator.execute(request, callbacks(order, {
    preflight: async () => {
      authorityPrepared = true;
      return {};
    },
    mutate: async () => {
      authorityConsumed = true;
      return commitData;
    },
  }), signal)), /deadline/i);

  assert.deepEqual(order, []);
  assert.equal(authorityPrepared, false);
  assert.equal(authorityConsumed, false);
});

test("deadline expiry during preflight persists GIT_TIMEOUT without consuming prepared authority", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);
  let now = 1_000;
  let authorityPrepared = false;
  let authorityConsumed = false;

  const result = await withDeadline(10, undefined, (signal) => coordinator.execute(request, callbacks(order, {
    preflight: async () => {
      order.push("preflight");
      authorityPrepared = true;
      now += 11;
      throwIfDeadlineExceeded(signal);
      return {};
    },
    mutate: async () => {
      authorityConsumed = true;
      return commitData;
    },
    classify: (error) => classifyOperationError(request.operation, error),
  }), signal), { monotonicNow: () => now });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "GIT_TIMEOUT");
  assert.equal(authorityPrepared, true);
  assert.equal(authorityConsumed, false);
  assert.ok(order.includes("journal begin"));
  assert.ok(order.includes("journal complete"));
  assert.equal(order.includes("mutation"), false);
});

test("deadline expiry after mutation start does not override separately bounded exact reconciliation", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);
  let now = 1_000;

  const result = await withDeadline(10, undefined, (signal) => coordinator.execute(request, callbacks(order, {
    mutate: async () => {
      order.push("mutation");
      now += 11;
      assert.throws(() => throwIfDeadlineExceeded(signal), /deadline/i);
      return withReconciliationDeadline(async (reconciliationSignal) => {
        assert.equal(reconciliationSignal.aborted, false);
        return commitData;
      }, { monotonicNow: () => now });
    },
  }), signal), { monotonicNow: () => now });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.data, commitData);
  assert.ok(order.indexOf("journal complete") > order.indexOf("mutation"));
});

test("mutation coordinator replay performs only identity checks and idempotent cleanup", async () => {
  const order: string[] = [];
  const stored: BridgeResult<CommitData> = {
    status: "succeeded", request_id: request.requestId, repository_id: repositoryId,
    operation: request.operation, data: commitData, warnings: [],
  };
  const coordinator = makeCoordinator(order, { begin: async () => ({ kind: "replay", result: terminal(stored) }) });

  const result = await coordinator.execute({ request, callbacks: callbacks(order) });

  assert.deepEqual(result, stored);
  assert.deepEqual(order, ["identity", "lock", "inspect", "journal begin", "afterPersist", "release"]);
});

test("mutation coordinator treats an existing indeterminate terminal result like replay", async () => {
  const order: string[] = [];
  const stored: BridgeResult<never> = {
    status: "indeterminate", request_id: request.requestId, repository_id: repositoryId,
    operation: request.operation, warnings: [],
    error: { code: "OPERATION_INDETERMINATE", message: "unknown" },
  };
  const coordinator = makeCoordinator(order, { begin: async () => ({ kind: "indeterminate", result: terminal(stored) }) });

  const result = await coordinator.execute(request, callbacks(order));

  assert.equal(result.status, "indeterminate");
  assert.deepEqual(order, ["identity", "lock", "inspect", "journal begin", "afterPersist", "release"]);
});

test("mutation coordinator persists indeterminate when post-mutation work throws", async () => {
  const order: string[] = [];
  let persisted: BridgeResult<unknown> | undefined;
  const coordinator = makeCoordinator(order, {
    complete: async (result) => { persisted = result; return terminal(result); },
  });
  const operationCallbacks = callbacks(order, {
    mutate: async () => { order.push("mutation"); throw new Error("timed out after spawning git"); },
  });

  const result = await coordinator.execute(request, operationCallbacks);

  assert.equal(result.status, "indeterminate");
  assert.equal(result.error?.code, "OPERATION_INDETERMINATE");
  assert.equal(persisted?.status, "indeterminate");
  assert.ok(order.indexOf("journal complete") > order.indexOf("mutation"));
  assert.ok(order.indexOf("release") > order.indexOf("journal complete"));
});

test("mutation coordinator persists an explicitly proven hook failure after mutation starts", async () => {
  const order: string[] = [];
  let persisted: BridgeResult<unknown> | undefined;
  const coordinator = makeCoordinator(order, {
    complete: async (result) => { persisted = result; return terminal(result); },
  });
  const operationCallbacks = callbacks(order, {
    mutate: async () => {
      order.push("mutation");
      throw new ProvenMutationOutcome({
        status: "failed", operation: request.operation, warnings: [],
        error: {
          code: "HOOK_FAILED",
          message: "A native commit hook rejected the commit",
          details: { hook: "pre-commit" },
        },
      });
    },
  });

  const result = await coordinator.execute(request, operationCallbacks);

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HOOK_FAILED");
  assert.equal(persisted?.status, "failed");
});

test("mutation coordinator replaces outcome-supplied observed_before with actual preflight proof", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);
  const result = await coordinator.execute(request, callbacks(order, {
    mutate: async () => {
      throw new ProvenMutationOutcome({
        status: "failed", operation: request.operation, warnings: [],
        observed_before: { stage_record_hash: "forged" },
        error: { code: "GIT_FAILED", message: "Git failed" },
      });
    },
  }));
  assert.deepEqual(result.observed_before, { head: objectId });
});

test("mutation coordinator persists generic success warnings and replays them without mutation", async () => {
  const order: string[] = [];
  let persisted: BridgeResult<unknown> | undefined;
  const coordinator = makeCoordinator(order, {
    complete: async (result) => { persisted = result; return terminal(result); },
  });
  const operationCallbacks = callbacks(order, {
    warnings: () => ["Git emitted diagnostics after the commit was created"],
  });
  const result = await coordinator.execute(request, operationCallbacks);
  assert.deepEqual(result.warnings, ["Git emitted diagnostics after the commit was created"]);
  assert.deepEqual(persisted?.warnings, result.warnings);

  const replayOrder: string[] = [];
  const replay = makeCoordinator(replayOrder, { begin: async () => ({ kind: "replay", result: terminal(persisted!) }) });
  const replayResult = await replay.execute(request, callbacks(replayOrder, {
    warnings: () => { throw new Error("must not recompute warnings during replay"); },
  }));
  assert.deepEqual(replayResult.warnings, result.warnings);
  assert.equal(replayOrder.includes("mutation"), false);
});

test("mutation coordinator preserves proven success when its warning accessor throws", async () => {
  const order: string[] = [];
  let persisted: BridgeResult<unknown> | undefined;
  const coordinator = makeCoordinator(order, {
    complete: async (result) => { persisted = result; return terminal(result); },
  });
  const result = await coordinator.execute(request, callbacks(order, {
    warnings: () => { throw new Error("private diagnostic parser failure"); },
  }));
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.warnings, ["Mutation diagnostics could not be collected after success was proven"]);
  assert.deepEqual(persisted?.warnings, result.warnings);
});

test("mutation coordinator completes proven postflight, persistence, cleanup, and audit after mutate aborts the caller signal", async () => {
  const order: string[] = [];
  let persisted: BridgeResult<unknown> | undefined;
  const controller = new AbortController();
  const coordinator = makeCoordinator(order, {
    complete: async (result) => { persisted = result; return terminal(result); },
  });
  const result = await coordinator.execute(request, callbacks(order, {
    mutate: async () => {
      order.push("mutation");
      controller.abort();
      return commitData;
    },
    postflight: async () => { order.push("postflight"); return { head: objectId, proven: true }; },
    warnings: () => ["Git command completion diagnostics were incomplete after the commit was created"],
  }), controller.signal);

  assert.equal(result.status, "succeeded");
  assert.equal(persisted?.status, "succeeded");
  assert.deepEqual(result.observed_after, { head: objectId, proven: true });
  assert.deepEqual(result.warnings, ["Git command completion diagnostics were incomplete after the commit was created"]);
  assert.ok(order.indexOf("postflight") > order.indexOf("mutation"));
  assert.ok(order.indexOf("journal complete") > order.indexOf("postflight"));
  assert.ok(order.indexOf("afterPersist") > order.indexOf("journal complete"));
  assert.ok(order.indexOf("audit") > order.indexOf("afterPersist"));
  assert.equal(order.at(-1), "release");
});

test("mutation coordinator keeps an ordinary mutate throw indeterminate when mutate also aborts", async () => {
  const order: string[] = [];
  const controller = new AbortController();
  const coordinator = makeCoordinator(order);
  const result = await coordinator.execute(request, callbacks(order, {
    mutate: async () => {
      order.push("mutation");
      controller.abort();
      throw new Error("unproven completion");
    },
  }), controller.signal);
  assert.equal(result.status, "indeterminate");
  assert.equal(result.error?.code, "OPERATION_INDETERMINATE");
  assert.equal(order.includes("postflight"), false);
});

test("proven mutation outcomes cannot claim success or preflight rejection", () => {
  for (const status of ["succeeded", "rejected"] as const) {
    assert.throws(() => new ProvenMutationOutcome({
      status, operation: request.operation, warnings: [],
      ...(status === "succeeded" ? { data: commitData } : { error: { code: "INVALID_INPUT" as const, message: "no" } }),
    }), /failed, conflicted, or indeterminate/);
  }
});

test("mutation coordinator preserves durable success and adds a warning when audit fails", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order, { audit: async () => { throw new Error("audit device unavailable"); } });

  const result = await coordinator.execute(request, callbacks(order));

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.warnings, ["Audit append failed after the terminal result was persisted"]);
  assert.equal(order.at(-1), "release");
});

test("mutation coordinator preserves a durable terminal result when release fails", async () => {
  const order: string[] = [];
  let persisted: BridgeResult<unknown> | undefined;
  const coordinator = makeCoordinator(order, {
    complete: async (result) => { persisted = result; return terminal(result); },
    release: async () => { throw new Error("private lock path unavailable"); },
  });

  const result = await coordinator.execute(request, callbacks(order));

  assert.deepEqual(result, persisted);
  assert.equal(result.status, "succeeded");
  assert.equal(result.request_id, request.requestId);
  assert.equal(result.repository_id, repositoryId);
  assert.deepEqual(result.data, commitData);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(order.slice(-2), ["release", "release diagnostic"]);
});

test("mutation coordinator persists a classified preflight failure without mutating", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order);
  const operationCallbacks = callbacks(order, {
    preflight: async () => { order.push("preflight"); throw new Error("branch changed"); },
  });

  const result = await coordinator.execute(request, operationCallbacks);

  assert.equal(result.status, "failed");
  assert.equal(order.includes("mutation"), false);
  assert.ok(order.includes("journal complete"));
});

test("mutation coordinator rejects repository identity changes inside the lock before journal or mutation", async () => {
  const order: string[] = [];
  const coordinator = makeCoordinator(order, {
    inspect: async () => ({ ...snapshot, repositoryId: "d".repeat(64), commonGitDir: "/other/.git" }),
  });

  await assert.rejects(coordinator.execute(request, callbacks(order)), /identity.*changed|repository.*changed/i);
  assert.equal(order.includes("journal begin"), false);
  assert.equal(order.includes("mutation"), false);
  assert.equal(order.at(-1), "release");
});

test("mutation coordinator returns only the reloaded durable fallback after terminal persistence fails", async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-complete-failure-"));
  t.after(async () => rm(stateHome, { recursive: true, force: true }));
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const durableJournal = new OperationJournal(paths, { now: () => "2026-07-19T01:02:04.000Z", pid: process.pid });
  const failingJournal = {
    begin: durableJournal.begin.bind(durableJournal),
    complete: async () => { throw new Error("simulated result persistence failure"); },
    completeIndeterminate: durableJournal.completeIndeterminate.bind(durableJournal),
  } as unknown as OperationJournal;
  const handle: LockHandle = {
    owner: { pid: process.pid, nonce: "lock", repositoryId, createdAt: request.createdAt, heartbeatAt: request.createdAt },
    release: async () => undefined,
  };
  const coordinator = new MutationCoordinator({
    runner: new GitRunner(process.execPath, process.env),
    lock: { acquire: async () => handle } as unknown as RepositoryLock,
    journal: failingJournal,
    audit: { append: async () => undefined } as unknown as AuditLog,
    registry: { put: async () => undefined } as unknown as RepositoryRegistry,
    resolveIdentity: async () => identity,
    inspect: async () => snapshot,
    now: () => "2026-07-19T01:02:04.000Z",
  });

  const order: string[] = [];
  const result = await coordinator.execute(request, callbacks(order));
  assert.equal(result.status, "indeterminate");
  assert.equal(result.error?.code, "OPERATION_INDETERMINATE");
  assert.deepEqual((await durableJournal.get(request.requestId))?.result, result);
  assert.deepEqual(await durableJournal.findRecoveryCandidates(), []);
  assert.equal(order.filter((entry) => entry === "mutation").length, 1);
});

test("mutation coordinator returns the durable publication after no-replace cleanup failure", async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-cleanup-publication-"));
  t.after(async () => rm(stateHome, { recursive: true, force: true }));
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const diagnostics: string[] = [];
  const journal = new OperationJournal(paths, {
    publishResult: async (publication: ResultPublication) => faultInjectableAtomicCreate(publication.path, publication.record, {
      onStep: (step) => {
        if (step === "linked") throw new Error("simulated temp unlink failure");
      },
    }),
    onResultPublicationWarning: (requestId: string) => { diagnostics.push(requestId); },
  } as unknown as import("../src/state/journal.js").OperationJournalOptions);
  const handle: LockHandle = {
    owner: { pid: process.pid, nonce: "lock", repositoryId, createdAt: request.createdAt, heartbeatAt: request.createdAt },
    release: async () => undefined,
  };
  const coordinator = new MutationCoordinator({
    runner: new GitRunner(process.execPath, process.env),
    lock: { acquire: async () => handle } as unknown as RepositoryLock,
    journal,
    audit: { append: async () => undefined } as unknown as AuditLog,
    registry: { put: async () => undefined } as unknown as RepositoryRegistry,
    resolveIdentity: async () => identity,
    inspect: async () => snapshot,
  });

  const immediate = await coordinator.execute(request, callbacks([]));

  assert.deepEqual(immediate, (await journal.get(request.requestId))?.result);
  assert.equal(immediate.status, "succeeded");
  assert.deepEqual(diagnostics, [request.requestId]);
});

test("mutation coordinator and operation reads agree on durable directory fsync uncertainty", async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), "git-mcp-server-fsync-publication-"));
  t.after(async () => rm(stateHome, { recursive: true, force: true }));
  const paths = await initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: stateHome, env: {} }));
  const journal = new OperationJournal(paths, {
    publishResult: async (publication: ResultPublication) => publication.kind === "terminal"
      ? faultInjectableAtomicCreate(publication.path, publication.record, {
          onStep: (step) => {
            if (step === "temporary-unlinked") throw new Error("simulated directory fsync failure");
          },
        })
      : atomicCreateJson(publication.path, publication.record),
  } as unknown as import("../src/state/journal.js").OperationJournalOptions);
  const handle: LockHandle = {
    owner: { pid: process.pid, nonce: "lock", repositoryId, createdAt: request.createdAt, heartbeatAt: request.createdAt },
    release: async () => undefined,
  };
  const coordinator = new MutationCoordinator({
    runner: new GitRunner(process.execPath, process.env),
    lock: { acquire: async () => handle } as unknown as RepositoryLock,
    journal,
    audit: { append: async () => undefined } as unknown as AuditLog,
    registry: { put: async () => undefined } as unknown as RepositoryRegistry,
    resolveIdentity: async () => identity,
    inspect: async () => snapshot,
  });

  const immediate = await coordinator.execute(request, callbacks([]));
  const liveService = new DefaultBridgeService({
    runner: new GitRunner(process.execPath, process.env), lock: {} as RepositoryLock,
    journal, sessions: new SessionStore(paths), coordinator,
  });
  const liveRead = await gitOperationGet(liveService, request.requestId);
  const restartedJournal = new OperationJournal(paths);
  const restartedService = new DefaultBridgeService({
    runner: new GitRunner(process.execPath, process.env), lock: {} as RepositoryLock,
    journal: restartedJournal, sessions: new SessionStore(paths), coordinator,
  });
  const restartedRead = await gitOperationGet(restartedService, request.requestId);

  assert.equal(immediate.status, "indeterminate");
  assert.equal(immediate.error?.code, "OPERATION_INDETERMINATE");
  assert.deepEqual(liveRead, immediate);
  assert.deepEqual(restartedRead, immediate);
  assert.deepEqual((await journal.get(request.requestId))?.result, immediate);
  assert.deepEqual(await restartedJournal.findRecoveryCandidates(), []);
  assert.deepEqual(await restartedJournal.recoverStarted(request.requestId), {
    kind: "terminal", requestId: request.requestId, result: await restartedJournal.get(request.requestId),
  });
});
