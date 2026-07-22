import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  absoluteRepositoryPath, gitAddInput, gitOutputPath, gitPushInput, gitRestoreWorktreeInput,
  gitSwitchCreateInput, originRemoteRef, relativeGitPath,
} from "../src/domain/inputs.js";
import { redactDiagnostic } from "../src/domain/redaction.js";
import { BRIDGE_ERROR_CODES, commitDataSchema, statusDataSchema, switchCreateDataSchema } from "../src/domain/result.js";
import { TOOL_CATALOG, TOOL_NAMES } from "../src/mcp/tool-catalog.js";

const EXPECTED_TOOL_NAMES = [
  "git_status", "git_diff", "git_switch_create", "git_add",
  "git_restore_staged", "git_restore_worktree", "git_commit", "git_fetch",
  "git_merge", "git_merge_continue", "git_merge_abort", "git_push",
  "git_operation_get",
] as const;
type ExpectedToolName = (typeof EXPECTED_TOOL_NAMES)[number];
const expectedCatalog = TOOL_CATALOG as unknown as Record<ExpectedToolName, {
  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  outputSchema: { safeParse: unknown };
}>;

test("the catalog contains the approved 13 Git tools", () => {
  assert.deepEqual(TOOL_NAMES, EXPECTED_TOOL_NAMES);
});

test("every tool declares complete annotations", () => {
  for (const name of EXPECTED_TOOL_NAMES) {
    const tool = expectedCatalog[name];
    assert.equal(typeof tool.title, "string");
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.idempotentHint, "boolean");
    assert.equal(typeof tool.annotations.openWorldHint, "boolean");
    assert.equal(typeof tool.outputSchema.safeParse, "function");
  }
});

const DESCRIPTION_FRAGMENTS: Readonly<Record<ExpectedToolName, readonly string[]>> = {
  git_status: ["repository_id", "worktree_snapshot_id", "read-only"],
  git_diff: ["max_bytes", "1000000", "omitted paths", "read-only"],
  git_switch_create: ["exact expected HEAD", "expected_branch", "null", "detached HEAD", "existing branch", "force"],
  git_add: ["stage_id", "merge_session_id", "directories", "globs"],
  git_restore_staged: ["stage_id", "remaining", "worktree", "unowned"],
  git_restore_worktree: ["current index", "snapshot guard", "worktree_snapshot_id", "untracked"],
  git_commit: ["commit", "tree", "hook_changed_paths", "amend"],
  git_fetch: ["fetch_id", "origin", "tags", "submodules"],
  git_merge: ["fetch_id", "merge_session_id", "rebase", "arbitrary"],
  git_merge_continue: ["merge_session_id", "commit", "external"],
  git_merge_abort: ["merge_session_id", "head", "external"],
  git_push: ["local_head", "remote_head", "non-fast-forward", "delete"],
  git_operation_get: ["request_id", "stored terminal result", "Git", "retry"],
};

test("every catalog description states operation, returns, defaults, and material exclusions", () => {
  for (const name of EXPECTED_TOOL_NAMES) {
    const description = expectedCatalog[name].description;
    for (const heading of ["Operation:", "Returns:", "Defaults:", "Excludes:"]) {
      assert.ok(description.includes(heading), `${name} is missing ${heading}`);
    }
    for (const fragment of DESCRIPTION_FRAGMENTS[name]) {
      assert.ok(description.includes(fragment), `${name} is missing ${fragment}`);
    }
    if (name !== "git_operation_get") {
      assert.ok(description.includes("repository_id"), `${name} is missing its returned repository_id`);
    }
    if (!expectedCatalog[name].annotations.readOnlyHint) {
      assert.ok(description.includes("request_id"), `${name} is missing its returned request_id`);
    }
  }
});

test("restore worktree description names the current index as source after snapshot guard validation", () => {
  const description = TOOL_CATALOG.git_restore_worktree.description;
  assert.match(description, /current index.*snapshot guard|snapshot guard.*current index/i);
  assert.doesNotMatch(description, /from a recorded snapshot/i);
});

test("operation lookup description matches its real lifecycle progress", () => {
  const description = expectedCatalog.git_operation_get.description;
  assert.doesNotMatch(description, /Excludes:[^.]*live progress/i);
  assert.match(description, /repository lock/i);
});

interface JsonSchemaNode {
  readonly type?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchemaNode;
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly allOf?: readonly JsonSchemaNode[];
  readonly $defs?: Readonly<Record<string, JsonSchemaNode>>;
  readonly definitions?: Readonly<Record<string, JsonSchemaNode>>;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly pattern?: string;
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly additionalProperties?: boolean;
}

function hasGeneratedConstraint(schema: JsonSchemaNode): boolean {
  return schema.enum !== undefined || schema.const !== undefined || schema.pattern !== undefined
    || schema.format !== undefined || schema.minLength !== undefined || schema.maxLength !== undefined
    || schema.minimum !== undefined || schema.maximum !== undefined || schema.minItems !== undefined
    || (schema.items !== undefined && hasGeneratedConstraint(schema.items))
    || (schema.anyOf?.some(hasGeneratedConstraint) ?? false)
    || (schema.oneOf?.some(hasGeneratedConstraint) ?? false)
    || (schema.allOf?.some(hasGeneratedConstraint) ?? false);
}

function assertGeneratedFieldMetadata(schema: JsonSchemaNode, path: string): number {
  let visited = 0;
  if (schema.properties !== undefined) {
    const required = new Set(schema.required ?? []);
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      const fieldPath = `${path}.${field}`;
      visited += 1;
      assert.ok(property.description?.trim(), `${fieldPath} needs a purpose description`);
      assert.ok(hasGeneratedConstraint(property), `${fieldPath} needs a generated constraint`);
      if (!required.has(field)) {
        assert.ok(Object.hasOwn(property, "default") || /omit|optional/i.test(property.description ?? ""),
          `${fieldPath} needs an omission/default contract`);
      }
      visited += assertGeneratedFieldMetadata(property, fieldPath);
    }
  }
  if (schema.items !== undefined) visited += assertGeneratedFieldMetadata(schema.items, `${path}[]`);
  for (const [keyword, branches] of [
    ["anyOf", schema.anyOf], ["oneOf", schema.oneOf], ["allOf", schema.allOf],
  ] as const) {
    branches?.forEach((branch, index) => {
      visited += assertGeneratedFieldMetadata(branch, `${path}.${keyword}[${index}]`);
    });
  }
  for (const [keyword, definitions] of [["$defs", schema.$defs], ["definitions", schema.definitions]] as const) {
    for (const [name, definition] of Object.entries(definitions ?? {})) {
      visited += assertGeneratedFieldMetadata(definition, `${path}.${keyword}.${name}`);
    }
  }
  return visited;
}

test("every generated input schema field recursively has purpose, constraints, and omission metadata", () => {
  for (const name of TOOL_NAMES) {
    const schema = z.toJSONSchema(TOOL_CATALOG[name].inputSchema) as JsonSchemaNode;
    assert.equal(schema.additionalProperties, false, `${name} must remain strict`);
    assert.ok(assertGeneratedFieldMetadata(schema, name) > 0, `${name} must expose input fields`);
  }
});

test("generated metadata assertion reaches fields nested under items and combinators", () => {
  const malformed: JsonSchemaNode = {
    type: "object", additionalProperties: false, required: ["outer"],
    properties: {
      outer: {
        type: "array", description: "Outer records.", minItems: 1,
        items: {
          oneOf: [{
            type: "object", additionalProperties: false, required: ["inner"],
            properties: { inner: { type: "string", pattern: "^safe$" } },
          }],
        },
      },
    },
  };
  assert.throws(() => assertGeneratedFieldMetadata(malformed, "fixture"),
    /fixture\.outer\[\]\.oneOf\[0\]\.inner needs a purpose description/);
});

test("git diff generated schema publishes its exact optional defaults", () => {
  const schema = z.toJSONSchema(TOOL_CATALOG.git_diff.inputSchema) as JsonSchemaNode;
  assert.deepEqual(schema.properties?.paths?.default, []);
  assert.equal(schema.properties?.max_bytes?.default, 1_000_000);
});

test("mutation schemas reject unknown fields and unsafe paths", () => {
  assert.equal(gitAddInput.safeParse({
    repository: "/repo", request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0001",
    expected_branch: "main", expected_head: "a".repeat(40), paths: ["../secret"], extra: true,
  }).success, false);
  assert.equal(gitRestoreWorktreeInput.safeParse({
    repository: "/repo", request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0002",
    expected_branch: "main", expected_head: "a".repeat(40), worktree_snapshot_id: "b".repeat(64), paths: ["."],
  }).success, false);
  assert.equal(gitPushInput.safeParse({
    repository: "/repo", request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0003",
    expected_branch: "main", expected_head: "a".repeat(40), expected_remote_head: null,
  }).success, true);
  assert.equal(gitAddInput.safeParse({
    repository: "/repo", request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0004",
    expected_branch: "main", expected_head: "a".repeat(40), paths: ["src/index.ts"], extra: true,
  }).success, false);
  assert.equal(gitAddInput.safeParse({
    repository: "/repo", request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0005",
    expected_branch: "main", expected_head: "a".repeat(40), paths: ["src/index.ts"],
    stage_id: "stage", merge_session_id: "merge",
  }).success, false);
});

test("only switch create accepts null as the exact detached HEAD branch precondition", () => {
  const base = {
    repository: "/repo",
    request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0006",
    expected_branch: null,
    expected_head: "a".repeat(40),
  };
  assert.equal(gitSwitchCreateInput.safeParse({ ...base, branch: "topic/detached" }).success, true);
  assert.equal(gitAddInput.safeParse({ ...base, paths: ["src/index.ts"] }).success, false);

  const schema = z.toJSONSchema(TOOL_CATALOG.git_switch_create.inputSchema) as JsonSchemaNode;
  assert.match(schema.properties?.expected_branch?.description ?? "", /null.*detached HEAD|detached HEAD.*null/i);
});

test("Git output paths allow legal pathspec-looking names without weakening mutation inputs", () => {
  for (const path of ["hook*.txt", "hook?.txt", "hook[1].txt", ":hook.txt", "hook\\name.txt"]) {
    assert.equal(gitOutputPath.safeParse(path).success, true, path);
    assert.equal(relativeGitPath.safeParse(path).success, false, path);
  }
  for (const path of ["", ".", "../x", "x/../y", "/absolute", "bad\0path", "bad�path"]) {
    assert.equal(gitOutputPath.safeParse(path).success, false, path);
  }
  assert.equal(commitDataSchema.safeParse({
    commit: "a".repeat(40), tree: "b".repeat(40),
    hook_changed_paths: [":hook.txt", "dir:name/file.ts"], signing: "disabled_by_policy",
  }).success, true);
  assert.ok(BRIDGE_ERROR_CODES.includes("GIT_FAILED"));
});

test("every Git-bound path and ref schema rejects ambiguous Unicode while preserving astral text", () => {
  const malformed = ["bad\uFFFDname", "bad\uD800name", "bad\uDC00name"];
  for (const value of malformed) {
    assert.equal(absoluteRepositoryPath.safeParse(`/repo/${value}`).success, false, `repository ${value}`);
    assert.equal(relativeGitPath.safeParse(`src/${value}`).success, false, `input path ${value}`);
    assert.equal(gitOutputPath.safeParse(`src/${value}`).success, false, `output path ${value}`);
    assert.equal(originRemoteRef.safeParse(`refs/remotes/origin/${value}`).success, false, `origin ref ${value}`);
    assert.equal(gitAddInput.safeParse({
      repository: "/repo", request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0090",
      expected_branch: value, expected_head: "a".repeat(40), paths: ["src/a.ts"],
    }).success, false, `expected branch ${value}`);
    assert.equal(gitSwitchCreateInput.safeParse({
      repository: "/repo", request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0091",
      expected_branch: "main", expected_head: "a".repeat(40), branch: value,
    }).success, false, `new branch ${value}`);
  }

  const astral = "😀";
  assert.equal(absoluteRepositoryPath.safeParse(`/repo/${astral}`).success, true);
  assert.equal(relativeGitPath.safeParse(`src/${astral}.ts`).success, true);
  assert.equal(gitOutputPath.safeParse(`src/${astral}.ts`).success, true);
  assert.equal(originRemoteRef.safeParse(`refs/remotes/origin/${astral}`).success, true);
  assert.equal(gitSwitchCreateInput.safeParse({
    repository: `/repo/${astral}`, request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0092",
    expected_branch: `topic/${astral}`, expected_head: "a".repeat(40), branch: `next/${astral}`,
  }).success, true);
});

test("status data uses the fixed strict entry wire contract", () => {
  const valid = {
    repository_id: "repo", root: "/repo", git_dir: "/repo/.git", common_git_dir: "/repo/.git",
    branch: "main", head: "a".repeat(40), head_tree: "b".repeat(40), index_tree: "c".repeat(64),
    operation_state: "clean", worktree_snapshot_id: "d".repeat(64),
    entries: [{ path: "src/index.ts", index: " ", worktree: "M", kind: "ordinary" }],
  };
  assert.equal(statusDataSchema.safeParse(valid).success, true);
  assert.equal(statusDataSchema.safeParse({ ...valid, entries: [{ ...valid.entries[0], extra: true }] }).success, false);
  assert.equal(statusDataSchema.safeParse({ ...valid, branch: "bad\uD800branch" }).success, false);
  assert.equal(switchCreateDataSchema.safeParse({ branch: "bad\uFFFDbranch", head: "a".repeat(40) }).success, false);
});

test("diagnostics redact URL credentials and common secret assignments", () => {
  const raw = "https://alice:secret@example.com/repo.git token=abc password=hunter2 Authorization: Bearer credential";
  const redacted = redactDiagnostic(raw);
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.includes("abc"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("credential"), false);
  assert.match(redacted, /https:\/\/example\.com\/repo\.git/);
});

test("diagnostics redact SSH URL userinfo", () => {
  const redacted = redactDiagnostic("ssh://user:secret@example.com/org/repo.git");
  assert.equal(redacted.includes("user"), false);
  assert.equal(redacted.includes("secret"), false);
  assert.match(redacted, /ssh:\/\/example\.com\/org\/repo\.git/);
});

test("diagnostic byte limits do not split UTF-8 characters", () => {
  const redacted = redactDiagnostic("ééé", 5);
  assert.equal(redacted, "éé");
  assert.ok(Buffer.byteLength(redacted, "utf8") <= 5);
});
