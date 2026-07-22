# git-mcp-server

`git-mcp-server` is a local stdio Model Context Protocol (MCP) server for a
small, explicit set of native Git operations. It is a development preview, not
an npm stable release or a general shell.

## Status

Version `0.1.0-beta.1` is the npm development preview of
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

## Tools

| Tool | Purpose |
| --- | --- |
| `git_status` | Read repository identity, branch, HEAD, index/worktree state, and a worktree snapshot ID. |
| `git_diff` | Return a byte-limited worktree or staged diff for declared paths. |
| `git_switch_create` | Create and switch to a branch after branch and HEAD preflight. |
| `git_add` | Stage declared paths, or mark declared conflict paths resolved. |
| `git_restore_staged` | Destructively unstage declared paths owned by a stage session. |
| `git_restore_worktree` | Destructively restore declared paths after a worktree snapshot guard. |
| `git_commit` | Commit the exact active stage session with the supplied message. |
| `git_fetch` | Fetch `origin` and record observed remote refs in a fetch session. |
| `git_merge` | Merge an expected fetched `origin` tracking ref, or return a conflict session. |
| `git_merge_continue` | Complete a declared merge session after resolved paths are staged. |
| `git_merge_abort` | Destructively abort a declared in-progress merge session. |
| `git_push` | Push an expected local branch head after checking the expected remote head. |
| `git_operation_get` | Read the durable result for a request ID. |

## Typical workflow

Call `git_status`, then explicitly call `git_add` for the paths intended for a
commit, and finally call `git_commit`. For remote work, call `git_fetch`, then
`git_merge`; when a merge reports conflicts, resolve the listed paths, call
`git_add`, and call `git_merge_continue`. Use `git_merge_abort` only when the
declared merge must be abandoned. If transport is interrupted after a request,
use the same request ID with `git_operation_get` to replay its durable result;
do not repeat the mutation.

## Safety boundaries

Use only trusted repositories. Inputs are explicit repository-relative paths
and mutations require expected branch and HEAD preconditions. Native hooks are
enabled and may run repository-controlled code. Commits use `--no-gpg-sign`;
the server does not bypass hooks. Review destructive restore, merge-abort,
merge, and push operations before approving them.

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
