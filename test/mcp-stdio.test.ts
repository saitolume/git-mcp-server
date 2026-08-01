import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { OperationJournal } from "../src/state/journal.js";
import { initializeStatePaths, type StatePaths } from "../src/state/paths.js";

const EXPECTED_TOOLS = [
  ["git_status", "git-mcp-server: Git status", { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ["git_diff", "git-mcp-server: Git diff", { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ["git_switch_create", "git-mcp-server: Create branch", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ["git_switch_attach", "git-mcp-server: Attach branch", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ["git_add", "git-mcp-server: Stage paths", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ["git_restore_staged", "git-mcp-server: Restore staged paths", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ["git_restore_worktree", "git-mcp-server: Restore worktree paths", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ["git_commit", "git-mcp-server: Commit staged changes", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ["git_fetch", "git-mcp-server: Fetch remote", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
  ["git_merge", "git-mcp-server: Merge remote ref", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ["git_merge_continue", "git-mcp-server: Continue merge", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ["git_merge_abort", "git-mcp-server: Abort merge", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ["git_push", "git-mcp-server: Push branch", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
  ["git_push_force_with_lease", "git-mcp-server: Force push with lease", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
  ["git_commit_range_validate", "git-mcp-server: Validate commit range", { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
  ["git_reword", "git-mcp-server: Reword commit range", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ["git_commit_amend", "git-mcp-server: Amend staged changes", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ["git_operation_get", "git-mcp-server: Get operation", { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
] as const;

interface ConnectedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stderr: string[];
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function repositoryFixture(directory: string): Promise<{ repository: string; head: string }> {
  const repository = join(directory, "repository");
  await mkdir(repository);
  run("git", ["init", "-b", "main"], repository);
  run("git", ["config", "user.name", "MCP Test"], repository);
  run("git", ["config", "user.email", "mcp@example.invalid"], repository);
  run("git", ["config", "commit.gpgsign", "false"], repository);
  await writeFile(join(repository, "tracked.txt"), "initial\n", "utf8");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "a.ts"), "export const a = 1;\n", "utf8");
  run("git", ["add", "tracked.txt", "src/a.ts"], repository);
  run("git", ["commit", "-m", "initial"], repository);
  return { repository, head: run("git", ["rev-parse", "HEAD"], repository) };
}

async function connect(root: string, env: NodeJS.ProcessEnv = process.env): Promise<ConnectedClient> {
  const stderr: string[] = [];
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), ".test-dist", "src", "cli.js")],
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries({ ...env, HOME: home, XDG_STATE_HOME: join(root, "state") })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "mcp-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`MCP client connection failed; server stderr: ${stderr.join("")}`, { cause: error });
  }
  return { client, transport, stderr };
}

function stateRoot(root: string): string {
  const home = join(root, "home");
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "git-mcp-server")
    : join(root, "state", "git-mcp-server");
}

function testStatePaths(root: string): StatePaths {
  const state = stateRoot(root);
  return {
    root: state,
    locks: join(state, "locks"),
    repositories: join(state, "repositories"),
    operations: join(state, "operations"),
    stages: join(state, "stages"),
    fetches: join(state, "fetches"),
    merges: join(state, "merges"),
    audit: join(state, "audit"),
  };
}

function structuredResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

test("MCP stdio progress and schema register all Git tools and serve structured status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-mcp-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixture = await repositoryFixture(root);
  const paths = await initializeStatePaths(testStatePaths(root));
  const journal = new OperationJournal(paths);
  const repositoryId = "a".repeat(64);
  const startedId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0020";
  const conflictedId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0021";
  await journal.begin({ requestId: startedId, operation: "git_fetch", repositoryId, input: { repository: fixture.repository } });
  await journal.begin({ requestId: conflictedId, operation: "git_merge", repositoryId, input: { repository: fixture.repository } });
  await journal.complete(conflictedId, {
    status: "conflicted", request_id: conflictedId, repository_id: repositoryId, operation: "git_merge", warnings: [],
    data: { head: fixture.head, merge_session_id: "merge-1", conflicted_paths: ["src/a.ts"] },
  });
  const operations = paths.operations;
  await writeFile(join(operations, "corrupt-entry"), "not an operation directory\n", "utf8");
  const connected = await connect(root);
  t.after(async () => connected.client.close());

  const listed = await connected.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), EXPECTED_TOOLS.map(([name]) => name));
  for (const [index, tool] of listed.tools.entries()) {
    const expected = EXPECTED_TOOLS[index]!;
    assert.deepEqual(tool.annotations, expected[2]);
    assert.equal(tool.title, expected[1]);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
    const inputProperties = (tool.inputSchema.properties ?? {}) as Record<string, {
      readonly description?: unknown;
      readonly default?: unknown;
    }>;
    for (const [field, property] of Object.entries(inputProperties)) {
      assert.ok(typeof property.description === "string" && property.description.trim().length > 0,
        `${tool.name}.${field} lacks a field description`);
    }
    if (tool.name === "git_diff") {
      assert.deepEqual(inputProperties.paths?.default, []);
      assert.equal(inputProperties.max_bytes?.default, 1_000_000);
    }
  }

  const phases: string[] = [];
  const status = await connected.client.callTool(
    { name: "git_status", arguments: { repository: fixture.repository } },
    { onprogress: (notification) => { if (notification.message !== undefined) phases.push(notification.message); } },
  );
  const statusContent = status.structuredContent as {
    status?: string;
    operation?: string;
    data?: { head?: string };
  } | undefined;
  assert.notEqual(status.isError, true);
  assert.equal(statusContent?.status, "succeeded");
  assert.equal(statusContent?.operation, "git_status");
  assert.equal(statusContent?.data?.head, fixture.head);
  assert.deepEqual(status.content, [{ type: "text", text: JSON.stringify(status.structuredContent) }]);
  assert.deepEqual(phases, ["preflight", "executing", "postflight"]);
  assert.match(connected.stderr.join(""), /corrupt state for corrupt-entry/);
  assert.match(connected.stderr.join(""), new RegExp(`Recovered interrupted operation ${startedId}`));

  const recovered = await connected.client.callTool({ name: "git_operation_get", arguments: { request_id: startedId } });
  assert.equal(recovered.isError, true);
  assert.equal(structuredResult(recovered).status, "indeterminate");
  const conflicted = await connected.client.callTool({ name: "git_operation_get", arguments: { request_id: conflictedId } });
  assert.notEqual(conflicted.isError, true);
  assert.equal(structuredResult(conflicted).status, "conflicted");

  const invalid = await connected.client.callTool({
    name: "git_add",
    arguments: {
      repository: fixture.repository,
      request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0001",
      expected_branch: "main",
      expected_head: fixture.head,
      paths: ["../outside"],
    },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  assert.match(JSON.stringify(invalid.content), /invalid|path/i);

  for (const [index, path] of ["bad\uFFFD.txt", "bad\uD800.txt"].entries()) {
    const malformedUnicode = await connected.client.callTool({
      name: "git_add",
      arguments: {
        repository: fixture.repository,
        request_id: `018f47d2-7b2a-7d75-b9dd-5ea8abca009${index}`,
        expected_branch: "main",
        expected_head: fixture.head,
        paths: [path],
      },
    });
    assert.equal(malformedUnicode.isError, true);
    assert.equal(malformedUnicode.structuredContent, undefined);
    assert.match(JSON.stringify(malformedUnicode.content), /invalid|path|unicode/i);
  }

  await writeFile(join(fixture.repository, "src", "a.ts"), "export const a = 2;\n", "utf8");
  const semanticFailures = [
    ["018f47d2-7b2a-7d75-b9dd-5ea8abca0030", { paths: ["src"] }, "INVALID_INPUT"],
    ["018f47d2-7b2a-7d75-b9dd-5ea8abca0031", { paths: ["src/a.ts"], stage_id: "missing" }, "SESSION_NOT_FOUND"],
  ] as const;
  for (const [index, [requestId, extras, code]] of semanticFailures.entries()) {
    const semanticPhases: string[] = [];
    const result = await connected.client.callTool({
      name: "git_add",
      arguments: { repository: fixture.repository, request_id: requestId, expected_branch: "main", expected_head: fixture.head, ...extras },
    }, index === 0 ? {
      onprogress: (notification) => { if (notification.message !== undefined) semanticPhases.push(notification.message); },
    } : undefined);
    assert.equal(result.isError, true);
    assert.equal(structuredResult(result).status, "rejected");
    assert.equal((structuredResult(result).error as { code?: string } | undefined)?.code, code);
    if (index === 0) assert.deepEqual(semanticPhases, ["preflight"]);
    const replay = await connected.client.callTool({ name: "git_operation_get", arguments: { request_id: requestId } });
    assert.equal(structuredResult(replay).status, "rejected");
  }

  const addId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0032";
  const added = await connected.client.callTool({
    name: "git_add",
    arguments: { repository: fixture.repository, request_id: addId, expected_branch: "main", expected_head: fixture.head, paths: ["src/a.ts"] },
  });
  assert.notEqual(added.isError, true, JSON.stringify(added));
  assert.equal(structuredResult(added).status, "succeeded");
  const stageId = ((structuredResult(added).data as { stage_id?: string } | undefined)?.stage_id);
  assert.ok(stageId);
  const storedAdd = await connected.client.callTool({ name: "git_operation_get", arguments: { request_id: addId } });
  assert.deepEqual(storedAdd.structuredContent, added.structuredContent);

  await writeFile(join(fixture.repository, "tracked.txt"), "changed\n", "utf8");
  const indexFailureId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0033";
  const indexFailure = await connected.client.callTool({
    name: "git_add",
    arguments: { repository: fixture.repository, request_id: indexFailureId, expected_branch: "main", expected_head: fixture.head, paths: ["tracked.txt"] },
  });
  assert.equal(structuredResult(indexFailure).status, "rejected");
  assert.equal((structuredResult(indexFailure).error as { code?: string } | undefined)?.code, "INDEX_NOT_EMPTY");

  const additional = await connected.client.callTool({
    name: "git_add",
    arguments: {
      repository: fixture.repository, request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0034",
      expected_branch: "main", expected_head: fixture.head, paths: ["tracked.txt"], stage_id: stageId,
    },
  });
  assert.equal(structuredResult(additional).status, "succeeded");

  const badRestoreId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0035";
  const badRestore = await connected.client.callTool({
    name: "git_restore_staged",
    arguments: {
      repository: fixture.repository, request_id: badRestoreId, expected_branch: "main", expected_head: fixture.head,
      stage_id: "missing", paths: ["src/a.ts"],
    },
  });
  assert.equal(structuredResult(badRestore).status, "rejected");
  assert.equal((structuredResult(badRestore).error as { code?: string } | undefined)?.code, "SESSION_NOT_FOUND");
  const restored = await connected.client.callTool({
    name: "git_restore_staged",
    arguments: {
      repository: fixture.repository, request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0036",
      expected_branch: "main", expected_head: fixture.head, stage_id: stageId, paths: ["src/a.ts", "tracked.txt"],
    },
  });
  assert.equal(structuredResult(restored).status, "succeeded");
  await writeFile(join(fixture.repository, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(fixture.repository, "tracked.txt"), "initial\n", "utf8");

  const badSwitchId = "018f47d2-7b2a-7d75-b9dd-5ea8abca0037";
  const badSwitch = await connected.client.callTool({
    name: "git_switch_create",
    arguments: {
      repository: fixture.repository, request_id: badSwitchId, expected_branch: "main", expected_head: fixture.head, branch: "bad..branch",
    },
  });
  assert.equal(structuredResult(badSwitch).status, "rejected");
  assert.equal((structuredResult(badSwitch).error as { code?: string } | undefined)?.code, "INVALID_INPUT");
  const switched = await connected.client.callTool({
    name: "git_switch_create",
    arguments: {
      repository: fixture.repository, request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0038",
      expected_branch: "main", expected_head: fixture.head, branch: "topic/mcp",
    },
  });
  assert.equal(structuredResult(switched).status, "succeeded");

  run("git", ["branch", "claimed/mcp"], fixture.repository);
  run("git", ["checkout", "--detach"], fixture.repository);
  const attached = await connected.client.callTool({
    name: "git_switch_attach",
    arguments: {
      repository: fixture.repository,
      request_id: "018f47d2-7b2a-7d75-b9dd-5ea8abca0039",
      expected_branch: null,
      expected_head: fixture.head,
      branch: "claimed/mcp",
      expected_branch_head: fixture.head,
    },
  });
  assert.equal(structuredResult(attached).status, "succeeded");
  assert.deepEqual(structuredResult(attached).data, { branch: "claimed/mcp", head: fixture.head });
});

test("MCP stdio cancellation aborts a long-running Git process without corrupting stdout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-cancel-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixture = await repositoryFixture(root);
  const fakeBin = join(root, "fake-bin");
  const marker = join(root, "git-started");
  await mkdir(fakeBin);
  const fakeGit = join(fakeBin, "git");
  await writeFile(fakeGit, `#!/bin/sh\n: > '${marker}'\ntrap 'exit 143' TERM INT\nwhile :; do sleep 1; done\n`, "utf8");
  await chmod(fakeGit, 0o755);

  const systemPath = process.env.PATH ?? "/usr/bin:/bin";
  const connected = await connect(root, { ...process.env, PATH: `${fakeBin}${delimiter}${systemPath}` });
  t.after(async () => connected.client.close());
  const controller = new AbortController();
  const call = connected.client.callTool(
    { name: "git_status", arguments: { repository: fixture.repository } },
    { signal: controller.signal, timeout: 10_000 },
  );
  let started = false;
  // Keep this below the 10-second tool timeout while tolerating full-suite process contention.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { await readFile(marker); started = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal(started, true, "fake Git process did not start before cancellation");
  controller.abort();
  await assert.rejects(call, /abort/i);
  await connected.client.ping();
  assert.deepEqual((await connected.client.listTools()).tools.map((tool) => tool.name), EXPECTED_TOOLS.map(([name]) => name));
  assert.equal(connected.stderr.join("").includes("git-started"), false);
});
