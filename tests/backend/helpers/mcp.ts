import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { handleMcp } from "../../../src/backend/mcp/server.js";

export type Run = (
  actionId: string,
  options?: PluginOperationInvokeOptions,
) => Promise<PluginOperationOutcome>;

/** The plugin's ctx with ctx.operations.run answered by `run`, as core's gate would. */
export function withRun(ctx: PluginContext, run: Run): PluginContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "operations") return { ...target.operations, run };
      return Reflect.get(target, prop);
    },
  });
}

/** One MCP tools/call and its result. */
export async function callTool(
  ctx: PluginContext,
  name: string,
  args: Record<string, unknown>,
) {
  const answer = await handleMcp(ctx, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return answer?.result as { isError: boolean; content: { text: string }[] };
}
