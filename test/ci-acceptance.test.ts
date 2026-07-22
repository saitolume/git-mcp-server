import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot } from "./package-test-utils.js";

async function optionalText(path: string): Promise<string> {
  try {
    return await readFile(join(repositoryRoot, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

test("CI uses the pnpm-only supported runtime matrix", async () => {
  const workflow = await optionalText(".github/workflows/ci.yml");
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  for (const required of [
    "pnpm/action-setup@v6",
    "pnpm install --frozen-lockfile",
    "pnpm check:git-version",
    "pnpm check:runtime-dependencies",
    "pnpm check",
    "pnpm pack --dry-run",
    "pnpm test:package-install",
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(workflow, /\bnpm (?:ci|install|run|test|pack)\b/);
  assert.match(workflow, /os:\s*\[ubuntu-latest, macos-latest\]/);
  assert.match(workflow, /node:\s*\[22\.13\.1, 24\]/);

  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["@modelcontextprotocol/server", "zod"]);
  assert.equal(manifest.scripts?.test?.includes("package-install"), false);
  assert.equal(manifest.scripts?.check?.includes("package-install"), false);
  assert.equal(manifest.scripts?.prepack?.includes("npm pack"), false);
});

test("installed-package integration requires a real isolated MCP stdio smoke", async () => {
  const integration = await optionalText("test/package-install.integration.ts");
  for (const required of [
    "StdioClientTransport",
    "new Client",
    "listTools",
    "git_status",
    "annotations",
    "cwd: workspace.install",
    "delete environment.NODE_PATH",
  ]) assert.ok(integration.includes(required), `package integration is missing ${required}`);
});

test("provider checklist documents a provider-neutral source-build acceptance route", async () => {
  const checklist = await optionalText("docs/acceptance/provider-checklist.md");
  for (const required of [
    "Clone this source",
    "pnpm install --frozen-lockfile",
    "pnpm build",
    "dist/cli.js",
    "git_status",
    "git_operation_get",
  ]) assert.ok(checklist.includes(required), `checklist is missing: ${required}`);
  assert.match(checklist, /dedicated non-production fixture repository/i);
  assert.match(checklist, /does not require provider-specific package installation/i);
});

test("README states beta availability and separates stable-release gates", async () => {
  const readme = await optionalText("README.md");
  assert.match(readme, /docs\/acceptance\/provider-checklist\.md/);
  assert.match(readme, /Git 2\.39\.0 or later/);
  assert.match(readme, /@saitolume\/git-mcp-server/);
  assert.match(readme, /0\.1\.0-beta\.1/);
  assert.match(readme, /latest[^.]*not available/i);
  for (const gate of [
    "exact stable MCP SDK",
    "provider acceptance",
    "hosted CI evidence",
  ]) assert.ok(readme.includes(gate), `README is missing stable-release gate: ${gate}`);
});

test("README documents explicit operations, replay recovery, and trusted-repository boundaries", async () => {
  const readme = await optionalText("README.md");
  assert.match(readme, /explicitly call `git_add`/i);
  assert.match(readme, /git_operation_get[^\n]*durable result/i);
  assert.match(readme, /trusted repositories/i);
  assert.match(readme, /Native hooks are\s+enabled/i);
  assert.match(readme, /--no-gpg-sign/);
});
