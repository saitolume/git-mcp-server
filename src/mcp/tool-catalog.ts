import { z } from "zod";
import {
  gitOperationGetInput,
  gitCommitRangeValidateInput,
  gitRewordInput,
  gitAddInput,
  gitCommitInput,
  gitDiffInput,
  gitFetchInput,
  gitMergeAbortInput,
  gitMergeContinueInput,
  gitMergeInput,
  gitPushInput,
  gitRestoreStagedInput,
  gitRestoreWorktreeInput,
  gitStatusInput,
  gitSwitchAttachInput,
  gitSwitchCreateInput,
} from "../domain/inputs.js";
import {
  addDataSchema,
  bridgeResultSchema,
  commitDataSchema,
  diffDataSchema,
  fetchDataSchema,
  mergeAbortDataSchema,
  mergeContinueDataSchema,
  mergeDataSchema,
  pushDataSchema,
  restoreStagedDataSchema,
  restoreWorktreeDataSchema,
  statusDataSchema,
  switchAttachDataSchema,
  switchCreateDataSchema,
  commitRangeValidateDataSchema,
  rewordDataSchema,
} from "../domain/result.js";
import { PRODUCT } from "../product.js";

export const TOOL_NAMES = [
  "git_status", "git_diff", "git_switch_create", "git_switch_attach", "git_add",
  "git_restore_staged", "git_restore_worktree", "git_commit", "git_fetch",
  "git_merge", "git_merge_continue", "git_merge_abort", "git_push",
  "git_commit_range_validate", "git_reword",
  "git_operation_get",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolCatalogEntry {
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const destructiveMutationAnnotations = {
  ...mutationAnnotations,
  destructiveHint: true,
} as const;

const openWorldMutationAnnotations = {
  ...mutationAnnotations,
  openWorldHint: true,
} as const;

const title = (name: string): string => `${PRODUCT.displayName}: ${name}`;

export const TOOL_CATALOG = {
  git_status: {
    title: title("Git status"),
    description: "Operation: Inspect repository status without mutation. Returns: repository_id, branch and HEAD, opaque index_tree, worktree_snapshot_id, and exact path entries. Defaults: inspect the complete repository status. Excludes: read-only; no index refresh or write, object creation, file contents, or remote access.",
    inputSchema: gitStatusInput,
    outputSchema: bridgeResultSchema(statusDataSchema),
    annotations: readOnlyAnnotations,
  },
  git_diff: {
    title: title("Git diff"),
    description: "Operation: Read a byte-limited worktree or staged diff. Returns: repository_id, mode, diff text, byte count, and truncation flag; no durable request identifier. Defaults: omitted paths means all paths, and omitted max_bytes is 1000000. Excludes: read-only; no external diff driver, patch application, Git-state mutation, or remote access.",
    inputSchema: gitDiffInput,
    outputSchema: bridgeResultSchema(diffDataSchema),
    annotations: readOnlyAnnotations,
  },
  git_switch_create: {
    title: title("Create branch"),
    description: "Operation: Create and switch to one new branch from the exact expected_branch and exact expected HEAD. Returns: request_id, repository_id, the created branch, and unchanged head; no session identifier. Defaults: a string expected_branch requires that attached branch, while null requires detached HEAD. Excludes: existing branch checkout, force or reset, branch or HEAD mismatch, dirty or untracked state, and remote access.",
    inputSchema: gitSwitchCreateInput,
    outputSchema: bridgeResultSchema(switchCreateDataSchema),
    annotations: mutationAnnotations,
  },
  git_switch_attach: {
    title: title("Attach branch"),
    description: "Operation: Attach a clean detached worktree to one existing local branch whose expected_branch_head exactly matches the detached HEAD, using native switch --no-guess. Returns: request_id, repository_id, the attached branch, and unchanged head; no session identifier. Defaults: expected_branch must be null and both current and target HEAD guards must name the same commit. Excludes: branch creation, a target checked out in another worktree, dirty state, arbitrary refs, force or reset, implicit stash, and remote access.",
    inputSchema: gitSwitchAttachInput,
    outputSchema: bridgeResultSchema(switchAttachDataSchema),
    annotations: mutationAnnotations,
  },
  git_add: {
    title: title("Stage paths"),
    description: "Operation: Stage only declared literal paths in a normal stage session or owned merge session. Returns: request_id, repository_id, mode, stage_id or merge_session_id, opaque index_tree, staged paths, and unresolved paths. Defaults: omitting both IDs selects normal first-add mode; stage_id and merge_session_id are mutually exclusive. Excludes: ordinary directories, globs, pathspec magic, unrequested paths, and unowned merge paths.",
    inputSchema: gitAddInput,
    outputSchema: bridgeResultSchema(addDataSchema),
    annotations: mutationAnnotations,
  },
  git_restore_staged: {
    title: title("Restore staged paths"),
    description: "Operation: Restore declared paths owned by one stage_id from HEAD into the index. Returns: request_id, repository_id, the remaining or null stage_id, opaque index_tree, and remaining owned paths. Defaults: all inputs are required and the session remains while owned changes remain. Excludes: worktree changes, HEAD reset, unowned paths, ordinary directories, and globs.",
    inputSchema: gitRestoreStagedInput,
    outputSchema: bridgeResultSchema(restoreStagedDataSchema),
    annotations: destructiveMutationAnnotations,
  },
  git_restore_worktree: {
    title: title("Restore worktree paths"),
    description: "Operation: Restore declared tracked worktree paths from the current index after validating the supplied snapshot guard. Returns: request_id, repository_id, restored paths, and a new worktree_snapshot_id. Defaults: all inputs are required and the current index is the only content source. Excludes: index mutation, untracked paths or deletion, directories, globs, and unrequested paths.",
    inputSchema: gitRestoreWorktreeInput,
    outputSchema: bridgeResultSchema(restoreWorktreeDataSchema),
    annotations: destructiveMutationAnnotations,
  },
  git_commit: {
    title: title("Commit staged changes"),
    description: "Operation: Commit the exact index owned by one stage_id with native hooks and signing disabled. Returns: request_id, repository_id, commit and tree object IDs, hook_changed_paths, and signing policy; a rejected pre-commit or commit-msg hook returns HOOK_FAILED with only its allowlisted hook kind. Defaults: all inputs are required, native hooks run, and signing stays disabled. Excludes: raw hook output or exit status, amend, arbitrary index content, implicit staging, push, and hook bypass.",
    inputSchema: gitCommitInput,
    outputSchema: bridgeResultSchema(commitDataSchema),
    annotations: mutationAnnotations,
  },
  git_fetch: {
    title: title("Fetch remote"),
    description: "Operation: Fetch origin heads into the fixed origin-tracking namespace under a constrained policy. Returns: request_id, repository_id, fetch_id, before and after refs, sanitized remote identity, and fetch time. Defaults: origin, standard upload-pack, and no tags, prune, or submodules. Excludes: caller remote or refspec, custom helper, merge, tag updates, nested repository mutation, and retry.",
    inputSchema: gitFetchInput,
    outputSchema: bridgeResultSchema(fetchDataSchema),
    annotations: openWorldMutationAnnotations,
  },
  git_merge: {
    title: title("Merge remote ref"),
    description: "Operation: Merge the exact remote_ref and object bound to one fetch_id. Returns: request_id, repository_id, head, nullable merge_session_id, and conflicted paths. Defaults: allow fast-forward or a native merge commit; conflicts create an owned session. Excludes: rebase, arbitrary local refs or unobserved object IDs, and external merge sessions.",
    inputSchema: gitMergeInput,
    outputSchema: bridgeResultSchema(mergeDataSchema),
    annotations: destructiveMutationAnnotations,
  },
  git_merge_continue: {
    title: title("Continue merge"),
    description: "Operation: Continue the exact owned merge_session_id after all conflicts are resolved. Returns: request_id, repository_id, and resulting head and commit object IDs. Defaults: all inputs are required, native hooks run, and signing stays disabled. Excludes: external merge sessions, unresolved conflicts, arbitrary commits or refs, and retry.",
    inputSchema: gitMergeContinueInput,
    outputSchema: bridgeResultSchema(mergeContinueDataSchema),
    annotations: destructiveMutationAnnotations,
  },
  git_merge_abort: {
    title: title("Abort merge"),
    description: "Operation: Abort the exact owned merge_session_id and restore its original merge state. Returns: request_id, repository_id, and the restored head object ID. Defaults: all inputs are required and owned cleanup follows durable completion. Excludes: external merge sessions, generic reset, unrelated paths, and retry.",
    inputSchema: gitMergeAbortInput,
    outputSchema: bridgeResultSchema(mergeAbortDataSchema),
    annotations: destructiveMutationAnnotations,
  },
  git_push: {
    title: title("Push branch"),
    description: "Operation: Push current branch HEAD to the same branch on origin using expected-remote CAS and ancestry proof. Returns: request_id, repository_id, local_head, and remote_head object IDs. Defaults: origin and current branch are fixed, an internal exact lease is used, and null expectation means absence. Excludes: non-fast-forward updates, caller force or refspec, tags, delete, and automatic retry.",
    inputSchema: gitPushInput,
    outputSchema: bridgeResultSchema(pushDataSchema),
    annotations: openWorldMutationAnnotations,
  },
  git_commit_range_validate: {
    title: title("Validate commit range"),
    description: "Operation: Validate every commit in the exact linear base..HEAD range with the configured native commit-msg hook. Returns: request_id, repository_id, exact base and head IDs, count, and hook kind. Defaults: the current branch and HEAD must match exactly, and every range commit is checked in order. Excludes: reword, amend, force push, hook bypass, hook diagnostics, and success after any hook changes the index, worktree, or refs.",
    inputSchema: gitCommitRangeValidateInput,
    outputSchema: bridgeResultSchema(commitRangeValidateDataSchema),
    annotations: mutationAnnotations,
  },
  git_reword: {
    title: title("Reword commit range"),
    description: "Operation: Recreate every commit in the exact linear base..HEAD range with replacement messages after native commit-msg validation, then move one local destination with exact CAS. Returns: request_id, repository_id, old and new object IDs, count, destination, tree-invariance proof, hook kind, and signing policy. Defaults: preserve every pairwise tree, parent mapping, author, and committer; current_branch moves the checked-out ref, while new_branch creates and switches to one absent local branch. Excludes: signed or merge commits, raw Git arguments, reset, rebase, stash, hook bypass, amend, force push, and automatic retry.",
    inputSchema: gitRewordInput,
    outputSchema: bridgeResultSchema(rewordDataSchema),
    annotations: destructiveMutationAnnotations,
  },
  git_operation_get: {
    title: title("Get operation"),
    description: "Operation: Read the result stored for request_id. Returns: the stored terminal result, including original status, data, request_id, and repository_id when present. Defaults: lookup only; no repository input is required. Excludes: Git execution, repository mutation, repository lock acquisition, retry, and result reconstruction.",
    inputSchema: gitOperationGetInput,
    outputSchema: bridgeResultSchema(z.unknown()),
    annotations: readOnlyAnnotations,
  },
} satisfies Record<ToolName, ToolCatalogEntry>;
