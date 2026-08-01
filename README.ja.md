# git-mcp-server

`git-mcp-server` は、少数かつ明示的な native Git 操作を提供するローカル stdio
Model Context Protocol (MCP) サーバーです。これは development preview であり、
npm stable release や汎用シェルではありません。

## Status

`0.1.0-beta.3` は `@saitolume/git-mcp-server` の npm development preview であり、
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

新しい tool を含む build を install した後は、MCP server process と、それを起動した
client session を完全に restart し、client に新しい tool schema を再検出させます。
この未公開 source 変更を使う場合は、実装 commit を checkout して
`pnpm install --frozen-lockfile && pnpm build` を実行し、上記の absolute
`dist/cli.js` 設定を保ったまま両 process を restart してください。

## Tools

| Tool | Purpose |
| --- | --- |
| `git_status` | repository identity、branch、HEAD、index/worktree state、worktree snapshot ID を読む。 |
| `git_diff` | 宣言した paths の byte-limited な worktree または staged diff を返す。 |
| `git_switch_create` | attached または detached の branch state と HEAD の exact preflight 後に branch を作成して切り替える。 |
| `git_switch_attach` | clean detached worktree を existing same-HEAD local branch へ exact current/target preflight 後に attach する。 |
| `git_add` | 宣言した paths を stage するか、declared conflict paths を resolved にする。 |
| `git_restore_staged` | stage session が所有する宣言済み paths を destructive に unstage する。 |
| `git_restore_worktree` | worktree snapshot guard 後に宣言済み paths を destructive に restore する。 |
| `git_commit` | supplied message で exact active stage session を commit する。native `pre-commit` / `commit-msg` の拒否は redacted な `HOOK_FAILED` を返す。 |
| `git_fetch` | `origin` を fetch し、observed remote refs を fetch session に記録する。 |
| `git_merge` | expected fetched `origin` tracking ref を merge するか、conflict session を返す。 |
| `git_merge_continue` | resolved paths が staged された後に declared merge session を完了する。 |
| `git_merge_abort` | declared in-progress merge session を destructive に abort する。 |
| `git_push` | expected remote head を確認後に expected local branch head を push する。fast-forward-only のまま維持する。 |
| `git_push_force_with_lease` | exact に caller が観測した remote head lease を使い、`origin` の同名 branch を destructive に置き換える。 |
| `git_commit_range_validate` | exact linear `base..HEAD` range の各 commit に native `commit-msg` hook を実行する。 |
| `git_reword` | exact linear range を replacement message で再作成し、各 tree が不変であることを証明して current または new local branch に出力する。 |
| `git_commit_amend` | owned stage session と guarded worktree snapshot だけで current unsigned commit を置き換える。 |
| `git_operation_get` | request ID の durable result を読む。 |

## Typical workflow

まず `git_status` を呼びます。attached branch から branch を作成する場合は、その exact
name を `git_switch_create.expected_branch` に渡します。`git_status` が `branch: null` を
返した場合は `expected_branch: null` を渡し、その exact detached `HEAD` を precondition
として branch を作成します。その後、commit に含める paths だけを明示して `git_add` を
呼び、最後に `git_commit` を呼びます。remote 作業では `git_fetch` の後に `git_merge` を
呼びます。merge が conflicts を返した場合は listed paths を解決して `git_add` を呼び、
`git_merge_continue` を呼びます。declared merge を取りやめる必要がある場合だけ
`git_merge_abort` を使います。request 後に transport が中断した場合は、同じ request ID
で `git_operation_get` を使い durable result を replay し、mutation を繰り返しません。

managed worktree を既存の claimed local branch に attach する場合は、まず `git_status` で
`branch: null` を確認します。`git_switch_attach` には exact に `repository`、新しい
`request_id`、`expected_branch: null`、返された full `expected_head`、local `branch`
name、その full `expected_branch_head` を渡します。target branch は存在し、その expected
および observed HEAD が detached worktree HEAD と同一で、別 worktree に checkout されて
いない必要があります。current operation state は `none`、index と untracked paths を含む
complete worktree は clean、active bridge session は存在しない必要があります。

## Guarded history recovery の例

以下の object ID はすべて full object ID、`request_id` はすべて固定の example UUID です。
repository path、ID、branch、message、request ID は trusted repository で観測した値に置き換えます。
実装 source commit では `pnpm install --frozen-lockfile && pnpm build` を実行し、absolute
`dist/cli.js` command を維持してから、MCP server と client session を restart して新しい tool を再検出させます。

最初に exact current range を validate します。validation は range の各 commit に対して順に
repository の native `commit-msg` hook を実行します。

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

current-branch route では complete ordered range を reword し、直前に観測した remote
head を使って separate destructive delivery tool を呼びます。force permission は caller approval policy
であり、client または user は tool を authorize できますが、bridge が remote commits を
discard する判断を行うことはありません。exact remote CAS は mandatory です。provider または
branch protection が update を reject することはあります。

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

replacement-branch route では original branch を変更せずに new local branch を作成して switch
します。その branch は normal `git_push` で push できます。git_push は fast-forward-only のまま
であり、published history を置き換えません。

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

current commit だけを amend するには、先に `git_add` で normal stage session を作成し、その
exact stage と snapshot ID を保持してから呼びます。

```json
{
  "tool": "git_commit_amend",
  "arguments": {
    "repository": "/absolute/path/to/repository",
    "request_id": "018f47d2-7b2a-7d75-b9dd-5ea8abca0105",
    "expected_branch": "feature/history-example",
    "expected_head": "2222222222222222222222222222222222222222",
    "stage_id": "stage-example-20260801",
    "worktree_snapshot_id": "snapshot-example-20260801",
    "message": "fix(history): amend the owned staged change"
  }
}
```

signed source commits は reject され、signing は `disabled_by_policy` のままです。
commit messages は durable request records で redacted されますが、original message は replay 用
request hash に含まれます。native `commit-msg`、`pre-commit`、reference-transaction、pre-push
hooks は enabled のままで、hook rejection は redacted な `HOOK_FAILED` result です。既存の
git_push は fast-forward-only のままで backward compatibility を維持します。この追加は unreleased
であり、この source change から npm release、tag、`latest` availability を推測しないでください。

## Safety boundaries

trusted repositories だけで使ってください。inputs は明示的な repository-relative paths
で、mutations には expected branch と HEAD preconditions が必要です。null の expected
`git_switch_create` は detached `HEAD` から branch を作成するため null expected branch を
受け付けます。`git_switch_attach` は literal null expected branch を必須とし、attached
starting state を受け付けません。ほかの mutations には attached branch name が必要です。
attach は branch 作成、reset、force、remote access、dirty state の stash、arbitrary ref
を一切許さず、mutation は native `git switch --no-guess <branch>` だけです。native hooks は enabled
であり repository-controlled code を実行することがあります。commits は
`--no-gpg-sign` を使います。server は hooks を bypass しません。destructive restore、
merge-abort、merge、push は承認前に確認してください。

server は、同じ OS user として動く意図的に悪意のある hooks に対する isolation
boundary ではありません。hook failure redaction は trusted repositories のための
bounded result contract であり、敵対的な hook code の sandbox ではありません。

native `pre-commit` または `commit-msg` hook が commit を拒否した場合、
`git_commit` は `status: "failed"` と `error.code: "HOOK_FAILED"` を返します。
固定 error が含む hook 情報は `error.details.hook` のみで、値は `pre-commit` または
`commit-msg` に allowlist されています。hook の raw stdout / stderr、exit status、
file content は operation result に返さず、永続化もしません。commit HEAD は変わらず、
stage session は修正後の retry に再利用できます。hook が拒否前に index を変更した場合は、
既存の index guard が exact stage-session state を復元するまで retry を拒否します。

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
