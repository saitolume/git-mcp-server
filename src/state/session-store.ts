import { createHash } from "node:crypto";
import { join } from "node:path";
import { BridgeRejection } from "../domain/result.js";
import { atomicCreateJson, atomicWriteJson, canonicalStringify, durableUnlink, readJson } from "./atomic-json.js";
import type { StatePaths } from "./paths.js";
import {
  validateFetchRecord, validateMergeRecord, validateRepositoryId, validateSafeId, validateStageRecord,
  type FetchRecord, type MergeRecord, type StageRecord,
} from "./records.js";

export interface SessionActivityRecord {
  readonly kind: "session-activity";
  readonly repositoryId: string;
  readonly sessionKind: "stage" | "merge";
  readonly sessionId: string;
}

export interface SessionStoreOptions {
  readonly afterStageRecordUnlink?: () => Promise<void>;
  readonly onStageCleanupStep?: (
    step: "record-unlinked" | "record-directory-synced" | "marker-unlinked" | "marker-directory-synced",
  ) => void | Promise<void>;
  readonly afterMergeRecordUnlink?: () => Promise<void>;
  readonly onMergeCleanupStep?: (
    step: "record-unlinked" | "record-directory-synced" | "marker-unlinked" | "marker-directory-synced",
  ) => void | Promise<void>;
}

export interface StageCleanupIdentity {
  readonly repositoryId: string;
  readonly stageId: string;
  readonly recordHash: string;
}

export interface MergeCleanupIdentity {
  readonly repositoryId: string;
  readonly mergeSessionId: string;
  readonly recordHash: string;
}

export function stageRecordHash(record: StageRecord): string {
  const valid = validateStageRecord(record);
  const canonicalRecord = { ...valid, ownedPaths: [...valid.ownedPaths] };
  return createHash("sha256").update("stage-record\0").update(canonicalStringify(canonicalRecord)).digest("hex");
}

export function mergeRecordHash(record: MergeRecord): string {
  const valid = validateMergeRecord(record);
  const canonicalRecord = { ...valid, conflictedPaths: [...valid.conflictedPaths], resolvedPaths: [...valid.resolvedPaths] };
  return createHash("sha256").update("merge-record\0").update(canonicalStringify(canonicalRecord)).digest("hex");
}

function validateActivity(value: unknown, expectedRepositoryId: string): SessionActivityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Session activity marker is corrupt");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["kind", "repositoryId", "sessionId", "sessionKind"].sort().join("\0")
    || record.kind !== "session-activity" || record.repositoryId !== expectedRepositoryId
    || (record.sessionKind !== "stage" && record.sessionKind !== "merge")) {
    throw new Error("Session activity marker is corrupt");
  }
  validateRepositoryId(record.repositoryId);
  validateSafeId(record.sessionId, "Session ID");
  return record as unknown as SessionActivityRecord;
}

function sessionRejection(message: string, details: Readonly<Record<string, unknown>>): BridgeRejection {
  return new BridgeRejection({ code: "SESSION_MISMATCH", message, details });
}

export class SessionStore {
  constructor(private readonly paths: StatePaths, private readonly options: SessionStoreOptions = {}) {}

  async putStage(record: StageRecord): Promise<void> { const valid = validateStageRecord(record); await atomicWriteJson(this.stagePath(valid.stageId), valid); }
  async getStage(id: string): Promise<StageRecord | null> { const safe = validateSafeId(id, "Stage ID"); const value = await readJson(this.stagePath(safe)); return value === null ? null : validateStageRecord(value, safe); }
  async deleteStage(id: string): Promise<void> { await this.deleteExact(this.stagePath(validateSafeId(id, "Stage ID"))); }

  async putFetch(record: FetchRecord): Promise<void> { await this.createFetch(record); }
  /** Publishes a fetch record once and never replaces an existing fetch ID. */
  async createFetch(record: FetchRecord): Promise<void> { const valid = validateFetchRecord(record); await atomicCreateJson(this.fetchPath(valid.fetchId), valid); }
  async getFetch(id: string): Promise<FetchRecord | null> { const safe = validateSafeId(id, "Fetch ID"); const value = await readJson(this.fetchPath(safe)); return value === null ? null : validateFetchRecord(value, safe); }
  async deleteFetch(id: string): Promise<void> { await this.deleteExact(this.fetchPath(validateSafeId(id, "Fetch ID"))); }

  async putMerge(record: MergeRecord): Promise<void> { await this.createMerge(record); }
  async createMerge(record: MergeRecord): Promise<void> { const valid = validateMergeRecord(record); await atomicCreateJson(this.mergePath(valid.mergeSessionId), valid); }
  async getMerge(id: string): Promise<MergeRecord | null> { const safe = validateSafeId(id, "Merge ID"); const value = await readJson(this.mergePath(safe)); return value === null ? null : validateMergeRecord(value, safe); }
  async deleteMerge(id: string): Promise<void> { await this.deleteExact(this.mergePath(validateSafeId(id, "Merge ID"))); }

  async assertActiveMerge(record: MergeRecord): Promise<void> {
    const valid = validateMergeRecord(record);
    const active = await this.getActiveSession(valid.repositoryId);
    if (active === null || active.sessionKind !== "merge" || active.sessionId !== valid.mergeSessionId) {
      throw sessionRejection("Merge session is not the repository's active session", { repositoryId: valid.repositoryId, mergeSessionId: valid.mergeSessionId });
    }
  }

  async createMergeSession(record: MergeRecord): Promise<void> {
    const valid = validateMergeRecord(record);
    const activity: SessionActivityRecord = { kind: "session-activity", repositoryId: valid.repositoryId, sessionKind: "merge", sessionId: valid.mergeSessionId };
    let createdMarker = false;
    try { await atomicCreateJson(this.activityPath(valid.repositoryId), activity); createdMarker = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const active = await this.getActiveSession(valid.repositoryId);
      if (active?.sessionKind !== "merge" || active.sessionId !== valid.mergeSessionId || await this.getMerge(valid.mergeSessionId) !== null) {
        throw sessionRejection("Repository already has an active bridge session", { repositoryId: valid.repositoryId });
      }
    }
    try { await atomicCreateJson(this.mergePath(valid.mergeSessionId), valid); }
    catch (error) { if (createdMarker) await this.deleteActivityIfExact(activity).catch(() => undefined); throw error; }
  }

  async updateMergeSession(record: MergeRecord, expectedRecordHash: string): Promise<void> {
    const valid = validateMergeRecord(record);
    if (!/^[0-9a-f]{64}$/.test(expectedRecordHash)) throw new TypeError("Merge record hash must be a SHA-256 value");
    await this.assertActiveMerge(valid);
    const current = await this.getMerge(valid.mergeSessionId);
    if (current === null || current.repositoryId !== valid.repositoryId || mergeRecordHash(current) !== expectedRecordHash) {
      throw sessionRejection("Merge record changed before exact session update", { repositoryId: valid.repositoryId, mergeSessionId: valid.mergeSessionId });
    }
    await atomicWriteJson(this.mergePath(valid.mergeSessionId), valid);
  }

  async deleteMergeSessionByIdentity(identity: MergeCleanupIdentity): Promise<void> {
    const repositoryId = validateRepositoryId(identity.repositoryId);
    const mergeSessionId = validateSafeId(identity.mergeSessionId, "Merge ID");
    if (!/^[0-9a-f]{64}$/.test(identity.recordHash)) throw new TypeError("Merge record hash must be a SHA-256 value");
    const active = await this.getActiveSession(repositoryId);
    const current = await this.getMerge(mergeSessionId);
    if (active === null) {
      if (current === null) return;
      throw sessionRejection("Merge record exists without its repository activity marker", { repositoryId, mergeSessionId });
    }
    if (active.sessionKind !== "merge" || active.sessionId !== mergeSessionId) {
      throw sessionRejection("Another session owns the repository activity marker", { repositoryId, mergeSessionId, activeSessionKind: active.sessionKind, activeSessionId: active.sessionId });
    }
    if (current === null) { await this.deleteActivityIfExact(active, true, "merge"); return; }
    if (mergeRecordHash(current) !== identity.recordHash) {
      throw sessionRejection("Merge record changed before exact session deletion", { repositoryId, mergeSessionId });
    }
    await durableUnlink(this.mergePath(mergeSessionId), async (step) => {
      await this.options.onMergeCleanupStep?.(step === "unlinked" ? "record-unlinked" : "record-directory-synced");
    });
    await this.options.afterMergeRecordUnlink?.();
    await this.deleteActivityIfExact(active, true, "merge");
  }

  async assertNoActiveSession(repositoryId: string): Promise<void> {
    const active = await this.getActiveSession(repositoryId);
    if (active !== null) {
      throw sessionRejection("Repository already has an active bridge session", {
        repositoryId, sessionKind: active.sessionKind, sessionId: active.sessionId,
      });
    }
  }

  async assertActiveStage(record: StageRecord): Promise<void> {
    const valid = validateStageRecord(record);
    const active = await this.getActiveSession(valid.repositoryId);
    if (active === null || active.sessionKind !== "stage" || active.sessionId !== valid.stageId) {
      throw sessionRejection("Stage session is not the repository's active session", {
        repositoryId: valid.repositoryId, stageId: valid.stageId,
      });
    }
  }

  async createStageSession(record: StageRecord): Promise<void> {
    const valid = validateStageRecord(record);
    const activity: SessionActivityRecord = {
      kind: "session-activity", repositoryId: valid.repositoryId, sessionKind: "stage", sessionId: valid.stageId,
    };
    try {
      await atomicCreateJson(this.activityPath(valid.repositoryId), activity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await this.getActiveSession(valid.repositoryId);
        throw sessionRejection("Repository already has an active bridge session", { repositoryId: valid.repositoryId });
      }
      throw error;
    }
    try {
      await atomicCreateJson(this.stagePath(valid.stageId), valid);
    } catch (error) {
      await this.deleteActivityIfExact(activity).catch(() => undefined);
      throw error;
    }
  }

  async updateStageSession(record: StageRecord): Promise<void> {
    const valid = validateStageRecord(record);
    await this.assertActiveStage(valid);
    const current = await this.getStage(valid.stageId);
    if (current === null || current.repositoryId !== valid.repositoryId) {
      throw sessionRejection("Stage record is missing or belongs to another repository", {
        repositoryId: valid.repositoryId, stageId: valid.stageId,
      });
    }
    await atomicWriteJson(this.stagePath(valid.stageId), valid);
  }

  async deleteStageSession(record: StageRecord): Promise<void> {
    const valid = validateStageRecord(record);
    await this.deleteStageSessionByIdentity({
      repositoryId: valid.repositoryId, stageId: valid.stageId, recordHash: stageRecordHash(valid),
    });
  }

  async deleteStageSessionByIdentity(identity: StageCleanupIdentity): Promise<void> {
    const repositoryId = validateRepositoryId(identity.repositoryId);
    const stageId = validateSafeId(identity.stageId, "Stage ID");
    if (!/^[0-9a-f]{64}$/.test(identity.recordHash)) throw new TypeError("Stage record hash must be a SHA-256 value");
    const active = await this.getActiveSession(repositoryId);
    const current = await this.getStage(stageId);
    if (active === null) {
      if (current === null) return;
      throw sessionRejection("Stage record exists without its repository activity marker", {
        repositoryId, stageId,
      });
    }
    if (active.sessionKind !== "stage" || active.sessionId !== stageId) {
      throw sessionRejection("Another session owns the repository activity marker", {
        repositoryId, stageId,
        activeSessionKind: active.sessionKind, activeSessionId: active.sessionId,
      });
    }
    if (current === null) {
      await this.deleteActivityIfExact(active, true);
      return;
    }
    if (stageRecordHash(current) !== identity.recordHash) {
      throw sessionRejection("Stage record changed before exact session deletion", {
        repositoryId, stageId,
      });
    }
    await durableUnlink(this.stagePath(stageId), async (step) => {
      await this.options.onStageCleanupStep?.(step === "unlinked" ? "record-unlinked" : "record-directory-synced");
    });
    await this.options.afterStageRecordUnlink?.();
    await this.deleteActivityIfExact(active, true);
  }

  async getActiveSession(repositoryId: string): Promise<SessionActivityRecord | null> {
    const validRepositoryId = validateRepositoryId(repositoryId);
    const value = await readJson(this.activityPath(validRepositoryId));
    return value === null ? null : validateActivity(value, validRepositoryId);
  }

  private stagePath(id: string): string { return join(this.paths.stages, `${id}.json`); }
  private fetchPath(id: string): string { return join(this.paths.fetches, `${id}.json`); }
  private mergePath(id: string): string { return join(this.paths.merges, `${id}.json`); }
  private activityPath(repositoryId: string): string { return join(this.paths.stages, `.active-${repositoryId}.json`); }
  private async deleteActivityIfExact(expected: SessionActivityRecord, reportCleanup = false, cleanupKind: "stage" | "merge" = "stage"): Promise<void> {
    const active = await this.getActiveSession(expected.repositoryId);
    if (active === null || active.sessionKind !== expected.sessionKind || active.sessionId !== expected.sessionId) {
      throw sessionRejection("Session activity marker changed before deletion", {
        repositoryId: expected.repositoryId, sessionKind: expected.sessionKind, sessionId: expected.sessionId,
      });
    }
    await durableUnlink(this.activityPath(expected.repositoryId), async (step) => {
      if (reportCleanup) {
        const event = step === "unlinked" ? "marker-unlinked" : "marker-directory-synced";
        if (cleanupKind === "stage") await this.options.onStageCleanupStep?.(event);
        else await this.options.onMergeCleanupStep?.(event);
      }
    });
  }
  private async deleteExact(path: string): Promise<void> {
    try { await durableUnlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
