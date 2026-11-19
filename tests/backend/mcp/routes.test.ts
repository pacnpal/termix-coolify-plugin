import { afterEach, describe, expect, it } from "vitest";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { startPlugin, type PluginHarness } from "../helpers/plugin.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(permissions?: string[]) {
  const fake = healthyCoolify();
  harness = await startPlugin({ fetch: fake.fetch, permissions });
  return harness;
}

describe("MCP routes", () => {
  it("POST /mcp answers one JSON-RPC message", async () => {
    const h = await start();
    const answer = await h.request("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "termix-coolify" } },
    });
  });

  it("POST /mcp answers a batch, leaving out notifications", async () => {
    const h = await start();
    const answer = await h.request("POST", "/mcp", [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "nope" },
    ]);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32601, message: expect.any(String) },
      },
    ]);
  });

  it("POST /mcp with only notifications answers 202 with no body", async () => {
    const h = await start();
    const answer = await h.request("POST", "/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(answer.status).toBe(202);
    expect(answer.body).toBeNull();
  });

  it("GET /mcp answers the endpoint and a client config with a placeholder key", async () => {
    const h = await start();
    const answer = await h.request("GET", "/mcp");
    expect(answer.status).toBe(200);
    const endpoint = "https://termix.test/plugin-api/coolify/mcp";
    expect(answer.body).toEqual({
      endpoint,
      example: {
        mcpServers: {
          "termix-coolify": {
            url: endpoint,
            headers: { Authorization: "Bearer <your Termix API key>" },
          },
        },
      },
    });
  });

  it("both routes refuse without coolify.mcp (403)", async () => {
    const h = await start([
      "coolify.view",
      "coolify.operate",
      "coolify.configure",
      "coolify.administer",
    ]);
    expect((await h.request("GET", "/mcp")).status).toBe(403);
    expect(
      (
        await h.request("POST", "/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
        })
      ).status,
    ).toBe(403);
  });

  it("both routes answer with only coolify.mcp", async () => {
    const h = await start(["coolify.mcp"]);
    expect((await h.request("GET", "/mcp")).status).toBe(200);
    expect(
      (
        await h.request("POST", "/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
        })
      ).status,
    ).toBe(200);
  });
});
