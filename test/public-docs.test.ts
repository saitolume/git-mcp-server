import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";
import {
  gitCommitAmendInput,
  gitCommitRangeValidateInput,
  gitPushForceWithLeaseInput,
  gitPushInput,
  gitRewordInput,
} from "../src/domain/inputs.js";
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
  "git_switch_attach",
  "git_add",
  "git_restore_staged",
  "git_restore_worktree",
  "git_commit",
  "git_fetch",
  "git_merge",
  "git_merge_continue",
  "git_merge_abort",
  "git_push",
  "git_push_force_with_lease",
  "git_commit_range_validate",
  "git_reword",
  "git_commit_amend",
  "git_operation_get",
];

const exampleRequestIds = [
  "018f47d2-7b2a-7d75-b9dd-5ea8abca0100",
  "018f47d2-7b2a-7d75-b9dd-5ea8abca0101",
  "018f47d2-7b2a-7d75-b9dd-5ea8abca0102",
  "018f47d2-7b2a-7d75-b9dd-5ea8abca0103",
  "018f47d2-7b2a-7d75-b9dd-5ea8abca0104",
  "018f47d2-7b2a-7d75-b9dd-5ea8abca0105",
] as const;
const exampleBase = "1111111111111111111111111111111111111111";
const exampleHead = "2222222222222222222222222222222222222222";
const exampleRewordedHead = "3333333333333333333333333333333333333333";

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

const guardedHistorySchemas = {
  git_commit_range_validate: gitCommitRangeValidateInput,
  git_reword: gitRewordInput,
  git_push_force_with_lease: gitPushForceWithLeaseInput,
  git_push: gitPushInput,
  git_commit_amend: gitCommitAmendInput,
} as const;

function guardedHistoryExamples(readme: string): readonly { tool: keyof typeof guardedHistorySchemas; arguments: unknown }[] {
  return [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1] ?? "") as { tool?: string; arguments?: unknown })
    .filter((example): example is { tool: keyof typeof guardedHistorySchemas; arguments: unknown } =>
      typeof example.tool === "string" && example.tool in guardedHistorySchemas,
    );
}

test("public documentation provides the published user contract", async () => {
  for (const path of requiredFiles) assert.ok(existsSync(resolve(repositoryRoot, path)), `missing required public file: ${path}`);

  const [license, englishReadme, japaneseReadme, security, architecture, providerChecklist] = await Promise.all([
    readFile(resolve(repositoryRoot, "LICENSE"), "utf8"),
    readFile(resolve(repositoryRoot, "README.md"), "utf8"),
    readFile(resolve(repositoryRoot, "README.ja.md"), "utf8"),
    readFile(resolve(repositoryRoot, "SECURITY.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/architecture.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/acceptance/provider-checklist.md"), "utf8"),
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
      "0.1.0-beta.3",
      "latest",
      "git_operation_get",
      "pnpm@11.15.1",
      "22.13",
      "Private Vulnerability Reporting",
      "git_switch_attach",
      "expected_branch_head",
      "restart",
    ]) assert.match(readme, new RegExp(escapeRegExp(required)));
    for (const retiredName of [
      ["Agent", "Git", "Bridge"].join(" "),
      ["agent", "git", "bridge"].join("-"),
    ]) assert.equal(readme.includes(retiredName), false);
  }
  assert.deepEqual(documentedTools(englishReadme), expectedTools);
  assert.deepEqual(documentedTools(japaneseReadme), expectedTools);
  for (const readme of [englishReadme, japaneseReadme]) {
    const examples = guardedHistoryExamples(readme);
    assert.equal(examples.length, 6);
    for (const example of examples) {
      assert.equal(guardedHistorySchemas[example.tool].safeParse(example.arguments).success, true, example.tool);
    }
  }
  for (const readme of [englishReadme, japaneseReadme]) {
    for (const required of [
      "HOOK_FAILED",
      "error.details.hook",
      "pre-commit",
      "commit-msg",
      "stdout",
      "stderr",
      "stage session",
    ]) assert.match(readme, new RegExp(escapeRegExp(required)));
    assert.match(readme, /exit\s+status/);
  }
  assert.match(security, /latest commit on `main`/i);
  assert.match(security, /Private Vulnerability Reporting/);
  assert.match(architecture, /```mermaid[\s\S]*stdio MCP[\s\S]*native Git[\s\S]*durable journal/);
  assert.match(architecture, /git_switch_attach[\s\S]*expected_branch_head[\s\S]*git switch --no-guess <branch>/);
  for (const document of [englishReadme, japaneseReadme]) {
    for (const requestId of exampleRequestIds) assert.match(document, new RegExp(escapeRegExp(requestId)));
    for (const objectId of [exampleBase, exampleHead, exampleRewordedHead]) {
      assert.match(document, new RegExp(escapeRegExp(objectId)));
    }
    for (const required of [
      "git_commit_range_validate",
      "git_reword",
      "git_push_force_with_lease",
      "git_commit_amend",
      '"mode": "current_branch"',
      '"mode": "new_branch"',
      '"expected_remote_head": "2222222222222222222222222222222222222222"',
      '"stage_id": "stage-example-20260801"',
      '"worktree_snapshot_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      "caller approval policy",
      "signed",
      "redacted",
      "fast-forward-only",
      "restart",
    ]) assert.match(document, new RegExp(escapeRegExp(required)));
  }
  for (const required of [
    "force permission is a caller approval policy",
    "exact remote CAS is mandatory",
    "signed source commits are rejected",
    "commit messages are redacted",
    "git_push remains fast-forward-only",
  ]) assert.match(englishReadme, new RegExp(escapeRegExp(required), "i"));
  for (const boundary of [
    /fresh observation[\s\S]{0,80}before delivery/i,
    /no automatic refresh or retry/i,
    /explicit human decision/i,
    /externally added[\s\S]{0,40}commit/i,
  ]) assert.match(englishReadme, boundary);
  for (const required of [
    "force permission は caller approval policy",
    "exact remote CAS は mandatory",
    "signed source commits は reject",
    "git_push は fast-forward-only のまま",
  ]) assert.match(japaneseReadme, new RegExp(escapeRegExp(required)));
  for (const boundary of [
    /delivery の直前に fresh observation/,
    /automatic refresh\/retry は行わず/,
    /explicit human decision/,
    /externally added commit/,
  ]) assert.match(japaneseReadme, boundary);
  assert.match(japaneseReadme, /commit messages[\s\S]{0,80}redacted/);
  for (const required of [
    "git_commit_range_validate",
    "git_reword",
    "git_push_force_with_lease",
    "git_commit_amend",
    "caller approval policy",
    "exact remote CAS",
    "signed",
    "redact",
    "fast-forward-only",
  ]) assert.match(architecture, new RegExp(escapeRegExp(required)));
  for (const required of [
    "git_commit_range_validate",
    "git_reword",
    "git_push_force_with_lease",
    "git_commit_amend",
    "replacement branch",
    "exact remote CAS",
  ]) assert.match(providerChecklist, new RegExp(escapeRegExp(required)));
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
