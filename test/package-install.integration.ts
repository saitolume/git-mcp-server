import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createPackageWorkspace,
  packPackage,
  removePackageWorkspace,
  repositoryRoot,
  runPnpm,
} from "./package-test-utils.js";

const EXPECTED_TOOLS = [
  "git_status", "git_diff", "git_switch_create", "git_switch_attach", "git_add",
  "git_restore_staged", "git_restore_worktree", "git_commit", "git_fetch",
  "git_merge", "git_merge_continue", "git_merge_abort", "git_push",
  "git_push_force_with_lease",
  "git_commit_range_validate",
  "git_reword", "git_commit_amend",
  "git_operation_get",
] as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const DESTRUCTIVE = { ...MUTATION, destructiveHint: true } as const;
const OPEN_WORLD = { ...MUTATION, openWorldHint: true } as const;
const DESTRUCTIVE_OPEN_WORLD = { ...DESTRUCTIVE, openWorldHint: true } as const;
interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}
const EXPECTED_ANNOTATIONS: Record<(typeof EXPECTED_TOOLS)[number], ToolAnnotations> = {
  git_status: READ_ONLY,
  git_diff: READ_ONLY,
  git_switch_create: MUTATION,
  git_switch_attach: MUTATION,
  git_add: MUTATION,
  git_restore_staged: DESTRUCTIVE,
  git_restore_worktree: DESTRUCTIVE,
  git_commit: MUTATION,
  git_fetch: OPEN_WORLD,
  git_merge: DESTRUCTIVE,
  git_merge_continue: DESTRUCTIVE,
  git_merge_abort: DESTRUCTIVE,
  git_push: OPEN_WORLD,
  git_push_force_with_lease: DESTRUCTIVE_OPEN_WORLD,
  git_commit_range_validate: MUTATION,
  git_reword: DESTRUCTIVE,
  git_commit_amend: DESTRUCTIVE,
  git_operation_get: READ_ONLY,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("opt-in package install discovers every guarded-recovery tool without forcing the fixture repository", async (t) => {
  const workspace = await createPackageWorkspace();
  t.after(async () => removePackageWorkspace(workspace));
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { version: string };
  const packed = packPackage(workspace);

  await writeFile(join(workspace.install, "package.json"), JSON.stringify({ private: true }), "utf8");
  runPnpm(workspace, ["add", "--ignore-scripts", "--save-exact", packed.tarball], workspace.install);
  assert.deepEqual(workspace.pnpmCommands, [
    ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", workspace.tarballs],
    ["add", "--ignore-scripts", "--save-exact", packed.tarball],
  ]);
  const installed = join(workspace.install, "node_modules", "@saitolume", "git-mcp-server");
  const resolved = await realpath(installed);
  assert.match(resolved, new RegExp(`^${escapeRegExp(workspace.root)}(?:/|$)`));
  assert.doesNotMatch(resolved, new RegExp(`^${escapeRegExp(repositoryRoot)}(?:/|$)`));
  const binary = join(workspace.install, "node_modules", ".bin", "git-mcp-server");
  await access(binary);
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  const version = spawnSync(binary, ["--version"], { cwd: workspace.install, encoding: "utf8", env: environment });
  assert.equal(version.status, 0, `installed git-mcp-server --version failed: ${version.stderr}`);
  assert.equal(version.stdout.trim(), manifest.version);

  const fixture = join(workspace.install, "fixture");
  const home = join(workspace.install, "home");
  const state = join(workspace.install, "state");
  await Promise.all([mkdir(fixture), mkdir(home), mkdir(state)]);
  git(["init", "-b", "main"], fixture);
  git(["config", "user.name", "Package Test"], fixture);
  git(["config", "user.email", "package-test@example.invalid"], fixture);
  await writeFile(join(fixture, "tracked.txt"), "installed package fixture\n", "utf8");
  git(["add", "tracked.txt"], fixture);
  git(["commit", "--no-gpg-sign", "-m", "initial"], fixture);
  const head = git(["rev-parse", "HEAD"], fixture);

  environment.HOME = home;
  environment.XDG_STATE_HOME = state;
  const transport = new StdioClientTransport({
    command: binary,
    args: [],
    cwd: workspace.install,
    env: Object.fromEntries(Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: "pipe",
  });
  const client = new Client({ name: "installed-package-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), EXPECTED_TOOLS);
    for (const tool of listed.tools) {
      assert.deepEqual(
        tool.annotations,
        EXPECTED_ANNOTATIONS[tool.name as (typeof EXPECTED_TOOLS)[number]],
      );
    }
    const status = await client.callTool({ name: "git_status", arguments: { repository: fixture } });
    assert.notEqual(status.isError, true, JSON.stringify(status));
    const structured = status.structuredContent as {
      status?: string;
      operation?: string;
      data?: { head?: string };
    } | undefined;
    assert.equal(structured?.status, "succeeded");
    assert.equal(structured?.operation, "git_status");
    assert.equal(structured?.data?.head, head);
  } finally {
    await client.close();
  }
});
