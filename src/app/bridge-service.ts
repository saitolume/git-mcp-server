import { createHash } from "node:crypto";
import { isOperationDeadlineExceeded, throwIfDeadlineExceeded, withOperationDeadline } from "../deadline.js";
import type {
  GitOperationGetInput, GitAddInput, GitCommitInput, GitDiffInput, GitFetchInput,
  GitMergeAbortInput, GitMergeContinueInput, GitMergeInput, GitPushInput,
  GitRestoreStagedInput, GitRestoreWorktreeInput, GitStatusInput, GitSwitchAttachInput, GitSwitchCreateInput,
} from "../domain/inputs.js";
import {
  BridgeRejection, failure, success,
  type AddData, type BridgeResult, type CommitData, type DiffData, type FetchData,
  type MergeAbortData, type MergeContinueData, type MergeData, type PushData,
  type RestoreStagedData, type RestoreWorktreeData, type StatusData, type SwitchAttachData, type SwitchCreateData,
} from "../domain/result.js";
import {
  executePreparedSwitchAttach, prepareSwitchAttach, preparedSwitchAttachObservation,
  executePreparedSwitchCreate, prepareSwitchCreate, preparedSwitchCreateObservation,
  type PreparedSwitchAttach, type PreparedSwitchCreate,
} from "../git/branch.js";
import {
  createCommitAfterPersistCleanup, executePreparedCommit, prepareCommit, preparedCommitObservation,
  type CommitExecutionOutcome, type PreparedCommit,
} from "../git/commit.js";
import {
  createMergeAfterPersistCleanup, executePreparedAbort, executePreparedConflictAdd,
  executePreparedContinue, executePreparedMerge, prepareAbortMerge, prepareConflictAdd,
  prepareContinueMerge, prepareMergeFetchedRef, preparedActiveMergeObservation,
  preparedConflictAddObservation, preparedMergeObservation,
  type MergeAbortExecutionOutcome, type MergeContinueExecutionOutcome, type MergeExecutionOutcome,
  type PreparedConflictAdd, type PreparedMerge, type PreparedMergeAbort, type PreparedMergeContinue,
} from "../git/merge.js";
import { readDiff, readStatus } from "../git/read.js";
import {
  executePreparedFetch, executePreparedPush, prepareFetchOrigin, preparePushOrigin,
  preparedFetchObservation, preparedPushObservation,
  type PreparedFetch, type PreparedPush, type PushExecutionOutcome,
} from "../git/remote.js";
import { inspectRepository, resolveRepositoryIdentity, type RepositorySnapshot } from "../git/repository.js";
import { executePreparedWorktreeRestore, prepareWorktreeRestore, type PreparedWorktreeRestore } from "../git/restore.js";
import { GitRunner } from "../git/runner.js";
import {
  executePreparedAddPaths, executePreparedRestoreStaged, prepareAddPaths, prepareRestoreStaged,
  preparedAddObservation, preparedRestoreStagedObservation,
  type PreparedAddPaths, type PreparedRestoreStaged,
} from "../git/stage.js";
import { AuditLog } from "../state/audit.js";
import { canonicalStringify } from "../state/atomic-json.js";
import { OperationJournal } from "../state/journal.js";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../state/paths.js";
import { RepositoryLock } from "../state/repository-lock.js";
import { RepositoryRegistry } from "../state/repository-registry.js";
import { SessionStore } from "../state/session-store.js";
import type { OperationRequestRecord } from "../state/records.js";
import { resolveGitExecutable } from "../git/environment.js";
import {
  MutationCoordinator,
  TerminalResultUnavailable,
  type MutationCallbacks,
  type OperationProgress,
  type OperationProgressPhase,
} from "./mutation-coordinator.js";

export interface BridgeService {
  git_status(input: GitStatusInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<StatusData>>;
  git_diff(input: GitDiffInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<DiffData>>;
  git_switch_create(input: GitSwitchCreateInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<SwitchCreateData>>;
  git_switch_attach(input: GitSwitchAttachInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<SwitchAttachData>>;
  git_add(input: GitAddInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<AddData>>;
  git_restore_staged(input: GitRestoreStagedInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<RestoreStagedData>>;
  git_restore_worktree(input: GitRestoreWorktreeInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<RestoreWorktreeData>>;
  git_commit(input: GitCommitInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<CommitData>>;
  git_fetch(input: GitFetchInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<FetchData>>;
  git_merge(input: GitMergeInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<MergeData>>;
  git_merge_continue(input: GitMergeContinueInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<MergeContinueData>>;
  git_merge_abort(input: GitMergeAbortInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<MergeAbortData>>;
  git_push(input: GitPushInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<PushData>>;
  git_operation_get(input: GitOperationGetInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<unknown>>;
}

export interface BridgeRuntime {
  readonly service: BridgeService;
  readonly journal: OperationJournal;
  readonly lock: RepositoryLock;
}

export interface BridgeServiceDependencies {
  readonly runner: GitRunner;
  readonly lock: RepositoryLock;
  readonly journal: OperationJournal;
  readonly sessions: SessionStore;
  readonly coordinator: MutationCoordinator;
}

export function classifyOperationError<T>(operation: string, error: unknown): BridgeResult<T> {
  if (error instanceof BridgeRejection) {
    return { status: "rejected", operation, warnings: [], error: error.error };
  }
  if (isOperationDeadlineExceeded(error)) {
    return failure(operation, "failed", {
      code: "GIT_TIMEOUT",
      message: "The absolute operation deadline expired",
    });
  }
  return failure(operation, "failed", {
    code: "GIT_FAILED",
    message: "The Git operation failed before a terminal mutation result was available",
  });
}

function bindFailure<T>(result: BridgeResult<T>, requestId?: string, repositoryId?: string): BridgeResult<T> {
  return {
    ...result,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(repositoryId === undefined ? {} : { repository_id: repositoryId }),
  };
}

function requestRecord(operation: string, repositoryId: string, input: object & { request_id: string }): OperationRequestRecord {
  return {
    requestId: input.request_id,
    requestHash: createHash("sha256").update(canonicalStringify(input)).digest("hex"),
    operation,
    repositoryId,
    input,
    createdAt: new Date().toISOString(),
  };
}

function outputObservation(value: unknown): Readonly<Record<string, unknown>> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  return {};
}

function emitProgress(progress: OperationProgress | undefined, phase: OperationProgressPhase): void {
  try {
    const delivery = progress?.(phase);
    if (delivery !== undefined) void Promise.resolve(delivery).catch(() => undefined);
  }
  catch { /* Progress transport cannot alter the operation result. */ }
}

export class DefaultBridgeService implements BridgeService {
  constructor(private readonly dependencies: BridgeServiceDependencies) {}

  private async read<T>(
    operation: string,
    repository: string,
    execute: (snapshot: RepositorySnapshot) => Promise<T>,
    signal?: AbortSignal,
    progress?: OperationProgress,
  ): Promise<BridgeResult<T>> {
    return withOperationDeadline(operation, signal, async (deadlineSignal) => {
      let repositoryId: string | undefined;
      try {
        emitProgress(progress, "preflight");
        throwIfDeadlineExceeded(deadlineSignal);
        const selected = await resolveRepositoryIdentity(this.dependencies.runner, repository, deadlineSignal);
        repositoryId = selected.repositoryId;
        const handle = await this.dependencies.lock.acquire(repositoryId, deadlineSignal);
        try {
          const snapshot = await inspectRepository(this.dependencies.runner, selected.root, deadlineSignal);
          if (snapshot.repositoryId !== selected.repositoryId || snapshot.root !== selected.root
            || snapshot.gitDir !== selected.gitDir || snapshot.commonGitDir !== selected.commonGitDir) {
            throw new BridgeRejection({ code: "UNSUPPORTED_REPOSITORY_STATE", message: "Repository identity changed while acquiring the read lock" });
          }
          emitProgress(progress, "executing");
          throwIfDeadlineExceeded(deadlineSignal);
          const data = await execute(snapshot);
          emitProgress(progress, "postflight");
          return { ...success(operation, data), repository_id: snapshot.repositoryId };
        } finally {
          await handle.release();
        }
      } catch (error) {
        return bindFailure(classifyOperationError(operation, error), undefined, repositoryId);
      }
    });
  }

  private async mutate<T>(
    operation: string,
    input: object & { repository: string; request_id: string },
    callbacks: (repositoryId: string) => MutationCallbacks<T>,
    signal?: AbortSignal,
    progress?: OperationProgress,
  ): Promise<BridgeResult<T>> {
    return withOperationDeadline(operation, signal, async (deadlineSignal) => {
      let repositoryId: string | undefined;
      try {
        const selected = await resolveRepositoryIdentity(this.dependencies.runner, input.repository, deadlineSignal);
        repositoryId = selected.repositoryId;
        return await this.dependencies.coordinator.execute({
          request: requestRecord(operation, repositoryId, input),
          callbacks: callbacks(repositoryId),
          ...(progress === undefined ? {} : { progress }),
        }, deadlineSignal);
      } catch (error) {
        if (error instanceof TerminalResultUnavailable) throw error;
        return bindFailure(classifyOperationError(operation, error), input.request_id, repositoryId);
      }
    });
  }

  git_status(input: GitStatusInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<StatusData>> {
    return this.read("git_status", input.repository, (snapshot) => readStatus(this.dependencies.runner, snapshot, signal), signal, progress);
  }

  git_diff(input: GitDiffInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<DiffData>> {
    return this.read("git_diff", input.repository, (snapshot) => readDiff(this.dependencies.runner, snapshot, {
      mode: input.mode,
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      ...(input.max_bytes === undefined ? {} : { maxBytes: input.max_bytes }),
    }, signal), signal, progress);
  }

  git_switch_create(input: GitSwitchCreateInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<SwitchCreateData>> {
    return this.mutate("git_switch_create", input, () => {
      let prepared: PreparedSwitchCreate | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await prepareSwitchCreate(this.dependencies.runner, this.dependencies.sessions, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head, branch: input.branch,
          }, signal);
          return preparedSwitchCreateObservation(prepared);
        },
        mutate: async () => executePreparedSwitchCreate(this.dependencies.runner, prepared!, signal),
        postflight: async (value) => outputObservation(value),
        classify: (error) => classifyOperationError("git_switch_create", error),
      };
    }, signal, progress);
  }

  git_switch_attach(input: GitSwitchAttachInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<SwitchAttachData>> {
    return this.mutate("git_switch_attach", input, () => {
      let prepared: PreparedSwitchAttach | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await prepareSwitchAttach(this.dependencies.runner, this.dependencies.sessions, snapshot, {
            expectedBranch: input.expected_branch,
            expectedHead: input.expected_head,
            branch: input.branch,
            expectedBranchHead: input.expected_branch_head,
          }, signal);
          return preparedSwitchAttachObservation(prepared);
        },
        mutate: async () => executePreparedSwitchAttach(this.dependencies.runner, prepared!, signal),
        postflight: async (value) => outputObservation(value),
        classify: (error) => classifyOperationError("git_switch_attach", error),
      };
    }, signal, progress);
  }

  git_add(input: GitAddInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<AddData>> {
    return this.mutate("git_add", input, () => {
      let preparedStage: PreparedAddPaths | undefined;
      let preparedMerge: PreparedConflictAdd | undefined;
      return {
        preflight: async (snapshot) => {
          if (input.merge_session_id !== undefined) {
            preparedMerge = await prepareConflictAdd(this.dependencies.runner, this.dependencies.sessions, snapshot, {
              expectedBranch: input.expected_branch, expectedHead: input.expected_head,
              mergeSessionId: input.merge_session_id, paths: input.paths,
            }, signal);
            return preparedConflictAddObservation(preparedMerge);
          }
          preparedStage = await prepareAddPaths(this.dependencies.runner, this.dependencies.sessions, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head, paths: input.paths,
            ...(input.stage_id === undefined ? {} : { stageId: input.stage_id }),
          }, signal);
          return preparedAddObservation(preparedStage);
        },
        mutate: async () => preparedMerge === undefined
          ? executePreparedAddPaths(this.dependencies.runner, this.dependencies.sessions, preparedStage!, signal)
          : executePreparedConflictAdd(this.dependencies.runner, this.dependencies.sessions, preparedMerge, signal),
        postflight: async (value) => outputObservation(value),
        classify: (error) => classifyOperationError("git_add", error),
      };
    }, signal, progress);
  }

  git_restore_staged(input: GitRestoreStagedInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<RestoreStagedData>> {
    return this.mutate("git_restore_staged", input, () => {
      let prepared: PreparedRestoreStaged | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await prepareRestoreStaged(this.dependencies.runner, this.dependencies.sessions, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head,
            stageId: input.stage_id, paths: input.paths,
          }, signal);
          return preparedRestoreStagedObservation(prepared);
        },
        mutate: async () => executePreparedRestoreStaged(this.dependencies.runner, this.dependencies.sessions, prepared!, signal),
        postflight: async (value) => outputObservation(value),
        classify: (error) => classifyOperationError("git_restore_staged", error),
      };
    }, signal, progress);
  }

  git_restore_worktree(input: GitRestoreWorktreeInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<RestoreWorktreeData>> {
    return this.mutate("git_restore_worktree", input, () => {
      let prepared: PreparedWorktreeRestore | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await prepareWorktreeRestore(this.dependencies.runner, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head,
            worktreeSnapshotId: input.worktree_snapshot_id, paths: input.paths,
          }, signal);
          return { paths: [...prepared.paths], worktree_snapshot_id: input.worktree_snapshot_id };
        },
        mutate: async () => executePreparedWorktreeRestore(this.dependencies.runner, prepared!, signal),
        postflight: async (value) => outputObservation(value),
        classify: (error) => classifyOperationError("git_restore_worktree", error),
      };
    }, signal, progress);
  }

  git_commit(input: GitCommitInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<CommitData>> {
    return this.mutate("git_commit", input, (repositoryId) => {
      let prepared: PreparedCommit | undefined;
      let outcome: CommitExecutionOutcome | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await prepareCommit(this.dependencies.runner, this.dependencies.sessions, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head,
            stageId: input.stage_id, message: input.message,
          }, signal);
          return preparedCommitObservation(prepared);
        },
        mutate: async () => {
          outcome = await executePreparedCommit(this.dependencies.runner, prepared!, signal);
          return outcome.data;
        },
        postflight: async (value) => outputObservation(value),
        warnings: () => outcome?.warnings ?? [],
        classify: (error) => classifyOperationError("git_commit", error),
        afterPersist: createCommitAfterPersistCleanup(this.dependencies.sessions, {
          requestId: input.request_id, repositoryId, operation: "git_commit",
          stageId: input.stage_id, expectedBranch: input.expected_branch, expectedHead: input.expected_head,
        }),
      };
    }, signal, progress);
  }

  git_fetch(input: GitFetchInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<FetchData>> {
    return this.mutate("git_fetch", input, () => {
      let prepared: PreparedFetch | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await prepareFetchOrigin(this.dependencies.runner, this.dependencies.sessions, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head,
          }, signal);
          return preparedFetchObservation(prepared);
        },
        mutate: async () => executePreparedFetch(this.dependencies.runner, this.dependencies.sessions, prepared!, signal),
        postflight: async (value) => outputObservation(value),
        classify: (error) => classifyOperationError("git_fetch", error),
      };
    }, signal, progress);
  }

  git_merge(input: GitMergeInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<MergeData>> {
    return this.mutate("git_merge", input, () => {
      let prepared: PreparedMerge | undefined;
      let outcome: MergeExecutionOutcome | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await prepareMergeFetchedRef(this.dependencies.runner, this.dependencies.sessions, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head, fetchId: input.fetch_id,
            remoteRef: input.remote_ref, expectedRemoteObject: input.expected_remote_object,
          }, signal);
          return preparedMergeObservation(prepared);
        },
        mutate: async () => {
          outcome = await executePreparedMerge(this.dependencies.runner, this.dependencies.sessions, prepared!, signal);
          return outcome.data;
        },
        postflight: async (value) => outputObservation(value),
        warnings: () => outcome?.warnings ?? [],
        classify: (error) => classifyOperationError("git_merge", error),
      };
    }, signal, progress);
  }

  git_merge_continue(input: GitMergeContinueInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<MergeContinueData>> {
    return this.mergeSessionMutation("git_merge_continue", input, signal, progress);
  }

  git_merge_abort(input: GitMergeAbortInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<MergeAbortData>> {
    return this.mergeSessionMutation("git_merge_abort", input, signal, progress);
  }

  private mergeSessionMutation(
    operation: "git_merge_continue",
    input: GitMergeContinueInput,
    signal?: AbortSignal,
    progress?: OperationProgress,
  ): Promise<BridgeResult<MergeContinueData>>;
  private mergeSessionMutation(
    operation: "git_merge_abort",
    input: GitMergeAbortInput,
    signal?: AbortSignal,
    progress?: OperationProgress,
  ): Promise<BridgeResult<MergeAbortData>>;
  private mergeSessionMutation(
    operation: "git_merge_continue" | "git_merge_abort",
    input: GitMergeContinueInput | GitMergeAbortInput,
    signal?: AbortSignal,
    progress?: OperationProgress,
  ): Promise<BridgeResult<MergeContinueData | MergeAbortData>> {
    return this.mutate(operation, input, (repositoryId) => {
      let preparedContinue: PreparedMergeContinue | undefined;
      let preparedAbort: PreparedMergeAbort | undefined;
      let outcome: MergeContinueExecutionOutcome | MergeAbortExecutionOutcome | undefined;
      return {
        preflight: async (repository) => {
          const request = {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head,
            mergeSessionId: input.merge_session_id,
          };
          if (operation === "git_merge_continue") {
            preparedContinue = await prepareContinueMerge(this.dependencies.runner, this.dependencies.sessions, repository, request, signal);
            return preparedActiveMergeObservation(preparedContinue);
          }
          preparedAbort = await prepareAbortMerge(this.dependencies.runner, this.dependencies.sessions, repository, request, signal);
          return preparedActiveMergeObservation(preparedAbort);
        },
        mutate: async () => {
          outcome = operation === "git_merge_continue"
            ? await executePreparedContinue(this.dependencies.runner, preparedContinue!, signal)
            : await executePreparedAbort(this.dependencies.runner, preparedAbort!, signal);
          return outcome.data;
        },
        postflight: async (value) => outputObservation(value),
        warnings: () => outcome?.warnings ?? [],
        classify: (error) => classifyOperationError(operation, error),
        afterPersist: createMergeAfterPersistCleanup(this.dependencies.sessions, {
          requestId: input.request_id, repositoryId, operation,
          mergeSessionId: input.merge_session_id, expectedBranch: input.expected_branch, expectedHead: input.expected_head,
        }),
      };
    }, signal, progress);
  }

  git_push(input: GitPushInput, signal?: AbortSignal, progress?: OperationProgress): Promise<BridgeResult<PushData>> {
    return this.mutate("git_push", input, () => {
      let prepared: PreparedPush | undefined;
      let outcome: PushExecutionOutcome | undefined;
      return {
        preflight: async (snapshot) => {
          prepared = await preparePushOrigin(this.dependencies.runner, snapshot, {
            expectedBranch: input.expected_branch, expectedHead: input.expected_head,
            expectedRemoteHead: input.expected_remote_head,
          }, signal);
          return preparedPushObservation(prepared);
        },
        mutate: async () => {
          outcome = await executePreparedPush(this.dependencies.runner, prepared!, signal);
          return outcome.data;
        },
        postflight: async (value) => outputObservation(value),
        warnings: () => outcome?.warnings ?? [],
        classify: (error) => classifyOperationError("git_push", error),
      };
    }, signal, progress);
  }

  async git_operation_get(
    input: GitOperationGetInput,
    signal?: AbortSignal,
    progress?: OperationProgress,
  ): Promise<BridgeResult<unknown>> {
    return withOperationDeadline("git_operation_get", signal, async (deadlineSignal) => {
      try {
        throwIfDeadlineExceeded(deadlineSignal);
        await emitProgress(progress, "preflight");
        throwIfDeadlineExceeded(deadlineSignal);
        await emitProgress(progress, "executing");
        throwIfDeadlineExceeded(deadlineSignal);
        const record = await this.dependencies.journal.get(input.request_id);
        throwIfDeadlineExceeded(deadlineSignal);
        if (record === null) {
          return failure("git_operation_get", "rejected", {
            code: "SESSION_NOT_FOUND", message: "Operation result was not found",
          });
        }
        await emitProgress(progress, "postflight");
        return record.result;
      } catch (error) {
        return classifyOperationError("git_operation_get", error);
      }
    });
  }
}

export async function createBridgeRuntime(paths?: StatePaths): Promise<BridgeRuntime> {
  const statePaths = await initializeStatePaths(paths ?? resolveStatePaths());
  const runner = new GitRunner(await resolveGitExecutable(), process.env);
  const lock = new RepositoryLock(statePaths);
  const journal = new OperationJournal(statePaths, {
    onResultPublicationWarning: () => {
      process.stderr.write("git-mcp-server left a private publication temporary after committing a terminal result\n");
    },
  });
  const sessions = new SessionStore(statePaths);
  const coordinator = new MutationCoordinator({
    runner,
    lock,
    journal,
    audit: new AuditLog(statePaths),
    registry: new RepositoryRegistry(statePaths),
    onLockReleaseFailure: () => {
      process.stderr.write("git-mcp-server could not release a repository lock after durable operation completion\n");
    },
  });
  return {
    journal,
    lock,
    service: new DefaultBridgeService({ runner, lock, journal, sessions, coordinator }),
  };
}
