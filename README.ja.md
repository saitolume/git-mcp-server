# git-mcp-server

`git-mcp-server` は、少数かつ明示的な native Git 操作を提供するローカル stdio
Model Context Protocol (MCP) サーバーです。これは development preview であり、
npm stable release や汎用シェルではありません。

## Status

`0.1.0-beta.1` は `@saitolume/git-mcp-server` の npm development preview であり、
`beta` tag だけで配布します。`latest` tag と npm stable release は提供しません。
stable release は別 gate であり、exact stable MCP SDK、より広い provider acceptance、
hosted CI の証跡が必要です。

## Requirements

built runtime には Node.js >=22、`PATH` 上の native Git 2.39.0 以降、および trusted
local Git repository が必要です。source build には Node.js >=22.13 と
`pnpm@11.15.1` が必要です。

## Beta の起動

公開された development preview は明示的な `beta` tag で起動します。

```sh
npx --yes @saitolume/git-mcp-server@beta
```

`@beta` は省略しないでください。この preview は `latest` tag を使いません。

## Build from source

このリポジトリを clone してから、その directory に移動して実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
```

## MCP configuration

MCP client には明示的な npm beta を起動するよう設定します。

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

source build を使う場合は `node /absolute/path/dist/cli.js` で built server を起動します。
MCP client の working directory は未定義の場合があるため、checkout への absolute path
を使ってください。

## Tools

| Tool | Purpose |
| --- | --- |
| `git_status` | repository identity、branch、HEAD、index/worktree state、worktree snapshot ID を読む。 |
| `git_diff` | 宣言した paths の byte-limited な worktree または staged diff を返す。 |
| `git_switch_create` | branch と HEAD の preflight 後に branch を作成して切り替える。 |
| `git_add` | 宣言した paths を stage するか、declared conflict paths を resolved にする。 |
| `git_restore_staged` | stage session が所有する宣言済み paths を destructive に unstage する。 |
| `git_restore_worktree` | worktree snapshot guard 後に宣言済み paths を destructive に restore する。 |
| `git_commit` | supplied message で exact active stage session を commit する。 |
| `git_fetch` | `origin` を fetch し、observed remote refs を fetch session に記録する。 |
| `git_merge` | expected fetched `origin` tracking ref を merge するか、conflict session を返す。 |
| `git_merge_continue` | resolved paths が staged された後に declared merge session を完了する。 |
| `git_merge_abort` | declared in-progress merge session を destructive に abort する。 |
| `git_push` | expected remote head を確認後に expected local branch head を push する。 |
| `git_operation_get` | request ID の durable result を読む。 |

## Typical workflow

まず `git_status` を呼び、commit に含める paths だけを明示して `git_add` を呼び、
最後に `git_commit` を呼びます。remote 作業では `git_fetch` の後に `git_merge` を
呼びます。merge が conflicts を返した場合は listed paths を解決して `git_add` を呼び、
`git_merge_continue` を呼びます。declared merge を取りやめる必要がある場合だけ
`git_merge_abort` を使います。request 後に transport が中断した場合は、同じ request ID
で `git_operation_get` を使い durable result を replay し、mutation を繰り返しません。

## Safety boundaries

trusted repositories だけで使ってください。inputs は明示的な repository-relative paths
で、mutations には expected branch と HEAD preconditions が必要です。native hooks は
enabled であり repository-controlled code を実行することがあります。commits は
`--no-gpg-sign` を使います。server は hooks を bypass しません。destructive restore、
merge-abort、merge、push は承認前に確認してください。

## State directories

server は locks、durable operations、sessions、audit records を private state root に
保存します。

| Platform | State root |
| --- | --- |
| macOS | `~/Library/Application Support/git-mcp-server` |
| Linux | `$XDG_STATE_HOME/git-mcp-server`、未設定時は `~/.local/state/git-mcp-server` |

## Platform support

Node.js >=22 と POSIX-style filesystem を備えた macOS と Linux を support します。
Windows は support または promise の対象ではありません。

## Development

この development preview は `package.json` で宣言した exact beta MCP SDK versions を
使用します。local build/test contract には `pnpm check`、publish せず package payload を
確認するには `pnpm pack --dry-run --json` を実行します。`beta` package は Status に
記載した npm stable-release gates とは別です。
[provider checklist](docs/acceptance/provider-checklist.md) と
[architecture](docs/architecture.md) を参照してください。

## Security

vulnerability を public issues に報告しないでください。
[SECURITY.md](SECURITY.md) のとおり GitHub Private Vulnerability Reporting を使います。

## Support and contributions

この project は Issues、pull requests、support requests を受け付けません。この source
repository 経由で contribution を提出したり assistance を求めたりしないでください。

## License

[MIT License](LICENSE) の下で配布します。
