import assert from "node:assert/strict";
import test from "node:test";
import {
  isOperationDeadlineExceeded,
  operationTimeoutMs,
  remainingDeadlineTimeoutMs,
  throwIfDeadlineExceeded,
  withDeadline,
  withReconciliationDeadline,
} from "../src/deadline.js";
import { classifyOperationError } from "../src/app/bridge-service.js";

test("operation classes expose absolute whole-operation budgets", () => {
  assert.equal(operationTimeoutMs("git_status"), 30_000);
  assert.equal(operationTimeoutMs("git_diff"), 30_000);
  assert.equal(operationTimeoutMs("git_operation_get"), 30_000);
  assert.equal(operationTimeoutMs("git_add"), 60_000);
  assert.equal(operationTimeoutMs("git_restore_staged"), 60_000);
  assert.equal(operationTimeoutMs("git_restore_worktree"), 60_000);
  assert.equal(operationTimeoutMs("git_switch_create"), 60_000);
  assert.equal(operationTimeoutMs("git_switch_attach"), 60_000);
  assert.equal(operationTimeoutMs("git_commit"), 600_000);
  assert.equal(operationTimeoutMs("git_commit_range_validate"), 600_000);
  assert.equal(operationTimeoutMs("git_reword"), 600_000);
  assert.equal(operationTimeoutMs("git_commit_amend"), 600_000);
  assert.equal(operationTimeoutMs("git_merge"), 600_000);
  assert.equal(operationTimeoutMs("git_merge_continue"), 600_000);
  assert.equal(operationTimeoutMs("git_merge_abort"), 600_000);
  assert.equal(operationTimeoutMs("git_fetch"), 300_000);
  assert.equal(operationTimeoutMs("git_push"), 300_000);
});

test("one absolute deadline shrinks every later child budget", async () => {
  let now = 1_000;
  await withDeadline(60_000, undefined, async () => {
    assert.equal(remainingDeadlineTimeoutMs(30_000), 30_000);
    now += 45_000;
    assert.equal(remainingDeadlineTimeoutMs(30_000), 15_000);
    now += 15_001;
    assert.equal(remainingDeadlineTimeoutMs(30_000), 0);
    assert.throws(() => throwIfDeadlineExceeded(), /deadline|timed out/i);
  }, { monotonicNow: () => now });
});

test("post-mutation reconciliation replaces an expired operation deadline with its own safety budget", async () => {
  let now = 10_000;
  await withDeadline(1, undefined, async () => {
    now += 2;
    assert.throws(() => throwIfDeadlineExceeded(), /deadline|timed out/i);
    await withReconciliationDeadline(async (signal) => {
      assert.equal(signal.aborted, false);
      assert.equal(remainingDeadlineTimeoutMs(99_999), 30_000);
      now += 12_345;
      assert.equal(remainingDeadlineTimeoutMs(99_999), 17_655);
    }, { monotonicNow: () => now });
  }, { monotonicNow: () => now });
});

test("generic failures observed after operation expiry classify uniformly as redacted Git timeouts", async () => {
  let now = 1_000;
  const operations = [
    "git_status", "git_diff", "git_operation_get", "git_add", "git_restore_staged",
    "git_restore_worktree", "git_switch_create", "git_switch_attach", "git_commit", "git_commit_range_validate", "git_reword", "git_commit_amend", "git_merge",
    "git_merge_continue", "git_merge_abort", "git_fetch", "git_push",
  ];

  await withDeadline(10, undefined, async () => {
    now += 11;
    assert.equal(isOperationDeadlineExceeded(new Error("private preflight detail")), true);
    for (const operation of operations) {
      const result = classifyOperationError(operation, new Error("private preflight detail"));
      assert.equal(result.status, "failed");
      assert.equal(result.operation, operation);
      assert.equal(result.error?.code, "GIT_TIMEOUT");
      assert.equal(result.error?.message, "The absolute operation deadline expired");
      assert.doesNotMatch(JSON.stringify(result), /private preflight detail/);
    }
  }, { monotonicNow: () => now });
});
