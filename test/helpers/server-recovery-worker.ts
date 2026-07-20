import { unlink } from "node:fs/promises";
import { OperationJournal } from "../../src/state/journal.js";
import { initializeStatePaths, type StatePaths } from "../../src/state/paths.js";
import { RepositoryLock } from "../../src/state/repository-lock.js";

interface WorkerConfiguration {
  readonly paths: StatePaths;
  readonly repository: string;
  readonly repositoryId: string;
  readonly requestId: string;
  readonly sessionPath: string;
  readonly objectId: string;
}

interface WorkerCommand { readonly kind: "complete" }

function send(message: Readonly<Record<string, unknown>>): void {
  process.send?.(message);
}

const encoded = process.argv[2];
if (encoded === undefined) throw new Error("Recovery worker configuration is missing");
const configuration = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as WorkerConfiguration;
const paths = await initializeStatePaths(configuration.paths);
const journal = new OperationJournal(paths);
const lock = new RepositoryLock(paths);
const handle = await lock.acquire(configuration.repositoryId);

try {
  const begin = await journal.begin({
    requestId: configuration.requestId,
    operation: "git_switch_create",
    repositoryId: configuration.repositoryId,
    input: {
      repository: configuration.repository,
      request_id: configuration.requestId,
      expected_branch: "main",
      expected_head: configuration.objectId,
      branch: "completed-by-live-owner",
    },
  });
  if (begin.kind !== "execute") throw new Error(`Unexpected begin result: ${begin.kind}`);
  send({ kind: "ready" });
  await new Promise<void>((resolve) => {
    process.once("message", (message: WorkerCommand) => {
      if (message.kind === "complete") resolve();
    });
  });
  const result = await journal.complete(configuration.requestId, {
    status: "succeeded",
    request_id: configuration.requestId,
    repository_id: configuration.repositoryId,
    operation: "git_switch_create",
    data: { branch: "completed-by-live-owner", head: configuration.objectId },
    warnings: [],
  });
  await unlink(configuration.sessionPath);
  send({ kind: "completed", status: result.result.status });
} catch (error) {
  send({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await handle.release();
}
