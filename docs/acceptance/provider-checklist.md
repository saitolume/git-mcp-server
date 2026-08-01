# Provider acceptance checklist

Use this manual checklist with a dedicated non-production fixture repository.
It verifies a provider's MCP approval boundary; it does not require provider-specific package installation.

1. Clone this source into a local checkout and record its commit SHA.
2. Run `pnpm install --frozen-lockfile` with pnpm 11.15.1, then run
   `pnpm build` with Node.js >=22.13.
3. Configure the provider to start `node` with the absolute path to this
   checkout's `dist/cli.js`. Do not rely on a registry package.
4. In the provider, call `git_status` for the fixture repository and retain
   its branch and HEAD preconditions.
5. Exercise an explicit non-production mutation only after the provider has
   approved repository and state-directory access. Preserve redacted request
   and result evidence.
6. Simulate or observe an interrupted request, then call `git_operation_get`
   with the original request ID. Verify that it returns the durable terminal
   result without resubmitting the mutation.
7. Record provider name and version, OS, Node.js and Git versions, fixture
   path, MCP configuration, redacted evidence, and pass/fail conclusion.

For guarded history recovery, retain the exact `git_status` branch and HEAD
evidence and use only full object IDs:

1. Call `git_commit_range_validate` for an exact linear `base..HEAD` range
   before proposing any reword.
2. Exercise the current-branch route only after the provider presents a
   separate destructive approval for `git_reword` followed by
   `git_push_force_with_lease`. Force permission is a caller approval policy;
   exact remote CAS is mandatory and provider or branch protection may reject
   the update.
3. Exercise the replacement branch route with `git_reword` using
   `destination.mode: "new_branch"`, then ordinary `git_push`. This keeps the
   original branch unchanged and `git_push` remains fast-forward-only.
4. If validating amend approval, call `git_commit_amend` only with a normal
   `git_add` stage session and its exact worktree snapshot ID.
5. Confirm the provider displays the four tools as distinct approvals; signed
   source commits must reject, messages and hook diagnostics must be redacted,
   and native hooks and signing policy must remain visible as enabled and
   `disabled_by_policy` respectively.

After changing a source build, run `pnpm install --frozen-lockfile && pnpm build`
and restart both the MCP server and provider client session before checking tool
discovery. These are source-build acceptance steps only: they do not release,
tag, publish, or make `latest` available.

Do not use a repository with valuable uncommitted changes. Keep credentials,
tokens, and private remote URLs out of the acceptance record.
