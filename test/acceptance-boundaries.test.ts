import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { gitPushForceWithLeaseInput } from "../src/domain/inputs.js";
import { TOOL_CATALOG } from "../src/mcp/tool-catalog.js";
import { repositoryRoot } from "./package-test-utils.js";

const EXPECTED_DEPENDENCIES = {
  "@modelcontextprotocol/server": "2.0.0-beta.4",
  zod: "4.4.3",
};

test("force-with-lease is a separate destructive typed boundary", () => {
  const valid = {
    repository: "/repo",
    request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0150",
    expected_branch: "feature/history",
    expected_head: "b".repeat(40),
    expected_remote_head: "a".repeat(40),
  };
  assert.equal(gitPushForceWithLeaseInput.safeParse(valid).success, true);
  for (const extra of [
    { remote: "other" },
    { refspec: ":refs/heads/main" },
    { force: true },
    { delete: true },
    { tags: true },
    { args: ["--force"] },
  ]) {
    assert.equal(gitPushForceWithLeaseInput.safeParse({ ...valid, ...extra }).success, false);
  }
  assert.deepEqual(TOOL_CATALOG.git_push_force_with_lease.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(TOOL_CATALOG.git_push.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
});

function runNodeScript(script: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [join(repositoryRoot, "scripts", script), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
}

test("Git version gate rejects 2.38 and malformed output while accepting 2.39 and newer major versions", async (t) => {
  const cases = [
    ["git version 2.38.9", false, /Git 2\.39\.0 or later is required/],
    ["git version 2.39.0", true, /Git 2\.39\.0/],
    ["git version 3.1.4", true, /Git 3\.1\.4/],
    ["git version 2.39", false, /could not parse Git version/],
  ] as const;
  for (const [output, accepted, diagnostic] of cases) {
    await t.test(output, async () => {
      const root = await mkdtemp(join(tmpdir(), "git-mcp-server-git-version-"));
      t.after(async () => rm(root, { recursive: true, force: true }));
      const fakeBin = join(root, "bin");
      await mkdir(fakeBin);
      const fakeGit = join(fakeBin, "git");
      await writeFile(fakeGit, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
      await chmod(fakeGit, 0o755);
      const result = runNodeScript("check-git-version.mjs", [], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      });
      assert.equal(result.status === 0, accepted, result.stderr);
      assert.match(accepted ? result.stdout : result.stderr, diagnostic);
    });
  }
});

async function dependencyFixture(
  t: { after(fn: () => Promise<void>): void },
  manifestAdditions: Record<string, unknown>,
  source: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-dependency-policy-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    type: "module",
    dependencies: EXPECTED_DEPENDENCIES,
    ...manifestAdditions,
  }), "utf8");
  await writeFile(join(root, "src", "fixture.ts"), source, "utf8");
  return root;
}

test("runtime dependency policy accepts exact dependencies and supported TypeScript import forms", async (t) => {
  const root = await dependencyFixture(t, {}, `
    import "@modelcontextprotocol/server";
    export { z } from "zod";
    void import("zod/v4");
    require("@modelcontextprotocol/server/subpath");
    export * from "./relative.js";
    import "node:fs";
  `);
  const result = runNodeScript("check-runtime-dependencies.mjs", [root]);
  assert.equal(result.status, 0, result.stderr);
});

test("runtime dependency policy rejects optional, peer, and bundled dependency surfaces", async (t) => {
  const cases = [
    ["optionalDependencies", { optionalDependencies: { optional: "1.0.0" } }],
    ["peerDependencies", { peerDependencies: { peer: "1.0.0" } }],
    ["bundleDependencies", { bundleDependencies: ["zod"] }],
    ["bundledDependencies", { bundledDependencies: ["zod"] }],
  ] as const;
  for (const [field, addition] of cases) {
    await t.test(field, async () => {
      const root = await dependencyFixture(t, addition, "import 'zod';\n");
      const result = runNodeScript("check-runtime-dependencies.mjs", [root]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(field));
    });
  }
});

test("runtime dependency policy rejects a production import declared only as a dev dependency", async (t) => {
  const root = await dependencyFixture(
    t,
    { devDependencies: { "dev-only-runtime": "1.0.0", typescript: "7.0.2" } },
    'import value from "dev-only-runtime/subpath";\nvoid value;\n',
  );
  const result = runNodeScript("check-runtime-dependencies.mjs", [root]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dev-only-runtime.*not declared in dependencies/);
});
