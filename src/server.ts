import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createBridgeRuntime, type BridgeRuntime, type BridgeService } from "./app/bridge-service.js";
import { recoverStartedOperations } from "./app/startup-recovery.js";
import { registerTools } from "./mcp/register-tools.js";
import { PRODUCT } from "./product.js";

export interface ServerDependencies {
  readonly service: BridgeService;
  readonly activeOperations?: Set<AbortController>;
}

let defaultRuntime: Promise<BridgeRuntime> | undefined;

function lazyDefaultService(): BridgeService {
  return new Proxy({} as BridgeService, {
    get: (_target, property) => (...args: readonly unknown[]) => {
      defaultRuntime ??= createBridgeRuntime();
      return defaultRuntime.then((runtime) => {
        const method = Reflect.get(runtime.service, property) as (...values: readonly unknown[]) => unknown;
        return Reflect.apply(method, runtime.service, args);
      });
    },
  });
}

export function createServer(dependencies?: ServerDependencies): McpServer {
  const server = new McpServer({ name: PRODUCT.serverName, version: PRODUCT.version });
  const service = dependencies?.service ?? lazyDefaultService();
  registerTools(server, service, dependencies?.activeOperations === undefined
    ? {}
    : { activeOperations: dependencies.activeOperations });
  return server;
}

export async function runServer(): Promise<void> {
  const runtime = await createBridgeRuntime();
  const recovered = await recoverStartedOperations(runtime.journal, runtime.lock);
  for (const result of recovered) {
    const message = result.kind === "recovered"
      ? `Recovered interrupted operation ${result.requestId} as indeterminate`
      : result.kind === "terminal"
        ? `Operation ${result.requestId} completed before startup recovery acquired its lock`
        : result.kind === "deferred"
          ? `Operation recovery deferred for ${result.requestId}`
      : `Operation recovery found corrupt state for ${result.requestId}`;
    process.stderr.write(`${message}\n`);
    if ((result.kind === "recovered" || result.kind === "terminal") && result.warning !== undefined) {
      process.stderr.write(`Operation recovery completed with a lock-release warning for ${result.requestId}\n`);
    }
  }

  const activeOperations = new Set<AbortController>();
  const server = createServer({ service: runtime.service, activeOperations });
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    for (const operation of activeOperations) operation.abort();
    await server.close();
  };
  const onSignal = (): void => { void close(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await server.connect(transport);
  } catch (error) {
    process.stderr.write("git-mcp-server failed to start\n");
    throw error;
  }
}
