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

Do not use a repository with valuable uncommitted changes. Keep credentials,
tokens, and private remote URLs out of the acceptance record.
