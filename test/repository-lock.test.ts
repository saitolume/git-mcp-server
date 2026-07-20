import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withDeadline } from "../src/deadline.js";
import { mkdtemp } from "node:fs/promises";
import { BridgeRejection } from "../src/domain/result.js";
import { atomicWriteJson } from "../src/state/atomic-json.js";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../src/state/paths.js";
import { RepositoryLock } from "../src/state/repository-lock.js";

const repositoryId = "a".repeat(64);
const otherRepositoryId = "b".repeat(64);

async function temporaryState(t: test.TestContext): Promise<StatePaths> {
  const home = await mkdtemp(join(tmpdir(), "git-mcp-server-lock-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  return initializeStatePaths(resolveStatePaths({ platform: "linux", homedir: home, env: {} }));
}

function fastLock(paths: StatePaths, overrides: ConstructorParameters<typeof RepositoryLock>[1] = {}): RepositoryLock {
  return new RepositoryLock(paths, {
    heartbeatIntervalMs: 5,
    staleAfterMs: 100,
    retryIntervalMs: 2,
    maxWaitMs: 500,
    ...overrides,
  });
}

test("repository lock serializes concurrent owners until release", async (t) => {
  const paths = await temporaryState(t);
  const first = await fastLock(paths).acquire(repositoryId);
  let secondAcquired = false;
  const secondPromise = fastLock(paths).acquire(repositoryId).then((handle) => {
    secondAcquired = true;
    return handle;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondAcquired, false);

  await first.release();
  const second = await secondPromise;
  assert.notEqual(second.owner.nonce, first.owner.nonce);
  await second.release();
});

test("repository lock wait is bounded by the enclosing absolute operation deadline", async (t) => {
  const paths = await temporaryState(t);
  const owner = await fastLock(paths).acquire(repositoryId);
  const started = Date.now();

  await assert.rejects(withDeadline(30, undefined, (signal) =>
    fastLock(paths, { maxWaitMs: 5_000 }).acquire(repositoryId, signal)), /abort|deadline|timed out/i);

  assert.ok(Date.now() - started < 1_000);
  await owner.release();
});

test("repository lock waiter tolerates owner publication after atomic mkdir", async (t) => {
  const paths = await temporaryState(t);
  let publishOwner: (() => void) | undefined;
  const publicationGate = new Promise<void>((resolve) => { publishOwner = resolve; });
  let directoryCreated: (() => void) | undefined;
  const directoryCreatedGate = new Promise<void>((resolve) => { directoryCreated = resolve; });
  const firstPromise = fastLock(paths, {
    onDirectoryCreated: async () => { directoryCreated?.(); await publicationGate; },
  }).acquire(repositoryId);
  await directoryCreatedGate;

  let secondSettled = false;
  const secondPromise = fastLock(paths).acquire(repositoryId).finally(() => { secondSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondSettled, false);
  publishOwner?.();
  const first = await firstPromise;
  await first.release();
  const second = await secondPromise;
  await second.release();
});

test("repository lock release refuses an on-disk nonce mismatch", async (t) => {
  const paths = await temporaryState(t);
  const handle = await fastLock(paths, { heartbeatIntervalMs: 10_000 }).acquire(repositoryId);
  const ownerPath = join(paths.locks, `${repositoryId}.lock`, "owner.json");
  await atomicWriteJson(ownerPath, { ...handle.owner, nonce: "different-owner" });

  await assert.rejects(handle.release(), /nonce|owner/i);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).nonce, "different-owner");
});

test("repository lock handle metadata cannot mutate the private release authority", async (t) => {
  const paths = await temporaryState(t);
  const handle = await fastLock(paths).acquire(repositoryId);
  handle.owner.nonce = "caller-mutated";

  await handle.release();
  assert.deepEqual(await readdir(paths.locks), []);
});

test("repository lock never steals a live PID based only on heartbeat age", async (t) => {
  const paths = await temporaryState(t);
  const lockPath = join(paths.locks, `${repositoryId}.lock`);
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    pid: 4321,
    nonce: "live-owner",
    repositoryId,
    createdAt: "2020-01-01T00:00:00.000Z",
    heartbeatAt: "2020-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  const lock = fastLock(paths, { isPidAlive: () => true, maxWaitMs: 15 });

  await assert.rejects(lock.acquire(repositoryId), (error: unknown) =>
    error instanceof BridgeRejection && error.error.code === "LOCK_TIMEOUT");
  assert.deepEqual(await readdir(paths.locks), [`${repositoryId}.lock`]);
});

test("repository lock renames an expired dead owner before acquiring", async (t) => {
  const paths = await temporaryState(t);
  const lockPath = join(paths.locks, `${repositoryId}.lock`);
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    pid: 4321,
    nonce: "dead-owner",
    repositoryId,
    createdAt: "2020-01-01T00:00:00.000Z",
    heartbeatAt: "2020-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  const lock = fastLock(paths, { isPidAlive: () => false });

  const handle = await lock.acquire(repositoryId);
  const entries = await readdir(paths.locks);
  assert.ok(entries.includes(`${repositoryId}.lock`));
  assert.ok(entries.some((entry) => entry.startsWith(`${repositoryId}.lock.stale-`)));
  await handle.release();
});

test("stale recovery transition never renames a successor or overlaps owners", async (t) => {
  const paths = await temporaryState(t);
  const lockPath = join(paths.locks, `${repositoryId}.lock`);
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    pid: 4321,
    nonce: "dead-owner",
    repositoryId,
    createdAt: "2020-01-01T00:00:00.000Z",
    heartbeatAt: "2020-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  let resumeRecovery: (() => void) | undefined;
  const recoveryGate = new Promise<void>((resolve) => { resumeRecovery = resolve; });
  let staleValidated: (() => void) | undefined;
  const staleValidatedGate = new Promise<void>((resolve) => { staleValidated = resolve; });
  const firstPromise = fastLock(paths, {
    isPidAlive: (pid) => pid === process.pid,
    onStaleOwnerValidated: async () => { staleValidated?.(); await recoveryGate; },
  }).acquire(repositoryId);
  await staleValidatedGate;

  let secondAcquired = false;
  const secondPromise = fastLock(paths, { isPidAlive: (pid) => pid === process.pid }).acquire(repositoryId).then((handle) => {
    secondAcquired = true;
    return handle;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondAcquired, false);
  resumeRecovery?.();
  const first = await firstPromise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondAcquired, false);
  await first.release();
  const second = await secondPromise;
  await second.release();
});

test("concurrent release calls cannot delete a newly acquired successor", async (t) => {
  const paths = await temporaryState(t);
  let resumeRelease: (() => void) | undefined;
  const releaseGate = new Promise<void>((resolve) => { resumeRelease = resolve; });
  let releaseValidated: (() => void) | undefined;
  const releaseValidatedGate = new Promise<void>((resolve) => { releaseValidated = resolve; });
  let validationCalls = 0;
  const owner = await fastLock(paths, {
    heartbeatIntervalMs: 10_000,
    onReleaseOwnerValidated: async () => {
      validationCalls += 1;
      releaseValidated?.();
      await releaseGate;
    },
  }).acquire(repositoryId);
  const firstRelease = owner.release();
  await releaseValidatedGate;
  const secondRelease = owner.release();
  const successorPromise = fastLock(paths).acquire(repositoryId);
  resumeRelease?.();
  await Promise.all([firstRelease, secondRelease]);
  const successor = await successorPromise;

  const stored = JSON.parse(await readFile(join(paths.locks, `${repositoryId}.lock`, "owner.json"), "utf8"));
  assert.equal(validationCalls, 1);
  assert.equal(stored.nonce, successor.owner.nonce);
  await successor.release();
});

test("owner publication durability failure conditionally removes only the acquired lock", async (t) => {
  const paths = await temporaryState(t);
  let publications = 0;
  const lock = fastLock(paths, {
    onOwnerPublished: async () => {
      publications += 1;
      if (publications === 1) throw new Error("simulated durability failure");
    },
  });

  await assert.rejects(lock.acquire(repositoryId), /simulated durability failure/);
  assert.deepEqual(await readdir(paths.locks), []);
  const successor = await lock.acquire(repositoryId);
  await successor.release();
});

test("post-publication transition release failure rolls back the unreturned live owner", async (t) => {
  const paths = await temporaryState(t);
  let removals = 0;
  const lock = fastLock(paths, {
    onTransitionRemoved: async () => {
      removals += 1;
      if (removals === 1) throw new Error("simulated transition parent sync failure");
    },
  });

  await assert.rejects(lock.acquire(repositoryId), /simulated transition parent sync failure/);
  assert.deepEqual(await readdir(paths.locks), []);
  const successor = await lock.acquire(repositoryId);
  await successor.release();
});

test("repository lock fails closed on corrupt owner metadata", async (t) => {
  const paths = await temporaryState(t);
  const lockPath = join(paths.locks, `${repositoryId}.lock`);
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), "{not-json\n", { mode: 0o600 });

  await assert.rejects(fastLock(paths).acquire(repositoryId), /Malformed JSON|owner/i);
  assert.deepEqual(await readdir(paths.locks), [`${repositoryId}.lock`]);
});

test("aborted lock waiter does not remove the current owner", async (t) => {
  const paths = await temporaryState(t);
  const owner = await fastLock(paths).acquire(repositoryId);
  const controller = new AbortController();
  const waiter = fastLock(paths).acquire(repositoryId, controller.signal);
  controller.abort();

  await assert.rejects(waiter, (error: unknown) => error instanceof Error && error.name === "AbortError");
  const stored = JSON.parse(await readFile(join(paths.locks, `${repositoryId}.lock`, "owner.json"), "utf8"));
  assert.equal(stored.nonce, owner.owner.nonce);
  await owner.release();
});

test("repository locks are independent for distinct common git directories", async (t) => {
  const paths = await temporaryState(t);
  const first = await fastLock(paths).acquire(repositoryId);
  const second = await fastLock(paths).acquire(otherRepositoryId);
  await second.release();
  await first.release();
});
