# git-mcp-server

`git-mcp-server` is a local stdio Model Context Protocol (MCP) server for a
small, explicit set of native Git operations. It is a development preview, not
an npm stable release or a general shell.

## Status

Version `0.1.0-beta.3` is the npm development preview of
`@saitolume/git-mcp-server` and is distributed only under the `beta` tag. The
`latest` tag and an npm stable release are not available. A stable release
remains a separate gate: it needs an exact stable MCP SDK, provider acceptance
across a broader set of clients, and hosted CI evidence.

## Requirements

The built runtime requires Node.js >=22, native Git 2.39.0 or later on `PATH`,
and a trusted local Git repository. Building from source requires Node.js
>=22.13 and `pnpm@11.15.1`.

## Run the beta

Start the published development preview with the explicit `beta` tag:

```sh
npx --yes @saitolume/git-mcp-server@beta
```

Do not omit `@beta`; this preview does not use the `latest` tag.

## Build from source

Clone this repository, then enter its directory and run:

```sh
pnpm install --frozen-lockfile
pnpm build
```

## MCP configuration

Configure an MCP client to start the explicit npm beta:

```json
{
  "mcpServers": {
    "git": {
      "command": "npx",
      "args": ["--yes", "@saitolume/git-mcp-server@beta"]
    }
  }
}
```

For a source build, run the built server with
`node /absolute/path/dist/cli.js`. Use an absolute path to the checkout because
an MCP client's working directory may be undefined.

After installing a build that contains a new tool, fully restart the MCP server
process and the client session that launched it so the client discovers the new
tool schema. For this unreleased source change, check out the implementing
commit, run `pnpm install --frozen-lockfile && pnpm build`, keep the absolute
`dist/cli.js` configuration above, and restart both processes.

## Tools

| Tool | Purpose |
| --- | --- |
| `git_status` | Read repository identity, branch, HEAD, index/worktree state, and a worktree snapshot ID. |
| `git_diff` | Return a byte-limited worktree or staged diff for declared paths. |
| `git_switch_create` | Create and switch to a branch after exact attached-or-detached branch and HEAD preflight. |
| `git_switch_attach` | Attach a clean detached worktree to an existing same-HEAD local branch after exact current and target preflight. |
| `git_add` | Stage declared paths, or mark declared conflict paths resolved. |
| `git_restore_staged` | Destructively unstage declared paths owned by a stage session. |
| `git_restore_worktree` | Destructively restore declared paths after a worktree snapshot guard. |
| `git_commit` | Commit the exact active stage session with the supplied message; native `pre-commit` and `commit-msg` rejection returns a redacted `HOOK_FAILED`. |
| `git_fetch` | Fetch `origin` and record observed remote refs in a fetch session. |
| `git_merge` | Merge an expected fetched `origin` tracking ref, or return a conflict session. |
| `git_merge_continue` | Complete a declared merge session after resolved paths are staged. |
| `git_merge_abort` | Destructively abort a declared in-progress merge session. |
| `git_push` | Push an expected local branch head after checking the expected remote head; it remains fast-forward-only. |
| `git_push_force_with_lease` | Destructively replace the same-name branch on `origin` only with an exact caller-observed remote-head lease. |
| `git_commit_range_validate` | Run the native `commit-msg` hook against every commit in one exact linear `base..HEAD` range. |
| `git_reword` | Recreate an exact linear range with replacement messages, either on the current branch or a new local branch, while proving each tree is unchanged. |
| `git_commit_amend` | Replace only the current unsigned commit with an owned stage session and guarded worktree snapshot. |
| `git_operation_get` | Read the durable result for a request ID. |

## Typical workflow

Call `git_status`. To create a branch from an attached branch, pass its exact
name as `git_switch_create.expected_branch`; when `git_status` returns
`branch: null`, pass `expected_branch: null` to require that exact detached
`HEAD` before creating the branch. Then explicitly call `git_add` for the paths
intended for a commit, and finally call `git_commit`. For remote work, call
`git_fetch`, then `git_merge`; when a merge reports conflicts, resolve the listed paths, call
`git_add`, and call `git_merge_continue`. Use `git_merge_abort` only when the
declared merge must be abandoned. If transport is interrupted after a request,
use the same request ID with `git_operation_get` to replay its durable result;
do not repeat the mutation.

To attach a managed worktree to an existing claimed local branch, first use
`git_status` and require `branch: null`. Call `git_switch_attach` with exactly
`repository`, a new `request_id`, `expected_branch: null`, the returned full
`expected_head`, the local `branch` name, and its full
`expected_branch_head`. The target branch must exist, its expected and observed
HEAD must equal the detached worktree HEAD, and it must not be checked out in
another worktree. The current operation state must be `none`; the index and
complete worktree, including untracked paths, must be clean; and no bridge
session may be active.

## Guarded history recovery examples

Every object ID below is a full object ID and every `request_id` is a fixed
example UUID. Replace the repository path, IDs, branch, messages, and request
IDs with values from your own trusted repository. Build the implementing source
commit with `pnpm install --frozen-lockfile && pnpm build`, retain the absolute
`dist/cli.js` command, then restart the MCP server and client session before
calling these new tools.

First validate the exact current range; validation executes the repository's
native `commit-msg` hook for every commit, in order:

```json
{
  "tool": "git_commit_range_validate",
  "arguments": {
    "repository": "/absolute/path/to/repository",
    "request_id": "018f47d2-7b2a-7d75-b9dd-5ea8abca0100",
    "expected_branch": "feature/history-example",
    "expected_head": "2222222222222222222222222222222222222222",
    "base": "1111111111111111111111111111111111111111"
  }
}
```

For the current-branch route, reword the complete ordered range, then use the
separate destructive delivery tool with the remote head you just observed. The
force permission is a caller approval policy: a client or user may authorize
this tool, but the bridge never decides to discard remote commits. An exact remote CAS is mandatory;
provider or branch protection may still reject the update.

Take a fresh observation immediately before delivery and use that exact remote
head as the lease. If the remote CAS drifts, stop with the drift evidence
preserved: perform no automatic refresh or retry. An explicit human decision is
required before a new observation may be used to discard an externally added
commit.

```json
{
  "tool": "git_reword",
  "arguments": {
    "repository": "/absolute/path/to/repository",
    "request_id": "018f47d2-7b2a-7d75-b9dd-5ea8abca0101",
    "expected_branch": "feature/history-example",
    "expected_head": "2222222222222222222222222222222222222222",
    "base": "1111111111111111111111111111111111111111",
    "commits": [{
      "commit": "2222222222222222222222222222222222222222",
      "message": "feat(history): clarify recovery"
    }],
    "destination": { "mode": "current_branch" }
  }
}
```

```json
{
  "tool": "git_push_force_with_lease",
  "arguments": {
    "repository": "/absolute/path/to/repository",
    "request_id": "018f47d2-7b2a-7d75-b9dd-5ea8abca0102",
    "expected_branch": "feature/history-example",
    "expected_head": "3333333333333333333333333333333333333333",
    "expected_remote_head": "2222222222222222222222222222222222222222"
  }
}
```

For the replacement-branch route, create and switch to a new local branch while
leaving the original branch unchanged. It can then use ordinary `git_push`,
which remains fast-forward-only and does not replace published history:

```json
{
  "tool": "git_reword",
  "arguments": {
    "repository": "/absolute/path/to/repository",
    "request_id": "018f47d2-7b2a-7d75-b9dd-5ea8abca0103",
    "expected_branch": "feature/history-example",
    "expected_head": "2222222222222222222222222222222222222222",
    "base": "1111111111111111111111111111111111111111",
    "commits": [{
      "commit": "2222222222222222222222222222222222222222",
      "message": "feat(history): clarify replacement route"
    }],
    "destination": { "mode": "new_branch", "branch": "feature/history-reworded" }
  }
}
```

```json
{
  "tool": "git_push",
  "arguments": {
    "repository": "/absolute/path/to/repository",
    "request_id": "018f47d2-7b2a-7d75-b9dd-5ea8abca0104",
    "expected_branch": "feature/history-reworded",
    "expected_head": "3333333333333333333333333333333333333333",
    "expected_remote_head": null
  }
}
```

To amend only the current commit, first create the normal stage session with
`git_add`, retain its exact stage and snapshot IDs, and then call:

```json
{
  "tool": "git_commit_amend",
  "arguments": {
    "repository": "/absolute/path/to/repository",
    "request_id": "018f47d2-7b2a-7d75-b9dd-5ea8abca0105",
    "expected_branch": "feature/history-example",
    "expected_head": "2222222222222222222222222222222222222222",
    "stage_id": "stage-example-20260801",
    "worktree_snapshot_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "message": "fix(history): amend the owned staged change"
  }
}
```

Signed source commits are rejected; signing remains `disabled_by_policy`.
Commit messages are redacted from durable request records, although the original
message remains part of the request hash used for replay. Native `commit-msg`,
`pre-commit`, reference-transaction, and pre-push hooks remain enabled; hook
rejection is a redacted `HOOK_FAILED` result. The existing git_push remains fast-forward-only
for backward compatibility. These additions are unreleased:
do not infer an npm release, tag, or `latest` availability from this source
change.

## Safety boundaries

Use only trusted repositories. Inputs are explicit repository-relative paths
and mutations require expected branch and HEAD preconditions. Only
`git_switch_create` accepts a null expected branch to allow branch creation
from detached `HEAD`. `git_switch_attach` requires a literal null expected
branch and never accepts an attached starting state. Other mutations require an
attached branch name. Attach never creates a branch, resets, forces, accesses a
remote, stashes dirty state, or accepts an arbitrary ref; its only mutation is
native `git switch --no-guess <branch>`. Native hooks are enabled and may run
repository-controlled code. Commits use `--no-gpg-sign`; the server does not
bypass hooks. Review destructive restore, merge-abort, merge, and push
operations before approving them.

The server is not an isolation boundary for intentionally malicious hooks
running as the same operating-system user. Hook-failure redaction is a bounded
result contract for trusted repositories, not a sandbox for hostile hook code.

When a native `pre-commit` or `commit-msg` hook rejects a commit,
`git_commit` returns `status: "failed"` with `error.code: "HOOK_FAILED"`.
The fixed error contains only `error.details.hook`, whose value is allowlisted
to `pre-commit` or `commit-msg`. Raw hook stdout and stderr, the hook exit
status, and file contents are not returned or persisted in the operation
result. The commit HEAD remains unchanged and the stage session remains
available for a corrected retry. If the hook changed the index before
rejecting the commit, the existing index guard prevents retry until the caller
restores an exact stage-session state.

## State directories

The server stores locks, durable operations, sessions, and audit records in a
private state root:

| Platform | State root |
| --- | --- |
| macOS | `~/Library/Application Support/git-mcp-server` |
| Linux | `$XDG_STATE_HOME/git-mcp-server`, or `~/.local/state/git-mcp-server` when unset |

## Platform support

macOS and Linux are supported with Node.js >=22 and a POSIX-style filesystem.
Windows is not supported or promised.

## Development

This development preview uses the exact beta MCP SDK versions declared in
`package.json`. Run `pnpm check` for the local build and test contract, and
`pnpm pack --dry-run --json` to inspect the package payload without publishing.
The `beta` package remains separate from the npm stable-release gates described
in Status. See the
[provider checklist](docs/acceptance/provider-checklist.md) and
[architecture](docs/architecture.md).

## Security

Do not report vulnerabilities in public issues. Use GitHub Private Vulnerability Reporting as described in [SECURITY.md](SECURITY.md).

## Support and contributions

This project does not accept Issues, pull requests, or support requests.
Please do not submit a contribution or request assistance through this source
repository.

## License

Distributed under the [MIT License](LICENSE).
