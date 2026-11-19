import { describe, expect, it } from "vitest";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import {
  CoolifyError,
  type CoolifyTarget,
} from "../../../src/backend/coolify/http.js";
import {
  MAX_METRIC_MINUTES,
  createCoolifyMcp,
} from "../../../src/backend/coolify/mcp.js";

const TOKEN = "fake-token-for-mcp-tests";

const target: CoolifyTarget = {
  baseUrl: "https://coolify.example.test",
  token: TOKEN,
  cfAccess: null,
  allowPrivate: false,
  caCert: null,
};

interface Call {
  url: string;
  init: PluginFetchInit | undefined;
  body: Record<string, any>;
}

function rpcResult(result: unknown, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function toolText(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError,
  };
}

function scripted(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const call = {
      url,
      init,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any>,
    };
    calls.push(call);
    return answer(call);
  };
  return { fetch, calls };
}

async function caught(promise: Promise<unknown>): Promise<CoolifyError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CoolifyError) return err;
    throw err;
  }
  throw new Error("expected a CoolifyError");
}

describe("Coolify MCP client", () => {
  it("calls tools/call and unwraps data", async () => {
    const { fetch, calls } = scripted(() =>
      rpcResult(toolText({ success: true, data: { servers: 2 } })),
    );
    const mcp = createCoolifyMcp(fetch, target);
    const data = await mcp.call<{ servers: number }>(
      "get_infrastructure_overview",
      {},
    );
    expect(data).toEqual({ servers: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://coolify.example.test/mcp");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.redirect).toBe("manual");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.accept).toContain("application/json");
    expect(calls[0].body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "get_infrastructure_overview", arguments: {} },
    });
    expect(typeof calls[0].body.id).toBe("number");
  });

  it("reads a streamable HTTP answer sent as server-sent events", async () => {
    const { fetch } = scripted(
      () =>
        new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: toolText({ data: { ok: true } }),
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const mcp = createCoolifyMcp(fetch, target);
    expect(await mcp.call("x", {})).toEqual({ ok: true });
  });

  it("isError becomes CoolifyError upstream, with no text from Coolify", async () => {
    const { fetch } = scripted(() =>
      rpcResult(toolText({ error: `leaked ${TOKEN}` }, true)),
    );
    const err = await caught(
      createCoolifyMcp(fetch, target).call("get_server_metrics", {}),
    );
    expect(err.cause).toBe("upstream");
    expect(err.message).not.toContain(TOKEN);
  });

  it("404 means unavailable", async () => {
    const { fetch } = scripted(
      () => new Response("Not Found", { status: 404 }),
    );
    expect(await createCoolifyMcp(fetch, target).available()).toBe(false);
  });

  it("403 means unavailable", async () => {
    const { fetch } = scripted(
      () =>
        new Response(JSON.stringify({ message: "MCP is disabled" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await createCoolifyMcp(fetch, target).available()).toBe(false);
  });

  it("is available when tools/list answers", async () => {
    const { fetch, calls } = scripted(() => rpcResult({ tools: [] }));
    expect(await createCoolifyMcp(fetch, target).available()).toBe(true);
    expect(calls[0].body.method).toBe("tools/list");
  });

  it("minutes is clamped to 43200", async () => {
    const { fetch, calls } = scripted(() =>
      rpcResult(
        toolText({
          data: {
            minutes: 43200,
            bucket_seconds: 7200,
            current: {
              cpu_percent: 12.5,
              memory_used_bytes: 1024,
              load1: null,
            },
            series: {
              cpu_percent: [
                [1700000000000, 10],
                [1700000060000, 12.5],
              ],
              memory_used_bytes: [
                [1700000000000, 1024],
                ["bad", 1],
              ],
            },
          },
        }),
      ),
    );
    const mcp = createCoolifyMcp(fetch, target);
    expect(MAX_METRIC_MINUTES).toBe(43200);
    const metrics = await mcp.serverMetrics("srv-vps1-uuid", 999_999);
    expect(calls[0].body.params).toEqual({
      name: "get_server_metrics",
      arguments: { server_uuid: "srv-vps1-uuid", minutes: 43200 },
    });
    expect(metrics).toEqual({
      current: { cpu_percent: 12.5, memory_used_bytes: 1024 },
      series: {
        cpu_percent: [
          [1700000000000, 10],
          [1700000060000, 12.5],
        ],
        memory_used_bytes: [[1700000000000, 1024]],
      },
      bucketSeconds: 7200,
    });
    await mcp.serverMetrics("srv-vps1-uuid", 0);
    expect(calls[1].body.params.arguments.minutes).toBe(1);
  });
});
