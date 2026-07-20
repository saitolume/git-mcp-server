export const PRODUCT = Object.freeze({
  id: "git-mcp-server",
  displayName: "git-mcp-server",
  serverName: "git-mcp-server",
  version: "0.0.0-development",
});

export const OPERATION_TIMEOUT_MS = Object.freeze({
  read: 30_000,
  stage: 60_000,
  commit: 600_000,
  merge: 600_000,
  remote: 300_000,
  reconcile: 30_000,
  terminateGrace: 5_000,
  lockWait: 30_000,
});
