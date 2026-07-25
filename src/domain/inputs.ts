import { z } from "zod";
import { EXPLICIT_PATH_SET_MAX_BYTES, EXPLICIT_PATH_SET_MAX_COUNT, GIT_PATH_MAX_BYTES } from "../limits.js";
import { isOriginRemoteRef } from "./origin-ref.js";
import { isWellFormedGitText } from "./git-text.js";

export const gitTransportText = z.string().refine(isWellFormedGitText, "text must be well-formed Unicode without U+FFFD");

export const absoluteRepositoryPath = gitTransportText.min(1).refine(
  (value) => value.startsWith("/"),
  "repository must be absolute",
).describe("Absolute filesystem path to the target Git worktree; it must start with '/'.");
export const objectId = z.string().regex(/^[0-9a-f]{40,64}$/)
  .describe("Full lowercase 40- or 64-hex Git object ID.");
export const requestId = z.uuid()
  .describe("Client-generated UUID used as the durable idempotency and replay identity.");
export const snapshotId = z.string().regex(/^[0-9a-f]{64}$/)
  .describe("Opaque 64-hex snapshot or index fingerprint returned by this bridge.");
export const originRemoteRef = gitTransportText.regex(/^refs\/remotes\/origin\/.+$/).refine(isOriginRemoteRef, "origin ref is invalid")
  .describe("Exact full ref below refs/remotes/origin/ using Git-safe ref components.");
export const relativeGitPath = gitTransportText.min(1).max(GIT_PATH_MAX_BYTES).refine((value) => {
  if (Buffer.byteLength(value, "utf8") > GIT_PATH_MAX_BYTES) return false;
  if (value === "." || value.includes("\0") || value.includes("\\") || value.startsWith(":")
    || value.startsWith("/") || /[*?\[]/.test(value)) {
    return false;
  }
  return !value.split("/").some((part) => part === "" || part === "." || part === "..");
}, "path must be an individual repository-relative path")
  .describe("One literal repository-relative path of at most 4096 UTF-8 bytes; absolute paths, dot segments, backslashes, globs, and pathspec magic are forbidden.");

/** A literal path emitted by Git, not an input pathspec. */
export const gitOutputPath = gitTransportText.min(1).max(GIT_PATH_MAX_BYTES).refine((value) => {
  if (Buffer.byteLength(value, "utf8") > GIT_PATH_MAX_BYTES) return false;
  if (value.includes("\0") || value.includes("�") || value.startsWith("/")) return false;
  return !value.split("/").some((part) => part === "" || part === "." || part === "..");
}, "path must be a valid repository-relative Git output path")
  .describe("One repository-relative path emitted by Git; it is output data and is never accepted as a mutation pathspec.");

export const mutationBase = {
  repository: absoluteRepositoryPath.describe("Absolute path to the exact target Git worktree for this mutation."),
  request_id: requestId.describe("Client-generated UUID that makes this mutation durable and idempotent for exact replay."),
  expected_branch: gitTransportText.min(1)
    .describe("Exact current local branch name expected before mutation; mismatch rejects without Git mutation."),
  expected_head: objectId.describe("Exact current local HEAD object ID expected before mutation; mismatch rejects without Git mutation."),
};

const nonEmptyId = z.string().min(1);
const mutationPaths = z.array(relativeGitPath).min(1).max(EXPLICIT_PATH_SET_MAX_COUNT)
  .refine((paths) => paths.reduce((bytes, path) => bytes + Buffer.byteLength(path, "utf8"), 0) <= EXPLICIT_PATH_SET_MAX_BYTES,
    "explicit path set must total at most 131072 UTF-8 bytes")
  .describe("List of 1 through 10000 explicit literal repository-relative paths totaling at most 131072 UTF-8 bytes; ordinary directories and implicit expansion are forbidden.");

export const gitStatusInput = z.strictObject({
  repository: absoluteRepositoryPath.describe("Absolute path to the Git worktree whose complete status will be read without mutation."),
});

export const gitDiffInput = z.strictObject({
  repository: absoluteRepositoryPath.describe("Absolute path to the Git worktree whose diff will be read without mutation."),
  mode: z.enum(["worktree", "staged"])
    .describe("Diff source: 'worktree' compares worktree to index; 'staged' compares index to HEAD."),
  paths: z.array(relativeGitPath).max(EXPLICIT_PATH_SET_MAX_COUNT)
    .refine((paths) => paths.reduce((bytes, path) => bytes + Buffer.byteLength(path, "utf8"), 0) <= EXPLICIT_PATH_SET_MAX_BYTES,
      "path filter set must total at most 131072 UTF-8 bytes")
    .optional()
    .describe("Optional list of at most 10000 literal path filters totaling at most 131072 UTF-8 bytes. Omit it, or use the published empty-array default, to include all repository paths.")
    .meta({ default: [] }),
  max_bytes: z.number().int().min(1).max(1_000_000).optional()
    .describe("Optional maximum UTF-8 output bytes, from 1 through 1000000. Omit to use 1000000.")
    .meta({ default: 1_000_000 }),
});

export const gitSwitchCreateInput = z.strictObject({
  ...mutationBase,
  expected_branch: gitTransportText.min(1).nullable()
    .describe("Exact current local branch expected before branch creation, or null to require detached HEAD; mismatch rejects without Git mutation."),
  branch: gitTransportText.min(1)
    .describe("New local branch name to create from the exact expected HEAD; existing or invalid refs are rejected."),
});

const attachBranchName = gitTransportText.min(1)
  .refine((value) => value !== "HEAD" && !value.startsWith("refs/"), "branch must be a local branch name, not a ref expression")
  .describe("Existing local branch name to attach; HEAD, refs/* names, arbitrary ref expressions, and invalid Git branch names are forbidden.");

export const gitSwitchAttachInput = z.strictObject({
  ...mutationBase,
  expected_branch: z.literal(null)
    .describe("Required null literal proving the caller expects the current worktree to be detached."),
  branch: attachBranchName,
  expected_branch_head: objectId
    .describe("Exact full object ID expected at the existing local branch before attachment."),
});

export const gitAddInput = z.strictObject({
  ...mutationBase,
  paths: mutationPaths.describe("Explicit literal paths to stage; every path must satisfy the selected stage or merge session policy."),
  stage_id: nonEmptyId.optional()
    .describe("Optional existing normal-stage session ID. Omit for the first normal add; mutually exclusive with merge_session_id."),
  merge_session_id: nonEmptyId.optional()
    .describe("Optional owned merge-session ID for conflict resolution. Omit for normal stage mode; mutually exclusive with stage_id."),
}).refine(
  (value) => !(value.stage_id !== undefined && value.merge_session_id !== undefined),
  "stage_id and merge_session_id are mutually exclusive",
);

export const gitRestoreStagedInput = z.strictObject({
  ...mutationBase,
  stage_id: nonEmptyId.describe("Owned normal-stage session ID whose exact paths may be restored from HEAD in the index."),
  paths: mutationPaths.describe("Explicit subset of paths owned by stage_id to restore from HEAD in the index."),
});

export const gitRestoreWorktreeInput = z.strictObject({
  ...mutationBase,
  worktree_snapshot_id: snapshotId.describe("Exact complete worktree snapshot guard previously returned by git_status."),
  paths: mutationPaths.describe("Explicit tracked worktree paths to restore from the current index after the snapshot guard is validated."),
});

export const gitCommitInput = z.strictObject({
  ...mutationBase,
  stage_id: nonEmptyId.describe("Owned normal-stage session ID whose exact index content will be committed."),
  message: z.string().min(1).max(100_000)
    .describe("Commit message passed only on standard input; it must contain 1 through 100000 characters."),
});

export const gitFetchInput = z.strictObject(mutationBase);

export const gitMergeInput = z.strictObject({
  ...mutationBase,
  fetch_id: nonEmptyId.describe("Bridge-issued fetch session ID that binds the allowed remote-tracking observation."),
  remote_ref: originRemoteRef
    .describe("Exact origin remote-tracking ref observed in fetch_id; arbitrary local refs are forbidden."),
  expected_remote_object: objectId.describe("Exact Git object ID that fetch_id observed at remote_ref."),
});

export const gitMergeContinueInput = z.strictObject({
  ...mutationBase,
  merge_session_id: nonEmptyId.describe("Owned conflicted merge-session ID to continue after all unresolved paths are staged."),
});

export const gitMergeAbortInput = z.strictObject({
  ...mutationBase,
  merge_session_id: nonEmptyId.describe("Owned conflicted merge-session ID to abort; external merge state is rejected."),
});

export const gitPushInput = z.strictObject({
  ...mutationBase,
  expected_remote_head: objectId.nullable()
    .describe("Exact expected origin branch head for atomic lease comparison, or null only when the branch is expected absent."),
});

export const gitOperationGetInput = z.strictObject({
  request_id: requestId.describe("UUID of a previously durable Git mutation whose exact terminal result should be returned."),
});

export type GitStatusInput = z.infer<typeof gitStatusInput>;
export type GitDiffInput = z.infer<typeof gitDiffInput>;
export type GitSwitchCreateInput = z.infer<typeof gitSwitchCreateInput>;
export type GitSwitchAttachInput = z.infer<typeof gitSwitchAttachInput>;
export type GitAddInput = z.infer<typeof gitAddInput>;
export type GitRestoreStagedInput = z.infer<typeof gitRestoreStagedInput>;
export type GitRestoreWorktreeInput = z.infer<typeof gitRestoreWorktreeInput>;
export type GitCommitInput = z.infer<typeof gitCommitInput>;
export type GitFetchInput = z.infer<typeof gitFetchInput>;
export type GitMergeInput = z.infer<typeof gitMergeInput>;
export type GitMergeContinueInput = z.infer<typeof gitMergeContinueInput>;
export type GitMergeAbortInput = z.infer<typeof gitMergeAbortInput>;
export type GitPushInput = z.infer<typeof gitPushInput>;
export type GitOperationGetInput = z.infer<typeof gitOperationGetInput>;
