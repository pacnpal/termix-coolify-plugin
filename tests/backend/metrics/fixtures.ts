import { vi } from "vitest";
import type {
  PluginFetchInit,
  PluginSshExecResult,
} from "@termix-ssh/plugin-sdk/backend";
import { healthyCoolify, type FakeAnswer } from "../helpers/fake-coolify.js";
import { startPlugin, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";
import { HOST_ID, linkedHost } from "../containers/fixtures.js";

export { HOST_ID };

/** An application whose uuid Sentinel can be asked about (letters and digits). */
export const APP_UUID = "k8sappweb1";
/** A database: no traffic analytics. */
export const DB_UUID = "k8sdbmain1";
export const SERVER_UUID = "srv-vps1-uuid";
const BASE = "https://coolify.example.test";

export interface MetricsOptions {
  /** Coolify's MCP endpoint answers (tools/list and get_server_metrics). */
  mcp?: boolean;
  /** get_server_metrics answers isError. */
  mcpFails?: boolean;
  metricsEnabled?: boolean;
  trafficEnabled?: boolean;
  ipMode?: string;
  linked?: boolean;
  permissions?: string[];
  settings?: Record<string, unknown>;
}

function lists(): Record<string, FakeAnswer> {
  const base = resourceLists();
  const apps = (base["GET /applications"] as { json: unknown[] }).json;
  const dbs = (base["GET /databases"] as { json: unknown[] }).json;
  const server = { uuid: SERVER_UUID, name: "vps1" };
  return {
    ...base,
    "GET /applications": {
      json: [
        ...apps,
        {
          id: 31,
          uuid: APP_UUID,
          name: "shop",
          fqdn: "https://shop.example.test",
          status: "running:healthy",
          destination: { server },
        },
      ],
    },
    "GET /databases": {
      json: [
        ...dbs,
        {
          id: 32,
          uuid: DB_UUID,
          name: "main-db",
          type: "standalone-postgresql",
          status: "running:healthy",
          destination: { server },
        },
      ],
    },
  };
}

export interface McpCall {
  method: string;
  params: Record<string, any>;
}

/** A plugin with one connection; srv-vps1-uuid has a Linked host unless linked is false. */
export async function startMetrics(options: MetricsOptions = {}) {
  const fake = healthyCoolify({
    ...lists(),
    [`GET /servers/${SERVER_UUID}`]: {
      json: {
        uuid: SERVER_UUID,
        name: "vps1",
        ip: "203.0.113.5",
        settings: {
          is_metrics_enabled: options.metricsEnabled !== false,
          is_sentinel_enabled: true,
          is_traffic_analytics_enabled: options.trafficEnabled !== false,
        },
      },
    },
    [`GET /servers/${SERVER_UUID}/sentinel`]: {
      json: {
        is_sentinel_enabled: true,
        is_metrics_enabled: options.metricsEnabled !== false,
        sentinel_token: "FAKE-SENTINEL-TOKEN",
        traffic_ip_mode: options.ipMode ?? "anonymized",
      },
    },
    [`PATCH /servers/${SERVER_UUID}/sentinel`]: { json: {} },
  });
  const mcpCalls: McpCall[] = [];
  const fetch = async (url: string, init?: PluginFetchInit) => {
    if (url === `${BASE}/mcp`) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      mcpCalls.push({ method: body.method, params: body.params ?? {} });
      if (!options.mcp) {
        return new Response("Not Found", { status: 404 });
      }
      const result =
        body.method === "tools/list"
          ? { tools: [{ name: "get_server_metrics" }] }
          : {
              isError: options.mcpFails === true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    data: {
                      minutes: body.params?.arguments?.minutes,
                      bucket_seconds: 300,
                      current: { cpu_percent: 21.5, memory_used_bytes: 2048 },
                      series: {
                        cpu_percent: [[1763546400000, 20]],
                      },
                    },
                  }),
                },
              ],
            };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return fake.fetch(url, init);
  };
  const harness = await startPlugin({
    fetch,
    permissions: options.permissions,
    settings: options.settings,
    hosts: [linkedHost],
  });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: BASE,
    token: "fake-token-metrics-test",
  });
  if (created.status !== 201) {
    throw new Error(`connection not created: ${created.status}`);
  }
  const connectionId = created.body.id as number;
  if (options.linked !== false) {
    harness.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
      )
      .run(connectionId, SERVER_UUID, HOST_ID);
  }
  return { harness, fake, mcpCalls, connectionId };
}

function result(stdout: string, code = 0): PluginSshExecResult {
  return { stdout, stderr: "", code, truncated: false, timedOut: false };
}

/** The Sentinel URL inside a command, or null. */
export function sentinelUrl(command: string): string | null {
  return /'http:\/\/localhost:8888(\/api\/[^']*)'/.exec(command)?.[1] ?? null;
}

/**
 * Stands in for ctx.ssh.exec: root on the Linked host, Sentinel answering
 * from `answers` (first pattern that matches the path wins).
 */
export function fakeSentinel(
  harness: PluginHarness,
  answers: Array<[RegExp, unknown]>,
) {
  const commands: string[] = [];
  const exec = vi
    .spyOn(harness.mock.ctx.ssh, "exec")
    .mockImplementation(async (_target, command) => {
      commands.push(command);
      if (command === "id -u; id -Gn") return result("0\nroot\n");
      const path = sentinelUrl(command);
      if (path) {
        for (const [pattern, answer] of answers) {
          if (pattern.test(path)) return result(JSON.stringify(answer));
        }
        return result(`{"error":"not found"}`);
      }
      if (/docker stats /.test(command)) {
        return result(
          `{"CPUPerc":"12.50%","MemPerc":"3.10%","MemUsage":"64MiB / 2GiB","NetIO":"1.5kB / 2MB","Name":"web-abc"}\n`,
        );
      }
      if (/docker ps /.test(command)) return result("web-abc|running||\n");
      return result("", 127);
    });
  const paths = () =>
    commands.map(sentinelUrl).filter((p): p is string => p !== null);
  return { exec, commands, paths };
}
