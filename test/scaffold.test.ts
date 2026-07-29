import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PRODUCT } from "../src/product.js";

const projectRoot = process.cwd();

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? listFiles(join(directory, entry.name))
    : [join(directory, entry.name)]));
  return files.flat();
}

test("product metadata is centralized", () => {
  assert.deepEqual(PRODUCT, {
    id: "git-mcp-server",
    displayName: "git-mcp-server",
    serverName: "git-mcp-server",
    version: "0.1.0-beta.3",
  });
});

test("production and public tests contain no retired product names", async () => {
  const retiredNames = [
    ["Agent", "Git", "Bridge"].join(" "),
    ["agent", "git", "bridge"].join("-"),
    ["bridge", "operation", "get"].join("_"),
  ];
  const roots = ["src", "test"];
  for (const root of roots) {
    for (const file of await listFiles(join(projectRoot, root))) {
      const text = await readFile(file, "utf8");
      for (const retiredName of retiredNames) assert.equal(text.includes(retiredName), false, file);
    }
  }
});

test("operation timeouts match the approved policy", async () => {
  const { OPERATION_TIMEOUT_MS } = await import("../src/product.js");
  assert.deepEqual(OPERATION_TIMEOUT_MS, {
    read: 30_000, stage: 60_000, commit: 600_000, merge: 600_000,
    remote: 300_000, reconcile: 30_000, terminateGrace: 5_000, lockWait: 30_000,
  });
});

test("compiled CLI prints only the version for --version", () => {
  const result = spawnSync(process.execPath, [".test-dist/src/cli.js", "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0.1.0-beta.3\n");
  assert.equal(result.stderr, "");
});
