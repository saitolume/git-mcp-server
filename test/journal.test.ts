import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { BridgeRejection, HOOK_FAILED_MESSAGE, type BridgeResult } from "../src/domain/result.js";
import { atomicCreateJson, atomicWriteJson, readJson } from "../src/state/atomic-json.js";
import { AuditLog } from "../src/state/audit.js";
import {
  OperationJournal, type OperationJournalOptions, type ResultPublication,
} from "../src/state/journal.js";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../src/state/paths.js";
import type { FetchRecord, MergeRecord, RepositoryRecord, StageRecord } from "../src/state/records.js";
import { RepositoryRegistry } from "../src/state/repository-registry.js";
import { SessionStore } from "../src/state/session-store.js";

const execFileAsync = promisify(execFile);
const repositoryId = "a".repeat(64);
const objectId = "b".repeat(40);
const timestamp = "2026-07-19T01:02:03.000Z";

type AtomicCreateStep = "linked" | "temporary-unlinked" | "directory-synced";
type FaultInjectableAtomicCreate = (
  target: string,
  value: unknown,
  options: { onStep(step: AtomicCreateStep): void | Promise<void> },
) => Promise<{ cleanup: "complete" | "incomplete" }>;
const faultInjectableAtomicCreate = atomicCreateJson as unknown as FaultInjectableAtomicCreate;

async function temporaryState(t: test.TestContext): Promise<StatePaths> {
  const home = await mkdtemp(join(tmpdir(), "git-mcp-server-state-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const paths = resolveStatePaths({ platform: "linux", homedir: home, env: {} });
  await initializeStatePaths(paths);
  return paths;
}

function successResult(operation = "git_commit", requestId = "request-1"): BridgeResult<unknown> {
  return {
    status: "succeeded",
    request_id: requestId,
    repository_id: repositoryId,
    operation,
    data: {
      commit: objectId, tree: objectId, hook_changed_paths: [], signing: "disabled_by_policy",
    },
    warnings: [],
  };
}

function fetchSuccessResult(requestId: string): BridgeResult<unknown> {
  return {
    status: "succeeded",
    request_id: requestId,
    repository_id: repositoryId,
    operation: "git_fetch",
    data: {
      fetch_id: "fetch-1",
      refs_before: { "refs/remotes/origin/main": objectId },
      refs_after: { "refs/remotes/origin/main": "c".repeat(40) },
      remote_identity: `ssh://example.test/${"d".repeat(64)}`,
      fetched_at: timestamp,
    },
    warnings: [],
  };
}

test("state paths follow Darwin and Linux conventions and reject unsafe platforms", () => {
  const darwin = resolveStatePaths({ platform: "darwin", homedir: join("/", "Users", "example"), env: {} });
  const linuxDefault = resolveStatePaths({ platform: "linux", homedir: join("/", "home", "example"), env: {} });
  const linuxXdg = resolveStatePaths({ platform: "linux", homedir: join("/", "home", "example"), env: { XDG_STATE_HOME: "/state" } });
  assert.equal(darwin.root, join("/", "Users", "example", "Library", "Application Support", "git-mcp-server"));
  assert.equal(linuxDefault.root, join("/", "home", "example", ".local", "state", "git-mcp-server"));
  assert.equal(linuxXdg.root, "/state/git-mcp-server");
  assert.throws(
    () => resolveStatePaths({ platform: "linux", homedir: join("/", "home", "example"), env: { XDG_STATE_HOME: "relative" } }),
    /XDG_STATE_HOME/,
  );
  assert.throws(() => resolveStatePaths({ platform: "win32", homedir: "C:\\Users\\example", env: {} }), /Unsupported/);
});

test("state paths initialize and tighten every directory to 0700", async (t) => {
  const paths = await temporaryState(t);
  for (const directory of Object.values(paths)) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  }
  await import("node:fs/promises").then(({ chmod }) => chmod(paths.stages, 0o755));
  await initializeStatePaths(paths);
  assert.equal((await stat(paths.stages)).mode & 0o777, 0o700);
});

test("atomic JSON replaces canonically, uses 0600, and leaves no private temp files", async (t) => {
  const paths = await temporaryState(t);
  const target = join(paths.repositories, "record.json");
  await atomicWriteJson(target, { z: 1, a: { y: 2, x: 3 } });
  assert.equal(await readFile(target, "utf8"), '{"a":{"x":3,"y":2},"z":1}\n');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await atomicWriteJson(target, { replacement: true });
  assert.deepEqual(await readJson(target), { replacement: true });
  await assert.rejects(atomicWriteJson(target, { invalid: undefined }), /JSON/);
  assert.deepEqual(await readJson(target), { replacement: true });
  assert.deepEqual(await readdir(paths.repositories), ["record.json"]);
  await assert.rejects(atomicWriteJson(target, { value: Number.NaN }), /finite/);
  await assert.rejects(atomicWriteJson(target, new (class Unsafe { value = 1; })()), /prototype/);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  await assert.rejects(atomicWriteJson(target, cycle), /circular/);
  let getterCalls = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    configurable: true, enumerable: true,
    get: () => { getterCalls += 1; return "secret"; },
  });
  await assert.rejects(atomicWriteJson(target, accessorArray), /array.*propert|accessor/i);
  assert.equal(getterCalls, 0);
});

test("JSON reads reject final symlinks, oversized files, malformed JSON, and missing files return null", async (t) => {
  const paths = await temporaryState(t);
  const target = join(paths.repositories, "target.json");
  const link = join(paths.repositories, "link.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(readJson(link), /symlink/);
  await assert.rejects(readJson(target, { maxBytes: 2 }), /too large/);
  await writeFile(target, "not-json\n", { mode: 0o600 });
  await assert.rejects(readJson(target), /Malformed JSON/);
  assert.equal(await readJson(join(paths.repositories, "missing.json")), null);
});

test("JSON reads tighten owned files and promptly reject FIFO and other nonregular types", async (t) => {
  const paths = await temporaryState(t);
  const loose = join(paths.repositories, "loose.json");
  await writeFile(loose, "{}\n", { mode: 0o644 });
  await chmod(loose, 0o644);
  assert.deepEqual(await readJson(loose), {});
  assert.equal((await stat(loose)).mode & 0o777, 0o600);

  const fifo = join(paths.repositories, "record.fifo");
  await execFileAsync("mkfifo", [fifo]);
  await Promise.race([
    assert.rejects(readJson(fifo), /regular file/),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("FIFO read blocked")), 500)),
  ]);
  await assert.rejects(readJson(paths.repositories), /regular file/);
});

test("new operation directory is private and parent-synced before request publication and execute", async (t) => {
  const paths = await temporaryState(t);
  const order: string[] = [];
  const journalOptions = {
    now: () => timestamp, pid: 123,
    onOperationsDirectorySynced: async (directory: string) => {
      assert.equal(directory, paths.operations);
      assert.deepEqual(await readdir(join(paths.operations, "sync-order")), []);
      assert.equal((await stat(join(paths.operations, "sync-order"))).mode & 0o777, 0o700);
      order.push("parent-sync");
    },
  };
  const journal = new OperationJournal(paths, journalOptions);
  const result = await journal.begin({ requestId: "sync-order", operation: "git_commit", repositoryId, input: {} });
  order.push(result.kind);
  assert.deepEqual(order, ["parent-sync", "execute"]);
});

test("operation journal executes, hashes canonical raw input, replays, and rejects request reuse", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const request = { requestId: "request-1", operation: "git_commit", repositoryId, input: { z: [2, 1], a: "x" } };
  assert.deepEqual(await journal.begin(request), { kind: "execute" });
  await journal.complete("request-1", successResult());
  const replay = await journal.begin({ ...request, input: { a: "x", z: [2, 1] } });
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") assert.equal(replay.result.result.status, "succeeded");
  await assert.rejects(
    journal.begin({ ...request, input: { a: "different", z: [2, 1] } }),
    (error: unknown) => error instanceof BridgeRejection && error.error.code === "REQUEST_ID_REUSED",
  );
  await assert.rejects(journal.begin({ ...request, operation: "git_push" }), /request ID/i);
});

test("indeterminate fallback publication is a distinct sanitized durable boundary and reloads its result", async (t) => {
  const paths = await temporaryState(t);
  const publications: string[] = [];
  const journal = new OperationJournal(paths, {
    now: () => timestamp, pid: 123,
    publishResult: async ({ kind, path, record }) => {
      publications.push(kind);
      await atomicCreateJson(path, record);
    },
  });
  await journal.begin({
    requestId: "fallback-boundary", operation: "git_commit", repositoryId,
    input: { message: "password=private-input", output: "token=private-output" },
  });

  const fallback = await journal.completeIndeterminate("fallback-boundary");
  assert.equal(fallback.result.status, "indeterminate");
  assert.equal(fallback.result.request_id, "fallback-boundary");
  assert.equal(fallback.result.repository_id, repositoryId);
  assert.equal(fallback.result.operation, "git_commit");
  assert.equal(fallback.result.data, undefined);
  assert.equal(fallback.result.observed_before, undefined);
  assert.deepEqual(await journal.get("fallback-boundary"), fallback);
  assert.deepEqual(publications, ["indeterminate-fallback"]);
  assert.doesNotMatch(await readFile(join(paths.operations, "fallback-boundary", "result.json"), "utf8"), /private-input|private-output/);
});

test("terminal no-replace publication returns the visible result after post-link cleanup failure", async (t) => {
  const paths = await temporaryState(t);
  const steps: AtomicCreateStep[] = [];
  const warnings: string[] = [];
  const journal = new OperationJournal(paths, {
    now: () => timestamp,
    publishResult: async (publication: ResultPublication) => faultInjectableAtomicCreate(publication.path, publication.record, {
      onStep: (step) => {
        steps.push(step);
        if (step === "linked") throw new Error("simulated temporary unlink failure");
      },
    }),
    onResultPublicationWarning: async (requestId: string) => { warnings.push(requestId); },
  } as unknown as OperationJournalOptions);
  await journal.begin({ requestId: "cleanup-commit", operation: "git_commit", repositoryId, input: {} });

  const immediate = await journal.complete("cleanup-commit", successResult("git_commit", "cleanup-commit"));
  const replay = await journal.get("cleanup-commit");

  assert.deepEqual(immediate, replay);
  assert.equal(immediate.result.status, "succeeded");
  assert.deepEqual(steps, ["linked", "temporary-unlinked", "directory-synced"]);
  assert.deepEqual(warnings, ["cleanup-commit"]);
});

test("terminal no-replace publication durably prioritizes directory fsync uncertainty", async (t) => {
  const paths = await temporaryState(t);
  const steps: AtomicCreateStep[] = [];
  const journal = new OperationJournal(paths, {
    now: () => timestamp,
    publishResult: async (publication: ResultPublication) => publication.kind === "terminal"
      ? faultInjectableAtomicCreate(publication.path, publication.record, {
          onStep: (step) => {
            steps.push(step);
            if (step === "temporary-unlinked") throw new Error("simulated directory fsync failure");
          },
        })
      : atomicCreateJson(publication.path, publication.record),
  } as unknown as OperationJournalOptions);
  await journal.begin({ requestId: "fsync-uncertain", operation: "git_commit", repositoryId, input: {} });

  const immediate = await journal.complete("fsync-uncertain", successResult("git_commit", "fsync-uncertain"));
  const liveRead = await journal.get("fsync-uncertain");
  const restarted = new OperationJournal(paths);
  const restartedRead = await restarted.get("fsync-uncertain");
  const recovery = await restarted.recoverStarted("fsync-uncertain");

  assert.deepEqual(steps, ["linked", "temporary-unlinked"]);
  assert.equal(immediate.result.status, "indeterminate");
  assert.equal(immediate.result.error?.code, "OPERATION_INDETERMINATE");
  assert.deepEqual(liveRead, immediate);
  assert.deepEqual(restartedRead, immediate);
  assert.deepEqual(recovery, { kind: "terminal", requestId: "fsync-uncertain", result: immediate });
  assert.deepEqual(await restarted.findRecoveryCandidates(), []);
});

test("terminal and uncertainty links require an explicit directory-sync confirmation before replay", async (t) => {
  const paths = await temporaryState(t);
  const publications: string[] = [];
  const confirmations: string[] = [];
  const options = {
    now: () => timestamp,
    publishResult: async (publication: ResultPublication) => {
      publications.push(publication.kind);
      return faultInjectableAtomicCreate(publication.path, publication.record, {
        onStep: (step) => {
          if (step === "temporary-unlinked") throw new Error(`simulated ${publication.kind} directory fsync failure`);
        },
      });
    },
    syncOperationDirectory: async (directory: string) => { confirmations.push(directory); },
  } as unknown as OperationJournalOptions;
  const journal = new OperationJournal(paths, options);
  await journal.begin({ requestId: "double-fsync-uncertain", operation: "git_commit", repositoryId, input: {} });

  const immediate = await journal.complete(
    "double-fsync-uncertain",
    successResult("git_commit", "double-fsync-uncertain"),
  );
  const liveRead = await journal.get("double-fsync-uncertain");
  const restarted = new OperationJournal(paths, options);
  const restartedRead = await restarted.get("double-fsync-uncertain");
  const recovery = await restarted.recoverStarted("double-fsync-uncertain");

  assert.deepEqual(publications, ["terminal", "durability-fallback"]);
  assert.ok(confirmations.length >= 4);
  assert.ok(confirmations.every((directory) => directory === join(paths.operations, "double-fsync-uncertain")));
  assert.equal(immediate.result.status, "indeterminate");
  assert.equal(immediate.result.error?.code, "OPERATION_INDETERMINATE");
  assert.deepEqual(liveRead, immediate);
  assert.deepEqual(restartedRead, immediate);
  assert.deepEqual(recovery, { kind: "terminal", requestId: "double-fsync-uncertain", result: immediate });
  assert.deepEqual(await restarted.findRecoveryCandidates(), []);
});

test("operation journal preserves structured path and ref values while sanitizing credential and diagnostic fields", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const request = {
    requestId: "secret-request", operation: "git_commit", repositoryId,
    input: {
      repository: "/repo/password=value",
      expected_branch: "password=value",
      expected_head: objectId,
      paths: ["password=value", "token=value"],
      "password=key-secret": "safe",
      password: "hunter2",
      Authorization: { bearer: "credential" },
      metadata: {
        accessToken: 123, client_secret: ["credential"],
        userRemote: "git@example.test:owner/private.git",
        userlessRemote: "example.test:owner/private.git",
      },
    },
  };
  await journal.begin(request);
  const persisted = await readFile(join(paths.operations, "secret-request", "request.json"), "utf8");
  assert.doesNotMatch(persisted, /hunter2|user:pass|example\.test\/full/);
  assert.doesNotMatch(persisted, /git@example\.test|example\.test:|owner\/private|credential|123/);
  const persistedRequest = JSON.parse(persisted) as { input: Record<string, unknown> };
  assert.equal(persistedRequest.input.repository, "/repo/password=value");
  assert.equal(persistedRequest.input.expected_branch, "password=value");
  assert.deepEqual(persistedRequest.input.paths, ["password=value", "token=value"]);
  assert.equal(persistedRequest.input["password=key-secret"], "safe");
  assert.equal(persistedRequest.input.password, "[REDACTED]");
  assert.equal(persistedRequest.input.Authorization, "[REDACTED]");
  assert.deepEqual(persistedRequest.input.metadata, {
    accessToken: "[REDACTED]", client_secret: "[REDACTED]",
    userRemote: "[REMOTE_URL_REDACTED]", userlessRemote: "[REMOTE_URL_REDACTED]",
  });
  await assert.rejects(journal.begin({ ...request, input: { ...request.input, paths: ["password=different"] } }), /request ID/i);
  await journal.complete("secret-request", {
    status: "failed", request_id: "secret-request", repository_id: repositoryId,
    operation: "git_commit", warnings: [
      "token=warning-secret",
      "remote https://user:pass@example.test/private/repo.git",
    ],
    observed_before: {
      path: "password=value",
      ref: "refs/heads/password=value",
      head: objectId,
      labels: { password: objectId, "password=value": "one", "password=[REDACTED]": "two" },
      message: "password=observation-secret",
      password: "observation-credential",
      remote_url: "git@example.test:owner/private.git",
    },
    error: {
      code: "GIT_FAILED", message: "password=message-secret endpoint ssh://user:pass@example.test/private/repo.git",
      details: {
        nested: ["secret=detail-secret"], password: 42,
        authorizationHeader: ["Bearer credential"], refresh_token: { value: "credential" },
        remote_url: "git@example.test:owner/private.git",
      },
    },
  });
  const result = await readFile(join(paths.operations, "secret-request", "result.json"), "utf8");
  assert.doesNotMatch(result, /warning-secret|message-secret|detail-secret|credential|42|example\.test|owner\/private/);
  const persistedResult = JSON.parse(result) as {
    result: {
      observed_before: Record<string, unknown>;
      warnings: string[];
      error: { message: string; details: Record<string, unknown> };
    };
  };
  assert.equal(persistedResult.result.observed_before.path, "password=value");
  assert.equal(persistedResult.result.observed_before.ref, "refs/heads/password=value");
  assert.equal(persistedResult.result.observed_before.head, objectId);
  assert.deepEqual(persistedResult.result.observed_before.labels, {
    password: objectId, "password=value": "one", "password=[REDACTED]": "two",
  });
  assert.equal(persistedResult.result.observed_before.message, "password=[REDACTED]");
  assert.equal(persistedResult.result.observed_before.password, "[REDACTED]");
  assert.equal(persistedResult.result.observed_before.remote_url, "[REMOTE_URL_REDACTED]");
  assert.match(persistedResult.result.warnings[1]!, /\[REMOTE_URL_REDACTED\]/);
  assert.match(persistedResult.result.error.message, /\[REMOTE_URL_REDACTED\]/);
  assert.equal(persistedResult.result.error.details.password, "[REDACTED]");
  assert.equal(persistedResult.result.error.details.authorizationHeader, "[REDACTED]");
  assert.equal(persistedResult.result.error.details.refresh_token, "[REDACTED]");
  assert.equal(persistedResult.result.error.details.remote_url, "[REMOTE_URL_REDACTED]");
});

test("operation journal persists only the bounded hook failure contract", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const request = {
    requestId: "hook-failure", operation: "git_commit", repositoryId,
    input: {
      repository: "/repo", expected_branch: "main", expected_head: objectId,
      stage_id: "stage-hook", message: "synthetic-journal-secret",
    },
  };
  await journal.begin(request);
  await journal.complete(request.requestId, {
    status: "failed", request_id: request.requestId, repository_id: repositoryId,
    operation: request.operation, warnings: [],
    error: { code: "HOOK_FAILED", message: HOOK_FAILED_MESSAGE, details: { hook: "commit-msg" } },
  });

  const operationDirectory = join(paths.operations, request.requestId);
  const requestJson = await readFile(join(operationDirectory, "request.json"), "utf8");
  const resultJson = await readFile(join(operationDirectory, "result.json"), "utf8");
  const persisted = `${requestJson}\n${resultJson}`;
  assert.doesNotMatch(persisted, /synthetic-journal-secret|stdout|stderr|exit(?:_| )?(?:code|status)/i);
  assert.match(resultJson, /"code":"HOOK_FAILED"/);
  assert.match(resultJson, /"hook":"commit-msg"/);
  assert.match(resultJson, new RegExp(HOOK_FAILED_MESSAGE));
});

test("operation journal safely replays a legacy HOOK_FAILED record without its diagnostics", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const request = {
    requestId: "legacy-hook-failure", operation: "git_commit", repositoryId,
    input: {
      repository: "/repo", expected_branch: "main", expected_head: objectId,
      stage_id: "legacy-stage", message: "current request message",
    },
  };
  assert.deepEqual(await journal.begin(request), { kind: "execute" });
  const legacySecret = "legacy-hook-diagnostic-secret";
  await writeFile(join(paths.operations, request.requestId, "result.json"), JSON.stringify({
    requestId: request.requestId,
    completedAt: timestamp,
    result: {
      status: "failed", request_id: request.requestId, repository_id: repositoryId,
      operation: request.operation, warnings: [],
      error: {
        code: "HOOK_FAILED",
        message: legacySecret,
        details: { raw: legacySecret, exit_status: 37 },
      },
    },
  }));

  const replay = await journal.get(request.requestId);
  assert.deepEqual(replay?.result.error, {
    code: "GIT_FAILED",
    message: "Git did not create a commit",
  });
  assert.doesNotMatch(JSON.stringify(replay), new RegExp(legacySecret));
  assert.doesNotMatch(JSON.stringify(replay), /exit_status|37/);
  const migrated = await readFile(join(paths.operations, request.requestId, "result.json"), "utf8");
  assert.doesNotMatch(migrated, new RegExp(legacySecret));
  assert.doesNotMatch(migrated, /exit_status|37/);
  assert.deepEqual(JSON.parse(migrated), replay);
});

test("operation journal rejects corrupt records that resemble legacy HOOK_FAILED", async (t) => {
  for (const [name, error] of [
    ["missing-message", { code: "HOOK_FAILED", details: { raw: "diagnostic" } }],
    ["unknown-key", { code: "HOOK_FAILED", message: "diagnostic", unexpected: true }],
  ] as const) {
    await t.test(name, async (t) => {
      const paths = await temporaryState(t);
      const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
      const request = {
        requestId: `legacy-corrupt-${name}`, operation: "git_commit", repositoryId,
        input: {
          repository: "/repo", expected_branch: "main", expected_head: objectId,
          stage_id: "legacy-stage", message: "current request message",
        },
      };
      assert.deepEqual(await journal.begin(request), { kind: "execute" });
      const resultPath = join(paths.operations, request.requestId, "result.json");
      await writeFile(resultPath, JSON.stringify({
        requestId: request.requestId,
        completedAt: timestamp,
        result: {
          status: "failed", request_id: request.requestId, repository_id: repositoryId,
          operation: request.operation, warnings: [], error,
        },
      }));

      await assert.rejects(journal.get(request.requestId), /Bridge error|HOOK_FAILED/);
      assert.match(await readFile(resultPath, "utf8"), /diagnostic|unexpected/);
    });
  }
});

test("operation journal never persists a raw commit message but hashes it for request reuse", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const request = {
    requestId: "message-secret", operation: "git_commit", repositoryId,
    input: {
      repository: "/repo", expected_branch: "main", expected_head: objectId,
      stage_id: "stage-message", message: "private subject\n\nprivate body",
    },
  };
  assert.deepEqual(await journal.begin(request), { kind: "execute" });
  const persisted = await readFile(join(paths.operations, request.requestId, "request.json"), "utf8");
  assert.doesNotMatch(persisted, /private subject|private body/);
  assert.match(persisted, /\[COMMIT_MESSAGE_REDACTED\]/);
  await assert.rejects(journal.begin({
    ...request, input: { ...request.input, message: "different private body" },
  }), (error) => error instanceof BridgeRejection && error.error.code === "REQUEST_ID_REUSED");
  await journal.complete(request.requestId, successResult("git_commit", request.requestId));
  const replay = await journal.begin(request);
  assert.equal(replay.kind, "replay");
});

test("operation journal redacts every guarded-history replacement message while retaining the original request hash", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const reword = {
    requestId: "reword-message-secret", operation: "git_reword", repositoryId,
    input: {
      repository: "/repo", expected_branch: "main", expected_head: objectId, base: objectId,
      commits: [{ commit: objectId, message: "reword synthetic secret" }], destination: { mode: "current_branch" },
    },
  };
  const amend = {
    requestId: "amend-message-secret", operation: "git_commit_amend", repositoryId,
    input: {
      repository: "/repo", expected_branch: "main", expected_head: objectId, stage_id: "stage-1",
      worktree_snapshot_id: "a".repeat(64), message: "amend synthetic secret",
    },
  };
  await journal.begin(reword);
  await journal.begin(amend);
  const persisted = await Promise.all([reword, amend].map(async ({ requestId }) =>
    readFile(join(paths.operations, requestId, "request.json"), "utf8")));
  for (const value of persisted) {
    assert.match(value, /\[COMMIT_MESSAGE_REDACTED\]/);
    assert.doesNotMatch(value, /synthetic secret/);
  }
  await assert.rejects(journal.begin({
    ...reword, input: { ...reword.input, commits: [{ commit: objectId, message: "different synthetic secret" }] },
  }), (error) => error instanceof BridgeRejection && error.error.code === "REQUEST_ID_REUSED");
});

test("operation journal preserves validated colon paths and rejects malformed operation output", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const request = {
    requestId: "typed-colon-path", operation: "git_commit", repositoryId,
    input: { repository: "/repo", paths: ["dir:name/file.ts"] },
  };
  await journal.begin(request);
  const result = {
    ...successResult("git_commit", request.requestId),
    data: {
      commit: objectId, tree: objectId,
      hook_changed_paths: ["dir:name/file.ts"], signing: "disabled_by_policy" as const,
    },
  };

  const completed = await journal.complete(request.requestId, result);
  const replay = await journal.begin(request);

  assert.deepEqual(completed.result.data, result.data);
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") assert.deepEqual(replay.result.result.data, result.data);
  assert.match(await readFile(join(paths.operations, request.requestId, "request.json"), "utf8"), /dir:name\/file\.ts/);

  await journal.begin({ requestId: "invalid-output", operation: "git_commit", repositoryId, input: {} });
  await assert.rejects(journal.complete("invalid-output", {
    status: "succeeded", request_id: "invalid-output", repository_id: repositoryId,
    operation: "git_commit", data: { commit: objectId }, warnings: [],
  }), /output|data|tree|signing/i);
  assert.equal(await journal.get("invalid-output"), null);
});

test("operation journal enforces the bounded commit-range validation result", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const valid = { requestId: "range-128", operation: "git_commit_range_validate", repositoryId, input: {} };
  await journal.begin(valid);
  const result = {
    status: "succeeded" as const, request_id: valid.requestId, repository_id: repositoryId,
    operation: valid.operation, data: {
      base: objectId, head: "c".repeat(40), commit_count: 128, hook: "commit-msg" as const,
    }, warnings: [],
  };
  await journal.complete(valid.requestId, result);
  const replay = await journal.begin(valid);
  assert.equal(replay.kind, "replay");

  const invalid = { requestId: "range-129", operation: "git_commit_range_validate", repositoryId, input: {} };
  await journal.begin(invalid);
  await assert.rejects(journal.complete(invalid.requestId, {
    ...result, request_id: invalid.requestId, data: { ...result.data, commit_count: 129 },
  }), /output|data|commit_count/i);
  assert.equal(await journal.get(invalid.requestId), null);
  await writeFile(join(paths.operations, invalid.requestId, "result.json"), JSON.stringify({
    requestId: invalid.requestId, completedAt: timestamp,
    result: { ...result, request_id: invalid.requestId, data: { ...result.data, commit_count: 129 } },
  }));
  await assert.rejects(journal.get(invalid.requestId), /output|data|commit_count/i);
});

test("request-only journal state resumes execution while started state becomes durable indeterminate", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const request = { requestId: "request-only", operation: "git_commit", repositoryId, input: { a: 1 } };
  await journal.begin(request);
  await unlink(join(paths.operations, "request-only", "started.json"));
  assert.deepEqual(await journal.begin(request), { kind: "execute" });
  const indeterminate = await journal.begin(request);
  assert.equal(indeterminate.kind, "indeterminate");
  if (indeterminate.kind === "indeterminate") {
    assert.equal(indeterminate.result.result.status, "indeterminate");
    assert.equal(indeterminate.result.result.error?.code, "OPERATION_INDETERMINATE");
  }
  assert.equal((await journal.get("request-only"))?.result.status, "indeterminate");
});

test("terminal journal results are immutable and cannot be overwritten", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  await journal.begin({ requestId: "immutable", operation: "git_commit", repositoryId, input: {} });
  await journal.complete("immutable", successResult("git_commit", "immutable"));
  await assert.rejects(journal.complete("immutable", {
    status: "failed", request_id: "immutable", repository_id: repositoryId,
    operation: "git_commit", warnings: [], error: { code: "GIT_FAILED", message: "replacement" },
  }), /already exists/);
  assert.equal((await journal.get("immutable"))?.result.status, "succeeded");
});

test("terminal journal result identity is mandatory and bound to the persisted request", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  await journal.begin({ requestId: "bound-result", operation: "git_commit", repositoryId, input: {} });
  const valid = successResult("git_commit", "bound-result");
  const { request_id: _requestId, ...missingRequestId } = valid;
  await assert.rejects(journal.complete("bound-result", missingRequestId), /request.*ID/i);
  await assert.rejects(journal.complete("bound-result", { ...valid, request_id: "other" }), /request.*ID/i);
  const { repository_id: _repositoryId, ...missingRepositoryId } = valid;
  await assert.rejects(journal.complete("bound-result", missingRepositoryId), /repository.*ID/i);
  await assert.rejects(journal.complete("bound-result", { ...valid, repository_id: "c".repeat(64) }), /repository.*ID/i);
  await assert.rejects(journal.complete("bound-result", { ...valid, operation: "git_push" }), /operation/i);
  assert.equal(await journal.get("bound-result"), null);
});

test("replay, get, and recovery reject terminal records whose inner identity is corrupt", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const cases = [
    { requestId: "corrupt-get", mutation: (result: Record<string, unknown>) => { delete result.request_id; } },
    { requestId: "corrupt-replay", mutation: (result: Record<string, unknown>) => { result.repository_id = "c".repeat(64); } },
    { requestId: "corrupt-recovery", mutation: (result: Record<string, unknown>) => {
      result.operation = "git_push";
      result.data = { local_head: objectId, remote_head: objectId };
    } },
  ] as const;
  const persisted = new Map<string, string>();
  for (const entry of cases) {
    const request = { requestId: entry.requestId, operation: "git_commit", repositoryId, input: {} };
    await journal.begin(request);
    await journal.complete(entry.requestId, successResult("git_commit", entry.requestId));
    const resultPath = join(paths.operations, entry.requestId, "result.json");
    const record = JSON.parse(await readFile(resultPath, "utf8")) as { result: Record<string, unknown> };
    entry.mutation(record.result);
    await atomicWriteJson(resultPath, record);
    persisted.set(entry.requestId, await readFile(resultPath, "utf8"));
  }

  await assert.rejects(journal.get("corrupt-get"), /request.*ID/i);
  await assert.rejects(
    journal.begin({ requestId: "corrupt-replay", operation: "git_commit", repositoryId, input: {} }),
    /repository.*ID/i,
  );
  const candidates = await journal.findRecoveryCandidates();
  assert.ok(candidates.some((entry) => entry.kind === "corrupt" && entry.requestId === "corrupt-recovery" && /operation/i.test(entry.error)));
  for (const entry of cases) {
    assert.equal(await readFile(join(paths.operations, entry.requestId, "result.json"), "utf8"), persisted.get(entry.requestId));
  }
});

test("get, replay, and recovery reject malformed operation data and status-payload combinations", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const cases = ["invalid-load-data", "invalid-replay-status", "invalid-recovery-status"] as const;
  for (const requestId of cases) {
    await journal.begin({ requestId, operation: "git_commit", repositoryId, input: {} });
    await journal.complete(requestId, successResult("git_commit", requestId));
  }

  const dataPath = join(paths.operations, cases[0], "result.json");
  const malformedData = JSON.parse(await readFile(dataPath, "utf8")) as { result: Record<string, unknown> };
  malformedData.result.data = { commit: objectId };
  await atomicWriteJson(dataPath, malformedData);

  const replayPath = join(paths.operations, cases[1], "result.json");
  const invalidReplay = JSON.parse(await readFile(replayPath, "utf8")) as { result: Record<string, unknown> };
  invalidReplay.result.status = "failed";
  invalidReplay.result.error = { code: "GIT_FAILED", message: "failed" };
  await atomicWriteJson(replayPath, invalidReplay);

  const recoveryPath = join(paths.operations, cases[2], "result.json");
  const invalidRecovery = JSON.parse(await readFile(recoveryPath, "utf8")) as { result: Record<string, unknown> };
  invalidRecovery.result.error = { code: "GIT_FAILED", message: "cannot accompany success" };
  await atomicWriteJson(recoveryPath, invalidRecovery);

  await assert.rejects(journal.get(cases[0]), /operation output|output data/i);
  await assert.rejects(
    journal.begin({ requestId: cases[1], operation: "git_commit", repositoryId, input: {} }),
    /failed.*data|data.*failed/i,
  );
  await assert.rejects(journal.recoverStarted(cases[2]), /succeeded.*error|error.*succeeded/i);
  const candidates = await journal.findRecoveryCandidates();
  assert.ok(candidates.some((entry) => entry.kind === "corrupt" && entry.requestId === cases[2]));
});

test("persisted fetch results reject non-origin and ambiguous-Unicode ref keys on get and replay", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  const cases = [
    ["fetch-key-get", "refs/heads/main"],
    ["fetch-key-replay", "refs/remotes/origin/bad\uD800ref"],
    ["fetch-key-replacement", "refs/remotes/origin/bad\uFFFDref"],
  ] as const;
  for (const [requestId, ref] of cases) {
    await journal.begin({ requestId, operation: "git_fetch", repositoryId, input: {} });
    await journal.complete(requestId, fetchSuccessResult(requestId));
    const resultPath = join(paths.operations, requestId, "result.json");
    const record = JSON.parse(await readFile(resultPath, "utf8")) as {
      result: { data: { refs_after: Record<string, string> } };
    };
    record.result.data.refs_after = { [ref]: objectId };
    await atomicWriteJson(resultPath, record);
  }

  await assert.rejects(journal.get("fetch-key-get"), /origin ref|output data/i);
  await assert.rejects(
    journal.begin({ requestId: "fetch-key-replay", operation: "git_fetch", repositoryId, input: {} }),
    /origin ref|output data/i,
  );
  await assert.rejects(journal.get("fetch-key-replacement"), /origin ref|output data/i);
});

test("existing empty operation directories resume safely but orphan content fails closed", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  await mkdir(join(paths.operations, "empty-orphan"), { mode: 0o755 });
  assert.deepEqual(await journal.begin({ requestId: "empty-orphan", operation: "git_commit", repositoryId, input: {} }), { kind: "execute" });
  assert.equal((await stat(join(paths.operations, "empty-orphan"))).mode & 0o777, 0o700);

  for (const [requestId, file] of [["orphan-started", "started.json"], ["orphan-result", "result.json"], ["orphan-other", "unexpected"]] as const) {
    const directory = join(paths.operations, requestId);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, file), "{}\n", { mode: 0o600 });
    await assert.rejects(
      journal.begin({ requestId, operation: "git_commit", repositoryId, input: {} }),
      /orphan|corrupt/i,
    );
    await assert.rejects(readFile(join(directory, "request.json")));
  }
});

test("recognized request publication temps permit safe no-replace publication and concurrent hash arbitration", async (t) => {
  const paths = await temporaryState(t);
  const tempName = ".request.json.123.123e4567-e89b-12d3-a456-426614174000.tmp";
  const singleDirectory = join(paths.operations, "temp-remnant");
  await mkdir(singleDirectory, { mode: 0o700 });
  await writeFile(join(singleDirectory, tempName), "partial private temp", { mode: 0o600 });
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  assert.deepEqual(await journal.begin({ requestId: "temp-remnant", operation: "git_commit", repositoryId, input: { value: 1 } }), { kind: "execute" });
  assert.equal(await readFile(join(singleDirectory, tempName), "utf8"), "partial private temp");

  const raceDirectory = join(paths.operations, "temp-race");
  await mkdir(raceDirectory, { mode: 0o700 });
  await writeFile(join(raceDirectory, tempName), "concurrent private temp", { mode: 0o600 });
  const contenders = await Promise.allSettled([
    new OperationJournal(paths, { now: () => timestamp, pid: 201 }).begin({ requestId: "temp-race", operation: "git_commit", repositoryId, input: { winner: "one" } }),
    new OperationJournal(paths, { now: () => timestamp, pid: 202 }).begin({ requestId: "temp-race", operation: "git_commit", repositoryId, input: { winner: "two" } }),
  ]);
  assert.equal(contenders.filter((entry) => entry.status === "fulfilled" && entry.value.kind === "execute").length, 1);
  assert.equal(contenders.filter((entry) => entry.status === "rejected" && entry.reason instanceof BridgeRejection && entry.reason.error.code === "REQUEST_ID_REUSED").length, 1);
  assert.equal(await readFile(join(raceDirectory, tempName), "utf8"), "concurrent private temp");
});

test("journal recovery discovery is non-writing and exact recovery finalizes one locked candidate", async (t) => {
  const paths = await temporaryState(t);
  const journal = new OperationJournal(paths, { now: () => timestamp, pid: 123 });
  await journal.begin({ requestId: "recover-one", operation: "git_commit", repositoryId, input: {} });
  await journal.begin({ requestId: "recover-two", operation: "git_push", repositoryId, input: {} });
  await atomicWriteJson(join(paths.operations, "recover-two", "request.json"), { corrupt: true });
  await writeFile(join(paths.operations, "regular-entry"), "not an operation directory", { mode: 0o600 });
  await symlink(join(paths.operations, "recover-one"), join(paths.operations, "symlink-entry"));
  const candidates = await journal.findRecoveryCandidates();
  assert.ok(candidates.some((entry) => entry.kind === "candidate" && entry.requestId === "recover-one" && entry.repositoryId === repositoryId));
  assert.ok(candidates.some((entry) => entry.kind === "corrupt" && entry.requestId === "recover-two"));
  assert.ok(candidates.some((entry) => entry.kind === "corrupt" && entry.requestId === "regular-entry"));
  assert.ok(candidates.some((entry) => entry.kind === "corrupt" && entry.requestId === "symlink-entry"));
  assert.equal(await journal.get("recover-one"), null);
  const recovered = await journal.recoverStarted("recover-one");
  assert.equal(recovered.kind, "recovered");
  assert.equal((await journal.get("recover-one"))?.result.error?.code, "OPERATION_INDETERMINATE");
  await unlink(join(paths.operations, "recover-one", "started.json"));
  await assert.rejects(journal.get("recover-one"), /started record is missing/);
  await assert.rejects(journal.get("recover-two"), /Operation request record/);
});

function records(): { stage: StageRecord; fetch: FetchRecord; merge: MergeRecord } {
  return {
    stage: {
      kind: "stage", stageId: "stage-1", repositoryId, branch: "main", baseHead: objectId,
      initialIndexTree: "d".repeat(64), currentIndexTree: "d".repeat(64), ownedPaths: ["src/a.ts"],
      createdAt: timestamp, updatedAt: timestamp,
    },
    fetch: {
      kind: "fetch", fetchId: "fetch-1", repositoryId, branch: "main", head: objectId,
      remoteIdentity: { scheme: "ssh", host: "example.test", pathHash: "c".repeat(64) },
      refsBefore: { "refs/remotes/origin/main": objectId }, refsAfter: { "refs/remotes/origin/main": objectId },
      fetchedAt: timestamp,
    },
    merge: {
      kind: "merge", mergeSessionId: "merge-1", repositoryId, branch: "main", originalHead: objectId,
      targetObject: objectId, fetchId: "fetch-1", currentIndexTree: "a".repeat(64), conflictedPaths: ["a.txt"], resolvedPaths: [],
      createdAt: timestamp, updatedAt: timestamp,
    },
  };
}

test("session store round-trips exact typed records and deletes only the derived file", async (t) => {
  const paths = await temporaryState(t);
  const store = new SessionStore(paths);
  const { stage, fetch, merge } = records();
  await store.putStage(stage); await store.putFetch(fetch); await store.putMerge(merge);
  assert.deepEqual(await store.getStage(stage.stageId), stage);
  assert.deepEqual(await store.getFetch(fetch.fetchId), fetch);
  assert.deepEqual(await store.getMerge(merge.mergeSessionId), merge);
  await writeFile(join(paths.stages, "unrelated"), "sentinel");
  await store.deleteStage(stage.stageId);
  await store.deleteStage(stage.stageId);
  assert.equal(await store.getStage(stage.stageId), null);
  assert.equal(await readFile(join(paths.stages, "unrelated"), "utf8"), "sentinel");
});

test("session store rejects traversal, mismatched kind and ID, extra keys, and invalid object IDs", async (t) => {
  const paths = await temporaryState(t);
  const store = new SessionStore(paths);
  const { stage } = records();
  await assert.rejects(store.getStage("../escape"), /ID/);
  await atomicWriteJson(join(paths.stages, "stage-1.json"), { ...stage, kind: "fetch" });
  await assert.rejects(store.getStage("stage-1"), /Stage record/);
  await atomicWriteJson(join(paths.stages, "stage-1.json"), { ...stage, stageId: "other" });
  await assert.rejects(store.getStage("stage-1"), /does not match/);
  await atomicWriteJson(join(paths.stages, "stage-1.json"), { ...stage, extra: true });
  await assert.rejects(store.getStage("stage-1"), /Stage record/);
  await assert.rejects(store.putStage({ ...stage, baseHead: "not-an-object" }), /Stage record/);
});

test("repository registry persists only strict canonical repository identity fields", async (t) => {
  const paths = await temporaryState(t);
  const registry = new RepositoryRegistry(paths);
  const record: RepositoryRecord = {
    repositoryId, root: paths.root, gitDir: paths.repositories,
    commonGitDir: paths.repositories, lastSeenAt: timestamp,
  };
  await registry.put(record);
  assert.deepEqual(await registry.get(repositoryId), record);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(paths.repositories, `${repositoryId}.json`), "utf8"))).sort(),
    ["commonGitDir", "gitDir", "lastSeenAt", "repositoryId", "root"]);
  await assert.rejects(registry.put({ ...record, remoteUrl: "https://user:pass@example.test/repo" } as RepositoryRecord), /Repository record/);
  await assert.rejects(registry.put({ ...record, root: `${paths.root}/../git-mcp-server` }), /canonical/);
  await assert.rejects(registry.get("../escape"), /ID/);
});

test("audit log appends sanitized strict JSONL below 8 KiB with 0600 mode", async (t) => {
  const paths = await temporaryState(t);
  const audit = new AuditLog(paths);
  await audit.append({
    timestamp, requestId: "audit-1", operation: "git_commit", repositoryId,
    status: "failed", durationMs: 12, errorCode: "HOOK_FAILED",
    errorMessage: "password=audit-secret https://user:pass@example.test/repo", hookChangedPaths: ["safe.txt"],
  });
  const file = join(paths.audit, "2026-07-19.jsonl");
  const contents = await readFile(file, "utf8");
  assert.ok(Buffer.byteLength(contents) < 8192);
  assert.doesNotMatch(contents, /audit-secret|user:pass/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(contents)).sort(), [
    "durationMs", "errorCode", "errorMessage", "hookChangedPaths", "operation", "repositoryId", "requestId", "status", "timestamp",
  ]);
  await assert.rejects(audit.append({
    timestamp, requestId: "audit-2", operation: "git_commit", repositoryId,
    status: "failed", durationMs: 1, errorMessage: "x".repeat(8192),
  }), /8192/);
  await assert.rejects(audit.append({
    timestamp: "2026-07-19", requestId: "audit-3", operation: "git_commit", repositoryId,
    status: "failed", durationMs: 1,
  }), /timestamp/);
  const outside = join(paths.root, "outside-audit");
  await writeFile(outside, "sentinel\n", { mode: 0o600 });
  await symlink(outside, join(paths.audit, "2026-07-20.jsonl"));
  await assert.rejects(audit.append({
    timestamp: "2026-07-20T01:02:03.000Z", requestId: "audit-4", operation: "git_commit", repositoryId,
    status: "succeeded", durationMs: 1,
  }));
  assert.equal(await readFile(outside, "utf8"), "sentinel\n");
});

test("20 compiled Node processes append exactly 20 independently parseable audit lines", async (t) => {
  const paths = await temporaryState(t);
  const moduleUrl = pathToFileURL(join(process.cwd(), ".test-dist", "src", "state", "audit.js")).href;
  const script = [
    `import { AuditLog } from ${JSON.stringify(moduleUrl)};`,
    "const audit = process.argv[1]; const i = process.argv[2];",
    "const paths = { root:audit, locks:audit, repositories:audit, operations:audit, stages:audit, fetches:audit, merges:audit, audit };",
    `await new AuditLog(paths).append({ timestamp:${JSON.stringify(timestamp)}, requestId:'process-'+i, operation:'git_commit', repositoryId:${JSON.stringify(repositoryId)}, status:'succeeded', durationMs:Number(i) });`,
  ].join("\n");
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, paths.audit, String(index)])));
  const lines = (await readFile(join(paths.audit, "2026-07-19.jsonl"), "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 20);
  assert.equal(new Set(lines.map((line) => JSON.parse(line).requestId)).size, 20);
  assert.ok(lines.every((line) => Buffer.byteLength(`${line}\n`) < 8192));
});
