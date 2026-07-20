import assert from "node:assert/strict";
import test from "node:test";
import { listOriginRefs } from "../src/git/remote.js";
import { readIndexStageMap } from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";

const COMPLETE_MAP_RECORD_LIMIT = 16 * 1024;
const objectId = "a".repeat(40);

function result(stdout: string): GitCommandResult {
  return {
    exitCode: 0, signal: null, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, aborted: false, durationMs: 0,
  };
}

class RecordingRunner extends GitRunner {
  readonly commands: GitCommand[] = [];

  constructor(private readonly output: string) {
    super(process.execPath, process.env);
  }

  override async run(command: GitCommand): Promise<GitCommandResult> {
    this.commands.push(command);
    return result(this.output);
  }
}

function largeIndexOutput(): string {
  return Array.from({ length: 12_000 }, (_, index) => {
    const path = `src/${String(index).padStart(6, "0")}-${"x".repeat(64)}.ts`;
    return `100644 ${objectId} 0\t${path}\0`;
  }).join("");
}

function largeOriginRefsOutput(): string {
  return Array.from({ length: 10_000 }, (_, index) => {
    const ref = `refs/remotes/origin/branch-${String(index).padStart(6, "0")}-${"x".repeat(64)}`;
    return `${ref}\0${objectId}\n`;
  }).join("");
}

test("complete index proof accepts a valid map larger than the legacy 1 MiB cap", async () => {
  const output = largeIndexOutput();
  assert.ok(Buffer.byteLength(output) > 1_000_000);
  const runner = new RecordingRunner(output);

  const map = await readIndexStageMap(runner, "/repo");

  assert.match(map.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(map.stageZeroTreeFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(map.hasUnmergedEntries, false);
  assert.equal(typeof runner.commands[0]?.stdoutConsumer, "function");
  assert.ok(runner.commands[0]!.maxOutputBytes < Buffer.byteLength(output));
});

test("complete origin ref proof accepts a valid map larger than the legacy 1 MiB cap", async () => {
  const output = largeOriginRefsOutput();
  assert.ok(Buffer.byteLength(output) > 1_000_000);
  const runner = new RecordingRunner(output);

  const refs = await listOriginRefs(runner, "/repo");

  assert.equal(Object.keys(refs).length, 10_000);
  assert.equal(typeof runner.commands[0]?.stdoutConsumer, "function");
  assert.ok(runner.commands[0]!.maxOutputBytes < Buffer.byteLength(output));
});

test("complete index proof enforces the documented per-record byte boundary", async () => {
  const prefix = `100644 ${objectId} 0\t`;
  const exactPath = "p".repeat(COMPLETE_MAP_RECORD_LIMIT - Buffer.byteLength(prefix));
  const exact = await readIndexStageMap(new RecordingRunner(`${prefix}${exactPath}\0`), "/repo");
  assert.match(exact.fingerprint, /^[0-9a-f]{64}$/);

  const oversized = new RecordingRunner(`${prefix}${exactPath}x\0`);
  await assert.rejects(readIndexStageMap(oversized, "/repo"), /malformed Git output/i);
});
