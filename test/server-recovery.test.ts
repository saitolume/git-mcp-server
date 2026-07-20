import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OperationJournal } from "../src/state/journal.js";
import { initializeStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RepositoryRegistry } from "../src/state/repository-registry.js";

const repositoryId = "7".repeat(64);
const objectId = "8".repeat(40);
const requestId = "startup-live-mutation";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for recovery test state");
    await delay(20);
  }
}

async function waitForMessage(
  child: ChildProcess,
  expectedKind: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child message: ${expectedKind}`));
    }, timeoutMs);
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Recovery owner exited before ${expectedKind}: ${String(code)}`));
    };
    const onMessage = (message: unknown): void => {
      if (message === null || typeof message !== "object" || Array.isArray(message)
        || (message as Record<string, unknown>).kind !== expectedKind) return;
      cleanup();
      resolve(message as Record<string, unknown>);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
  });
}

test("startup recovery waits for a live mutation and preserves its single terminal result", async (t) => {
  const home = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "git-mcp-server-server-recovery-")));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const xdgStateHome = join(home, "xdg-state");
  const paths = await initializeStatePaths(resolveStatePaths({
    platform: process.platform,
    homedir: home,
    env: { XDG_STATE_HOME: xdgStateHome },
  }));
  const repository = join(home, "repository");
  const gitDirectory = join(repository, ".git");
  await mkdir(gitDirectory, { recursive: true });
  await new RepositoryRegistry(paths).put({
    repositoryId,
    root: repository,
    gitDir: gitDirectory,
    commonGitDir: gitDirectory,
    lastSeenAt: "2026-07-19T00:00:00.000Z",
  });
  const sessionPath = join(paths.stages, "live-owner-session.json");
  await writeFile(sessionPath, "live session\n", { mode: 0o600 });

  const workerPath = fileURLToPath(new URL("./helpers/server-recovery-worker.js", import.meta.url));
  const encodedConfiguration = Buffer.from(JSON.stringify({
    paths, repository, repositoryId, requestId, sessionPath, objectId,
  }), "utf8").toString("base64url");
  const owner = fork(workerPath, [encodedConfiguration], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let ownerCompleted = false;
  t.after(async () => {
    if (!ownerCompleted && owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await once(owner, "exit").catch(() => undefined);
    }
  });
  await waitForMessage(owner, "ready");

  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const recoveryServer = spawn(process.execPath, [cliPath], {
    env: { ...process.env, HOME: home, XDG_STATE_HOME: xdgStateHome },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let serverExited = false;
  recoveryServer.once("exit", () => { serverExited = true; });
  t.after(async () => {
    if (!serverExited) {
      recoveryServer.kill("SIGTERM");
      await once(recoveryServer, "exit").catch(() => undefined);
    }
  });

  await delay(350);
  assert.equal(recoveryServer.exitCode, null, await readFile(sessionPath, "utf8"));
  assert.equal(await new OperationJournal(paths).get(requestId), null,
    "a second server published a terminal result while the live owner held the repository lock");
  assert.equal(await readFile(sessionPath, "utf8"), "live session\n");

  const completion = waitForMessage(owner, "completed");
  owner.send({ kind: "complete" });
  assert.equal((await completion).status, "succeeded");
  const [ownerExit] = await once(owner, "exit") as [number | null];
  ownerCompleted = true;
  assert.equal(ownerExit, 0);

  const journal = new OperationJournal(paths);
  await waitFor(async () => (await journal.get(requestId)) !== null);
  await waitFor(async () => (await readdir(paths.locks)).length === 0);
  const terminal = await journal.get(requestId);
  assert.equal(terminal?.result.status, "succeeded");
  assert.deepEqual(terminal?.result.data, { branch: "completed-by-live-owner", head: objectId });
  assert.deepEqual((await readdir(join(paths.operations, requestId))).sort(), ["request.json", "result.json", "started.json"]);
  await assert.rejects(readFile(sessionPath));
});
