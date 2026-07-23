import { z } from "zod";
import {
  RETURNED_PATH_SET_MAX_BYTES,
  RETURNED_PATH_SET_MAX_COUNT,
  RETURNED_REF_SET_MAX_BYTES,
  RETURNED_REF_SET_MAX_COUNT,
} from "../limits.js";
import {
  absoluteRepositoryPath,
  gitOutputPath,
  gitTransportText,
  objectId,
  originRemoteRef,
  relativeGitPath,
  snapshotId,
} from "./inputs.js";

export type OperationStatus = "succeeded" | "failed" | "conflicted" | "rejected" | "indeterminate";

export const BRIDGE_ERROR_CODES = [
  "INVALID_INPUT", "PATH_OUTSIDE_REPOSITORY", "REPOSITORY_NOT_FOUND",
  "UNSUPPORTED_REPOSITORY_STATE", "BRANCH_MISMATCH", "HEAD_MISMATCH",
  "INDEX_MISMATCH", "INDEX_NOT_EMPTY", "SESSION_NOT_FOUND", "SESSION_MISMATCH",
  "REQUEST_ID_REUSED", "LOCK_TIMEOUT", "HOOK_FAILED", "REMOTE_HEAD_MISMATCH",
  "REMOTE_URL_REJECTED", "GIT_FAILED", "GIT_TIMEOUT", "OUTPUT_TRUNCATED", "OPERATION_INDETERMINATE",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export const COMMIT_HOOK_KINDS = ["pre-commit", "commit-msg"] as const;
export type CommitHookKind = (typeof COMMIT_HOOK_KINDS)[number];
export const HOOK_FAILED_MESSAGE = "A native commit hook rejected the commit";

interface GeneralBridgeError {
  code: Exclude<BridgeErrorCode, "HOOK_FAILED">;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

interface HookFailedError {
  code: "HOOK_FAILED";
  message: typeof HOOK_FAILED_MESSAGE;
  details: Readonly<{ hook: CommitHookKind }>;
}

export type BridgeError = GeneralBridgeError | HookFailedError;

/** Internal control-flow error that later layers classify into bridge results. */
export class BridgeRejection extends Error {
  readonly error: BridgeError;

  constructor(error: BridgeError) {
    super(error.message);
    this.name = "BridgeRejection";
    this.error = error;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface BridgeResult<T> {
  status: OperationStatus;
  request_id?: string;
  repository_id?: string;
  operation: string;
  observed_before?: Readonly<Record<string, unknown>>;
  observed_after?: Readonly<Record<string, unknown>>;
  data?: T;
  warnings: readonly string[];
  error?: BridgeError;
}

const operationStatusSchema = z.enum(["succeeded", "failed", "conflicted", "rejected", "indeterminate"]);
const observationSchema = z.record(z.string(), z.unknown());
const nonHookErrorCodes = BRIDGE_ERROR_CODES.filter(
  (code): code is Exclude<BridgeErrorCode, "HOOK_FAILED"> => code !== "HOOK_FAILED",
);
const bridgeErrorSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("HOOK_FAILED"),
    message: z.literal(HOOK_FAILED_MESSAGE),
    details: z.strictObject({ hook: z.enum(COMMIT_HOOK_KINDS) }),
  }),
  z.strictObject({
    code: z.enum(nonHookErrorCodes),
    message: z.string(),
    details: observationSchema.optional(),
  }),
]);

export function bridgeResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.strictObject({
    status: operationStatusSchema,
    request_id: z.string().optional(),
    repository_id: z.string().optional(),
    operation: z.string(),
    observed_before: observationSchema.optional(),
    observed_after: observationSchema.optional(),
    data: dataSchema.optional(),
    warnings: z.array(z.string()),
    error: bridgeErrorSchema.optional(),
  });
}

export function success<T>(operation: string, data: T): BridgeResult<T> {
  return { status: "succeeded", operation, data, warnings: [] };
}

export function failure(
  operation: string,
  status: Exclude<OperationStatus, "succeeded" | "conflicted">,
  error: BridgeError,
): BridgeResult<never> {
  return { status, operation, warnings: [], error };
}

const statusEntrySchema = z.strictObject({
  path: gitOutputPath,
  index: z.string(),
  worktree: z.string(),
  kind: z.enum(["ordinary", "renamed", "unmerged", "untracked"]),
});

function returnedPathArray<T extends z.ZodType<string>>(item: T) {
  return z.array(item).max(RETURNED_PATH_SET_MAX_COUNT).refine(
    (paths) => paths.reduce((bytes, path) => bytes + Buffer.byteLength(path, "utf8"), 0) <= RETURNED_PATH_SET_MAX_BYTES,
    "returned path set exceeds its byte limit",
  );
}

const returnedRelativePaths = returnedPathArray(relativeGitPath);
const returnedGitOutputPaths = returnedPathArray(gitOutputPath);

export const statusDataSchema = z.strictObject({
  repository_id: z.string(),
  root: absoluteRepositoryPath,
  git_dir: absoluteRepositoryPath,
  common_git_dir: absoluteRepositoryPath,
  branch: gitTransportText.nullable(),
  head: objectId,
  head_tree: objectId,
  index_tree: snapshotId,
  operation_state: z.string(),
  worktree_snapshot_id: snapshotId,
  entries: z.array(statusEntrySchema).max(RETURNED_PATH_SET_MAX_COUNT).refine(
    (entries) => entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.path, "utf8"), 0) <= RETURNED_PATH_SET_MAX_BYTES,
    "status path set exceeds its byte limit",
  ),
});

export const diffDataSchema = z.strictObject({
  mode: z.enum(["worktree", "staged"]),
  diff: z.string(),
  truncated: z.boolean(),
  bytes: z.number().int().min(0),
});

export const switchCreateDataSchema = z.strictObject({
  branch: gitTransportText,
  head: objectId,
});

export const addDataSchema = z.strictObject({
  mode: z.string(),
  stage_id: z.string().nullable(),
  merge_session_id: z.string().nullable(),
  index_tree: snapshotId,
  staged_paths: returnedRelativePaths,
  unresolved_paths: returnedGitOutputPaths,
});

export const restoreStagedDataSchema = z.strictObject({
  stage_id: z.string().nullable(),
  index_tree: snapshotId,
  remaining_paths: returnedRelativePaths,
});

export const restoreWorktreeDataSchema = z.strictObject({
  restored_paths: returnedRelativePaths,
  worktree_snapshot_id: snapshotId,
});

export const commitDataSchema = z.strictObject({
  commit: objectId,
  tree: objectId,
  hook_changed_paths: returnedGitOutputPaths,
  signing: z.literal("disabled_by_policy"),
});

const returnedRefMap = z.record(originRemoteRef, objectId).refine((refs) => {
  const entries = Object.entries(refs);
  return entries.length <= RETURNED_REF_SET_MAX_COUNT
    && entries.reduce((bytes, [ref, object]) => bytes + Buffer.byteLength(ref) + Buffer.byteLength(object), 0)
      <= RETURNED_REF_SET_MAX_BYTES;
}, "returned ref set exceeds its count or byte limit");

export const fetchDataSchema = z.strictObject({
  fetch_id: z.string(),
  refs_before: returnedRefMap,
  refs_after: returnedRefMap,
  remote_identity: z.string().regex(/^(?:https|ssh):\/\/[^\s/@]+\/[0-9a-f]{64}$/),
  fetched_at: z.string(),
});

export const mergeDataSchema = z.strictObject({
  head: objectId,
  merge_session_id: z.string().nullable(),
  conflicted_paths: returnedGitOutputPaths,
});

export const mergeContinueDataSchema = z.strictObject({
  head: objectId,
  commit: objectId,
});

export const mergeAbortDataSchema = z.strictObject({
  head: objectId,
});

export const pushDataSchema = z.strictObject({
  local_head: objectId,
  remote_head: objectId,
});

const operationDataSchemas: Readonly<Record<string, z.ZodType>> = {
  git_status: statusDataSchema,
  git_diff: diffDataSchema,
  git_switch_create: switchCreateDataSchema,
  git_add: addDataSchema,
  git_restore_staged: restoreStagedDataSchema,
  git_restore_worktree: restoreWorktreeDataSchema,
  git_commit: commitDataSchema,
  git_fetch: fetchDataSchema,
  git_merge: mergeDataSchema,
  git_merge_continue: mergeContinueDataSchema,
  git_merge_abort: mergeAbortDataSchema,
  git_push: pushDataSchema,
};

/** Validates persisted data against the exact public output schema for its operation. */
export function validateOperationOutput(operation: string, data: unknown): unknown {
  const schema = operationDataSchemas[operation];
  if (schema === undefined) throw new TypeError(`Persisted operation output is unsupported: ${operation}`);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new TypeError(`Persisted ${operation} output data is invalid`);
  return parsed.data;
}

export type StatusData = z.infer<typeof statusDataSchema>;
export type DiffData = z.infer<typeof diffDataSchema>;
export type SwitchCreateData = z.infer<typeof switchCreateDataSchema>;
export type AddData = z.infer<typeof addDataSchema>;
export type RestoreStagedData = z.infer<typeof restoreStagedDataSchema>;
export type RestoreWorktreeData = z.infer<typeof restoreWorktreeDataSchema>;
export type CommitData = z.infer<typeof commitDataSchema>;
export type FetchData = z.infer<typeof fetchDataSchema>;
export type MergeData = z.infer<typeof mergeDataSchema>;
export type MergeContinueData = z.infer<typeof mergeContinueDataSchema>;
export type MergeAbortData = z.infer<typeof mergeAbortDataSchema>;
export type PushData = z.infer<typeof pushDataSchema>;
export type StatusEntry = z.infer<typeof statusEntrySchema>;
