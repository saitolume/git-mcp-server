import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";
import { repositoryRoot } from "./package-test-utils.js";

const requiredFiles = [
  "LICENSE",
  "README.md",
  "README.ja.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/acceptance/provider-checklist.md",
];

const expectedTools = [
  "git_status",
  "git_diff",
  "git_switch_create",
  "git_add",
  "git_restore_staged",
  "git_restore_worktree",
  "git_commit",
  "git_fetch",
  "git_merge",
  "git_merge_continue",
  "git_merge_abort",
  "git_push",
  "git_operation_get",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localMarkdownLinks(markdown: string): readonly string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1])
    .filter((target): target is string => target !== undefined && !/^(?:https?:|#)/.test(target));
}

function documentedTools(readme: string): readonly string[] {
  return [...readme.matchAll(/^\| `(git_[^`]+)` \|/gm)].map((match) => match[1] ?? "");
}

test("public documentation provides the published user contract", async () => {
  for (const path of requiredFiles) assert.ok(existsSync(resolve(repositoryRoot, path)), `missing required public file: ${path}`);

  const [license, englishReadme, japaneseReadme, security, architecture] = await Promise.all([
    readFile(resolve(repositoryRoot, "LICENSE"), "utf8"),
    readFile(resolve(repositoryRoot, "README.md"), "utf8"),
    readFile(resolve(repositoryRoot, "README.ja.md"), "utf8"),
    readFile(resolve(repositoryRoot, "SECURITY.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/architecture.md"), "utf8"),
  ]);

  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 saitolume\n/);
  assert.match(englishReadme, /Clone this repository, then[\s\S]*pnpm install --frozen-lockfile/);
  assert.match(japaneseReadme, /このリポジトリを clone してから[\s\S]*pnpm install --frozen-lockfile/);
  for (const readme of [englishReadme, japaneseReadme]) {
    for (const required of [
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "node /absolute/path/dist/cli.js",
      "npx --yes @saitolume/git-mcp-server@beta",
      "@saitolume/git-mcp-server",
      "0.1.0-beta.1",
      "latest",
      "git_operation_get",
      "pnpm@11.15.1",
      "22.13",
      "Private Vulnerability Reporting",
    ]) assert.match(readme, new RegExp(escapeRegExp(required)));
    for (const retiredName of [
      ["Agent", "Git", "Bridge"].join(" "),
      ["agent", "git", "bridge"].join("-"),
    ]) assert.equal(readme.includes(retiredName), false);
  }
  assert.deepEqual(documentedTools(englishReadme), expectedTools);
  assert.deepEqual(documentedTools(japaneseReadme), expectedTools);
  assert.match(security, /latest commit on `main`/i);
  assert.match(security, /Private Vulnerability Reporting/);
  assert.match(architecture, /```mermaid[\s\S]*stdio MCP[\s\S]*native Git[\s\S]*durable journal/);
});

test("relative links in public documentation resolve within the repository", async () => {
  if (requiredFiles.some((path) => !existsSync(resolve(repositoryRoot, path)))) return;
  for (const path of ["README.md", "README.ja.md", "SECURITY.md", "docs/architecture.md"]) {
    const markdown = await readFile(resolve(repositoryRoot, path), "utf8");
    for (const target of localMarkdownLinks(markdown)) {
      const pathname = target.split("#", 1)[0] ?? "";
      assert.notEqual(extname(pathname), ".", `invalid link target in ${path}: ${target}`);
      assert.ok(existsSync(resolve(repositoryRoot, dirname(path), pathname)), `broken relative link in ${path}: ${target}`);
    }
  }
});
