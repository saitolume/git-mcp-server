import { randomUUID } from "node:crypto";
import { deadlineSignal } from "../deadline.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BridgeRejection } from "../domain/result.js";
import { atomicCreateJson, atomicWriteJson, readJson } from "./atomic-json.js";
import type { StatePaths } from "./paths.js";
import { validateRepositoryId, validateTimestamp } from "./records.js";

export interface LockOwner {
  pid: number;
  nonce: string;
  repositoryId: string;
  createdAt: string;
  heartbeatAt: string;
}

export interface LockHandle {
  owner: LockOwner;
  release(): Promise<void>;
}

export interface RepositoryLockOptions {
  now?: () => string;
  monotonicNow?: () => number;
  pid?: number;
  randomUUID?: () => string;
  isPidAlive?: (pid: number) => boolean;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
  initializationGraceMs?: number;
  onDirectoryCreated?: () => void | Promise<void>;
  onStaleOwnerValidated?: (owner: LockOwner) => void | Promise<void>;
  onReleaseOwnerValidated?: (owner: LockOwner) => void | Promise<void>;
  onOwnerPublished?: (owner: LockOwner) => void | Promise<void>;
  onTransitionRemoved?: () => void | Promise<void>;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

interface OwnerObservation {
  readonly identity: DirectoryIdentity;
  readonly owner: LockOwner | null;
}

type TransitionOutcome = "held" | "removed" | "released" | "unknown";

interface TransitionHandle {
  readonly outcome: TransitionOutcome;
  release(): Promise<void>;
}

interface PendingLock {
  readonly handle: LockHandle;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_INITIALIZATION_GRACE_MS = 1_000;

function numericOption(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RangeError(`${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

function existsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function ownerChangedDuringRead(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("JSON file changed while opening:");
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function defaultPidLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function abortError(): Error {
  const error = new Error("Lock acquisition was aborted");
  error.name = "AbortError";
  return error;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateOwner(value: unknown, expectedRepositoryId: string): LockOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Lock owner must be an object");
  }
  const owner = value as Record<string, unknown>;
  const expectedKeys = ["createdAt", "heartbeatAt", "nonce", "pid", "repositoryId"];
  if (Object.keys(owner).sort().join("\0") !== expectedKeys.join("\0")) throw new TypeError("Lock owner has invalid keys");
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) throw new TypeError("Lock owner PID is invalid");
  if (typeof owner.nonce !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner.nonce)) {
    throw new TypeError("Lock owner nonce is invalid");
  }
  const repositoryId = validateRepositoryId(owner.repositoryId);
  if (repositoryId !== expectedRepositoryId) throw new TypeError("Lock owner repository ID does not match its path");
  validateTimestamp(owner.createdAt, "createdAt");
  validateTimestamp(owner.heartbeatAt, "heartbeatAt");
  return owner as unknown as LockOwner;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function inspectDirectory(path: string, label: string): Promise<DirectoryIdentity> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error(`${label} is not owned by this user`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const details = await handle.stat();
    if (!details.isDirectory() || details.dev !== before.dev || details.ino !== before.ino) throw new Error(`${label} changed while opening`);
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) throw new Error(`${label} is not owned by this user`);
    await handle.chmod(0o700);
    return { dev: details.dev, ino: details.ino, mtimeMs: details.mtimeMs };
  } finally {
    await handle.close();
  }
}

export class RepositoryLock {
  private readonly now: () => string;
  private readonly monotonicNow: () => number;
  private readonly pid: number;
  private readonly makeNonce: () => string;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly retryIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly initializationGraceMs: number;
  private readonly onDirectoryCreated: () => void | Promise<void>;
  private readonly onStaleOwnerValidated: (owner: LockOwner) => void | Promise<void>;
  private readonly onReleaseOwnerValidated: (owner: LockOwner) => void | Promise<void>;
  private readonly onOwnerPublished: (owner: LockOwner) => void | Promise<void>;
  private readonly onTransitionRemoved: () => void | Promise<void>;

  constructor(private readonly paths: StatePaths, options: RepositoryLockOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.monotonicNow = options.monotonicNow ?? Date.now;
    this.pid = numericOption(options.pid ?? process.pid, "pid");
    this.makeNonce = options.randomUUID ?? randomUUID;
    this.isPidAlive = options.isPidAlive ?? defaultPidLiveness;
    this.heartbeatIntervalMs = numericOption(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, "heartbeatIntervalMs");
    this.staleAfterMs = numericOption(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS, "staleAfterMs");
    this.retryIntervalMs = numericOption(options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS, "retryIntervalMs");
    this.maxWaitMs = numericOption(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS, "maxWaitMs", true);
    this.initializationGraceMs = numericOption(options.initializationGraceMs ?? DEFAULT_INITIALIZATION_GRACE_MS, "initializationGraceMs");
    this.onDirectoryCreated = options.onDirectoryCreated ?? (() => undefined);
    this.onStaleOwnerValidated = options.onStaleOwnerValidated ?? (() => undefined);
    this.onReleaseOwnerValidated = options.onReleaseOwnerValidated ?? (() => undefined);
    this.onOwnerPublished = options.onOwnerPublished ?? (() => undefined);
    this.onTransitionRemoved = options.onTransitionRemoved ?? (() => undefined);
  }

  async acquire(repositoryIdValue: string, signal?: AbortSignal): Promise<LockHandle> {
    signal = deadlineSignal(signal);
    const repositoryId = validateRepositoryId(repositoryIdValue);
    const lockPath = join(this.paths.locks, `${repositoryId}.lock`);
    const deadline = this.monotonicNow() + this.maxWaitMs;
    let attempted = false;
    while (true) {
      if (signal?.aborted) throw abortError();
      if (attempted && this.monotonicNow() >= deadline) throw this.timeout(repositoryId);
      attempted = true;
      const transition = await this.acquireTransition(repositoryId, deadline, signal);
      let pendingOwnsTransition = false;
      let shouldWait = false;
      try {
        if (signal?.aborted) throw abortError();
        let created = false;
        try { await mkdir(lockPath, { mode: 0o700 }); created = true; }
        catch (error) { if (!existsError(error)) throw error; }
        if (created) {
          const identity = await inspectDirectory(lockPath, `Repository lock path: ${repositoryId}`);
          const pending = await this.finishAcquisition(lockPath, repositoryId, identity);
          pendingOwnsTransition = true;
          return await this.publishAcquisition(pending, transition, repositoryId);
        }

        let observation: OwnerObservation | undefined;
        try { observation = await this.readOwner(lockPath, repositoryId, true); }
        catch (error) {
          if (!ownerChangedDuringRead(error)) throw error;
          shouldWait = true;
        }
        if (observation === undefined) {
          // An atomic heartbeat replacement raced the read; retry outside the transition guard.
        } else if (observation.owner === null) {
          shouldWait = true;
        } else if (!this.isPidAlive(observation.owner.pid) && this.isExpired(observation.owner)) {
          await this.onStaleOwnerValidated({ ...observation.owner });
          const latest = await this.readOwner(lockPath, repositoryId);
          if (latest.owner === null || !sameIdentity(latest.identity, observation.identity)
            || latest.owner.nonce !== observation.owner.nonce) {
            throw new Error(`Repository lock changed before stale recovery: ${repositoryId}`);
          }
          await rename(lockPath, `${lockPath}.stale-${this.makeNonce()}`);
          await syncDirectory(this.paths.locks);
          await mkdir(lockPath, { mode: 0o700 });
          const identity = await inspectDirectory(lockPath, `Repository lock path: ${repositoryId}`);
          const pending = await this.finishAcquisition(lockPath, repositoryId, identity);
          pendingOwnsTransition = true;
          return await this.publishAcquisition(pending, transition, repositoryId);
        } else {
          shouldWait = true;
        }
      } finally {
        if (!pendingOwnsTransition) await transition.release();
      }
      if (shouldWait) await this.waitForRetry(deadline, repositoryId, signal);
    }
  }

  private async finishAcquisition(
    lockPath: string,
    repositoryId: string,
    identity: DirectoryIdentity,
  ): Promise<PendingLock> {
    const createdAt = this.now();
    validateTimestamp(createdAt, "createdAt");
    const owner: LockOwner = {
      pid: this.pid,
      nonce: this.makeNonce(),
      repositoryId,
      createdAt,
      heartbeatAt: createdAt,
    };
    validateOwner(owner, repositoryId);
    try {
      await this.onDirectoryCreated();
      await atomicCreateJson(join(lockPath, "owner.json"), owner);
      await this.onOwnerPublished({ ...owner });
      await syncDirectory(this.paths.locks);
    } catch (publicationError) {
      try {
        await this.cleanupOwnedDirectory(lockPath, repositoryId, identity, owner.nonce, true);
      } catch (cleanupError) {
        throw new AggregateError([publicationError, cleanupError], "Lock publication failed and exact cleanup could not be proven");
      }
      throw publicationError;
    }

    let active = true;
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(async () => {
        if (!active) return;
        const stored = await this.readOwner(lockPath, repositoryId);
        if (stored.owner === null || !sameIdentity(stored.identity, identity) || stored.owner.nonce !== owner.nonce || !active) return;
        const heartbeatAt = this.now();
        validateTimestamp(heartbeatAt, "heartbeatAt");
        owner.heartbeatAt = heartbeatAt;
        if (!active) return;
        await atomicWriteJson(join(lockPath, "owner.json"), owner);
      }).catch(() => undefined);
    }, this.heartbeatIntervalMs);
    timer.unref();

    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        active = false;
        clearInterval(timer);
        await heartbeat;
      })();
      return stopPromise;
    };
    const cleanup = async (): Promise<void> => {
      await this.cleanupOwnedDirectory(lockPath, repositoryId, identity, owner.nonce, false);
    };
    let releasePromise: Promise<void> | undefined;
    const release = (): Promise<void> => {
      releasePromise ??= (async () => {
        await stop();
        const deadline = this.monotonicNow() + this.maxWaitMs;
        const transition = await this.acquireTransition(repositoryId, deadline);
        try {
          await this.cleanupOwnedDirectory(
            lockPath,
            repositoryId,
            identity,
            owner.nonce,
            false,
            this.onReleaseOwnerValidated,
          );
        } finally {
          await transition.release();
        }
      })();
      return releasePromise;
    };

    return { handle: { owner: { ...owner }, release }, stop, cleanup };
  }

  private async publishAcquisition(
    pending: PendingLock,
    transition: TransitionHandle,
    repositoryId: string,
  ): Promise<LockHandle> {
    try {
      await transition.release();
      return pending.handle;
    } catch (releaseError) {
      const failures: unknown[] = [releaseError];
      await pending.stop().catch((error: unknown) => failures.push(error));
      let authority: TransitionHandle | undefined;
      try {
        authority = transition.outcome === "held"
          ? transition
          : await this.acquireTransition(repositoryId, this.monotonicNow() + this.maxWaitMs);
        await pending.cleanup();
      } catch (error) {
        failures.push(error);
      } finally {
        if (authority !== undefined) {
          await authority.release().catch((error: unknown) => failures.push(error));
        }
      }
      if (failures.length === 1) throw releaseError;
      throw new AggregateError(failures, "Transition release failed while publishing the repository lock");
    }
  }

  private async acquireTransition(repositoryId: string, deadline: number, signal?: AbortSignal): Promise<TransitionHandle> {
    const transitionPath = join(this.paths.locks, `${repositoryId}.transition`);
    let attempted = false;
    while (true) {
      if (signal?.aborted) throw abortError();
      if (attempted && this.monotonicNow() >= deadline) throw this.timeout(repositoryId);
      attempted = true;
      try {
        await mkdir(transitionPath, { mode: 0o700 });
        const identity = await inspectDirectory(transitionPath, `Repository transition guard: ${repositoryId}`);
        try { await syncDirectory(this.paths.locks); }
        catch (error) {
          const latest = await inspectDirectory(transitionPath, `Repository transition guard: ${repositoryId}`);
          if (sameIdentity(latest, identity)) await rmdir(transitionPath);
          throw error;
        }
        let outcome: TransitionOutcome = "held";
        return {
          get outcome() { return outcome; },
          release: async () => {
            if (outcome === "released") return;
            if (outcome !== "held") throw new Error(`Repository transition guard authority was already removed: ${repositoryId}`);
            let latest: DirectoryIdentity;
            try { latest = await inspectDirectory(transitionPath, `Repository transition guard: ${repositoryId}`); }
            catch (error) { outcome = "unknown"; throw error; }
            if (!sameIdentity(latest, identity)) {
              outcome = "unknown";
              throw new Error(`Repository transition guard changed: ${repositoryId}`);
            }
            try { await rmdir(transitionPath); }
            catch (error) {
              try {
                latest = await inspectDirectory(transitionPath, `Repository transition guard: ${repositoryId}`);
                outcome = sameIdentity(latest, identity) ? "held" : "unknown";
              } catch {
                outcome = "unknown";
              }
              throw error;
            }
            outcome = "removed";
            await this.onTransitionRemoved();
            await syncDirectory(this.paths.locks);
            outcome = "released";
          },
        };
      } catch (error) {
        if (!existsError(error)) throw error;
      }
      await this.waitForRetry(deadline, repositoryId, signal);
    }
  }

  private async readOwner(lockPath: string, repositoryId: string, allowInitializing = false): Promise<OwnerObservation> {
    const identity = await inspectDirectory(lockPath, `Repository lock path: ${repositoryId}`);
    const value = await readJson(join(lockPath, "owner.json"), { maxBytes: 4096 });
    if (value === null) {
      if (allowInitializing && Date.now() - identity.mtimeMs <= this.initializationGraceMs) return { identity, owner: null };
      throw new Error(`Repository lock owner is missing: ${repositoryId}`);
    }
    return { identity, owner: validateOwner(value, repositoryId) };
  }

  private async cleanupOwnedDirectory(
    lockPath: string,
    repositoryId: string,
    expectedIdentity: DirectoryIdentity,
    expectedNonce: string,
    allowMissingOwner: boolean,
    afterValidated: (owner: LockOwner) => void | Promise<void> = () => undefined,
  ): Promise<void> {
    const observation = await this.readOwner(lockPath, repositoryId).catch(async (error: unknown) => {
      if (!allowMissingOwner || !(error instanceof Error) || !error.message.includes("owner is missing")) throw error;
      return { identity: await inspectDirectory(lockPath, `Repository lock path: ${repositoryId}`), owner: null };
    });
    if (!sameIdentity(observation.identity, expectedIdentity)) throw new Error(`Repository lock directory identity changed: ${repositoryId}`);
    if (observation.owner !== null && observation.owner.nonce !== expectedNonce) {
      throw new Error("Repository lock owner nonce does not match this handle");
    }
    if (observation.owner !== null) await afterValidated({ ...observation.owner });

    const latest = await this.readOwner(lockPath, repositoryId).catch(async (error: unknown) => {
      if (!allowMissingOwner || !(error instanceof Error) || !error.message.includes("owner is missing")) throw error;
      return { identity: await inspectDirectory(lockPath, `Repository lock path: ${repositoryId}`), owner: null };
    });
    if (!sameIdentity(latest.identity, expectedIdentity)) throw new Error(`Repository lock directory identity changed: ${repositoryId}`);
    if (latest.owner !== null && latest.owner.nonce !== expectedNonce) {
      throw new Error("Repository lock owner nonce does not match this handle");
    }
    if (latest.owner !== null) await unlink(join(lockPath, "owner.json"));
    const beforeRemove = await inspectDirectory(lockPath, `Repository lock path: ${repositoryId}`);
    if (!sameIdentity(beforeRemove, expectedIdentity)) throw new Error(`Repository lock directory identity changed: ${repositoryId}`);
    await rmdir(lockPath);
    await syncDirectory(this.paths.locks);
  }

  private isExpired(owner: LockOwner): boolean {
    return Date.parse(this.now()) - Date.parse(owner.heartbeatAt) >= this.staleAfterMs;
  }

  private async waitForRetry(deadline: number, repositoryId: string, signal?: AbortSignal): Promise<void> {
    const remaining = deadline - this.monotonicNow();
    if (remaining <= 0) throw this.timeout(repositoryId);
    await abortableDelay(Math.min(this.retryIntervalMs, remaining), signal);
  }

  private timeout(repositoryId: string): BridgeRejection {
    return new BridgeRejection({ code: "LOCK_TIMEOUT", message: `Timed out waiting for repository lock: ${repositoryId}` });
  }
}
