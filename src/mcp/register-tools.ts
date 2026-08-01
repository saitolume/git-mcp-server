import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { BridgeResult } from "../domain/result.js";
import type { BridgeService } from "../app/bridge-service.js";
import type { OperationProgress, OperationProgressPhase } from "../app/mutation-coordinator.js";
import { TOOL_CATALOG } from "./tool-catalog.js";

export interface ToolRegistrationOptions {
  readonly activeOperations?: Set<AbortController>;
}

type ToolResult = BridgeResult<unknown>;

function protocolResult(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(result.status === "failed" || result.status === "rejected" || result.status === "indeterminate"
      ? { isError: true }
      : {}),
  };
}

function progressToken(context: ServerContext): string | number | undefined {
  const token = context.mcpReq._meta?.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

async function progress(context: ServerContext, phase: OperationProgressPhase): Promise<void> {
  const token = progressToken(context);
  if (token === undefined) return;
  const value = phase === "preflight" ? 0 : phase === "executing" ? 1 : 2;
  await context.mcpReq.notify({
    method: "notifications/progress",
    params: { progressToken: token, progress: value, total: 2, message: phase },
  });
}

async function invoke<T>(
  context: ServerContext,
  active: Set<AbortController>,
  operation: (signal: AbortSignal, progress: OperationProgress) => Promise<BridgeResult<T>>,
): Promise<ReturnType<typeof protocolResult>> {
  const shutdown = new AbortController();
  active.add(shutdown);
  const signal = AbortSignal.any([context.mcpReq.signal, shutdown.signal]);
  try {
    const result = await operation(signal, (phase) => progress(context, phase));
    return protocolResult(result);
  } finally {
    active.delete(shutdown);
  }
}

export function registerTools(
  server: McpServer,
  service: BridgeService,
  options: ToolRegistrationOptions = {},
): Set<AbortController> {
  const active = options.activeOperations ?? new Set<AbortController>();

  server.registerTool("git_status", TOOL_CATALOG.git_status, (input, context) =>
    invoke(context, active, (signal, report) => service.git_status(input, signal, report)));
  server.registerTool("git_diff", TOOL_CATALOG.git_diff, (input, context) =>
    invoke(context, active, (signal, report) => service.git_diff(input, signal, report)));
  server.registerTool("git_switch_create", TOOL_CATALOG.git_switch_create, (input, context) =>
    invoke(context, active, (signal, report) => service.git_switch_create(input, signal, report)));
  server.registerTool("git_switch_attach", TOOL_CATALOG.git_switch_attach, (input, context) =>
    invoke(context, active, (signal, report) => service.git_switch_attach(input, signal, report)));
  server.registerTool("git_add", TOOL_CATALOG.git_add, (input, context) =>
    invoke(context, active, (signal, report) => service.git_add(input, signal, report)));
  server.registerTool("git_restore_staged", TOOL_CATALOG.git_restore_staged, (input, context) =>
    invoke(context, active, (signal, report) => service.git_restore_staged(input, signal, report)));
  server.registerTool("git_restore_worktree", TOOL_CATALOG.git_restore_worktree, (input, context) =>
    invoke(context, active, (signal, report) => service.git_restore_worktree(input, signal, report)));
  server.registerTool("git_commit", TOOL_CATALOG.git_commit, (input, context) =>
    invoke(context, active, (signal, report) => service.git_commit(input, signal, report)));
  server.registerTool("git_fetch", TOOL_CATALOG.git_fetch, (input, context) =>
    invoke(context, active, (signal, report) => service.git_fetch(input, signal, report)));
  server.registerTool("git_merge", TOOL_CATALOG.git_merge, (input, context) =>
    invoke(context, active, (signal, report) => service.git_merge(input, signal, report)));
  server.registerTool("git_merge_continue", TOOL_CATALOG.git_merge_continue, (input, context) =>
    invoke(context, active, (signal, report) => service.git_merge_continue(input, signal, report)));
  server.registerTool("git_merge_abort", TOOL_CATALOG.git_merge_abort, (input, context) =>
    invoke(context, active, (signal, report) => service.git_merge_abort(input, signal, report)));
  server.registerTool("git_push", TOOL_CATALOG.git_push, (input, context) =>
    invoke(context, active, (signal, report) => service.git_push(input, signal, report)));
  server.registerTool("git_commit_range_validate", TOOL_CATALOG.git_commit_range_validate, (input, context) =>
    invoke(context, active, (signal, report) => service.git_commit_range_validate(input, signal, report)));
  server.registerTool("git_operation_get", TOOL_CATALOG.git_operation_get, (input, context) =>
    invoke(context, active, (signal, report) => service.git_operation_get(input, signal, report)));

  return active;
}
