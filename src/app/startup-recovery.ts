import type { OperationResultRecord } from "../state/records.js";
import type { OperationJournal, RecoveryCandidate } from "../state/journal.js";
import type { RepositoryLock } from "../state/repository-lock.js";

export type StartupRecoveryResult =
  | { readonly kind: "recovered" | "terminal"; readonly requestId: string; readonly result: OperationResultRecord; readonly warning?: string }
  | { readonly kind: "deferred" | "corrupt"; readonly requestId: string; readonly error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recoverCandidate(
  candidate: Extract<RecoveryCandidate, { kind: "candidate" }>,
  journal: OperationJournal,
  lock: RepositoryLock,
): Promise<StartupRecoveryResult> {
  let handle;
  try {
    handle = await lock.acquire(candidate.repositoryId);
  } catch {
    return { kind: "deferred", requestId: candidate.requestId, error: "Repository lock was unavailable during startup recovery" };
  }

  let result: StartupRecoveryResult;
  try {
    result = await journal.recoverStarted(candidate.requestId);
  } catch (error) {
    result = { kind: "corrupt", requestId: candidate.requestId, error: message(error) };
  }
  try {
    await handle.release();
  } catch {
    if (result.kind === "recovered" || result.kind === "terminal") {
      return { ...result, warning: "Repository lock release failed after startup recovery" };
    }
    return { kind: "deferred", requestId: candidate.requestId, error: "Repository lock release failed during startup recovery" };
  }
  return result;
}

/** Recovers started-only operations only while holding each persisted repository identity's lock. */
export async function recoverStartedOperations(
  journal: OperationJournal,
  lock: RepositoryLock,
): Promise<readonly StartupRecoveryResult[]> {
  const candidates = await journal.findRecoveryCandidates();
  const results: StartupRecoveryResult[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "corrupt") {
      results.push(candidate);
      continue;
    }
    results.push(await recoverCandidate(candidate, journal, lock));
  }
  return results;
}
