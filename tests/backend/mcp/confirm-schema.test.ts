import { afterEach, describe, expect, it } from "vitest";
import manifest from "../../../manifest.json";
import { startPlugin, type PluginHarness } from "../helpers/plugin.js";
import {
  handleMcp,
  MCP_CONFIRM_REQUIRED,
  MCP_CONFIRM_REQUIRED_KINDS,
  toolName,
} from "../../../src/backend/mcp/server.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("MCP tools that need confirmed: true", () => {
  it("declare confirmed in their advertised input schema", async () => {
    harness = await startPlugin();
    const answer = await handleMcp(harness.mock.ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (
      answer?.result as {
        tools: {
          name: string;
          inputSchema: { properties: Record<string, unknown> };
        }[];
      }
    ).tools;
    const needing = [
      ...manifest.contributes.operations.actions
        .filter((a) => a.risk === "destructive")
        .map((a) => a.id),
      ...MCP_CONFIRM_REQUIRED,
      ...Object.keys(MCP_CONFIRM_REQUIRED_KINDS),
    ];
    expect(needing).toEqual(
      expect.arrayContaining(["coolify.exec", "coolify.companion"]),
    );
    for (const id of new Set(needing)) {
      const tool = tools.find((t) => t.name === toolName(id));
      expect(tool, id).toBeDefined();
      expect(tool!.inputSchema.properties.confirmed, id).toMatchObject({
        type: "boolean",
      });
    }
  });
});
