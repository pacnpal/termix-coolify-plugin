import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import {
  APP_UUID,
  DB_UUID,
  fakeSentinel,
  SERVER_UUID,
  startMetrics,
  type MetricsOptions,
} from "./fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: MetricsOptions = {}) {
  const started = await startMetrics(options);
  harness = started.harness;
  const id = started.connectionId;
  return {
    ...started,
    resource: (uuid: string, what: string, query = "", user?: string) =>
      started.harness.request(
        "GET",
        `/connections/${id}/resources/${uuid}/${what}${query}`,
        undefined,
        user,
      ),
    server: (query = "", user?: string) =>
      started.harness.request(
        "GET",
        `/connections/${id}/servers/${SERVER_UUID}/metrics${query}`,
        undefined,
        user,
      ),
  };
}

const SUMMARY = {
  cpu: { time: "2026-11-19T11:00:00Z", percent: 7.5 },
  memory: { time: "1763550000000", used: 1000, total: 4000, usedPercent: 25 },
  disk: [
    { mount: "/boot", usedPercent: 90 },
    { mount: "/", usedPercent: 40, used: 40, total: 100 },
  ],
  load: { load1: 0.5 },
  network: { rxBytesPerSec: 10, txBytesPerSec: 20 },
};

const HISTORY: Array<[RegExp, unknown]> = [
  [/^\/api\/summary$/, SUMMARY],
  [
    /^\/api\/cpu\/history\?/,
    [
      { time: "1763546400000", percent: "5.5" },
      { time: "2026-11-19T10:05:00Z", percent: "6" },
      { time: "garbage", percent: "1" },
    ],
  ],
  [/^\/api\/memory\/history\?/, [{ time: "1763546400000", used: 900 }]],
  [
    /^\/api\/container\/k8sappweb1\/cpu\/history\?/,
    [{ time: "1763546400000", percent: "12.25" }],
  ],
  [
    /^\/api\/container\/k8sappweb1\/memory\/history\?/,
    [{ time: "1763546400000", used: 4096, usedPercent: 2 }],
  ],
];

describe("server metrics", () => {
  it("server metrics prefer Coolify MCP and fall back to Sentinel", async () => {
    const withMcp = await start({ mcp: true });
    const ssh = fakeSentinel(withMcp.harness, HISTORY);
    const viaMcp = await withMcp.server("?minutes=120");
    expect(viaMcp.status).toBe(200);
    expect(viaMcp.body).toMatchObject({
      source: "mcp",
      minutes: 120,
      current: { cpu_percent: 21.5, memory_used_bytes: 2048 },
      series: { cpu_percent: [[1763546400000, 20]] },
    });
    expect(withMcp.mcpCalls.at(-1)).toEqual({
      method: "tools/call",
      params: {
        name: "get_server_metrics",
        arguments: { server_uuid: SERVER_UUID, minutes: 120 },
      },
    });
    expect(ssh.commands).toEqual([]);
    await harness!.close();
    vi.restoreAllMocks();

    // MCP off on the instance: Sentinel over SSH on the Linked host.
    const noMcp = await start({ mcp: false });
    const ssh2 = fakeSentinel(noMcp.harness, HISTORY);
    const viaSentinel = await noMcp.server();
    expect(viaSentinel.status).toBe(200);
    expect(viaSentinel.body).toMatchObject({
      source: "sentinel",
      minutes: 60,
      current: {
        cpu_percent: 7.5,
        memory_used_bytes: 1000,
        memory_total_bytes: 4000,
        disk_used_percent: 40,
        load1: 0.5,
        network_rx_bytes_per_sec: 10,
        network_tx_bytes_per_sec: 20,
      },
      series: {
        cpu_percent: [
          [1763546400000, 5.5],
          [Date.parse("2026-11-19T10:05:00Z"), 6],
        ],
        memory_used_bytes: [[1763546400000, 900]],
      },
    });
    expect(ssh2.paths().map((p) => p.split("?")[0])).toEqual([
      "/api/summary",
      "/api/cpu/history",
      "/api/memory/history",
    ]);
    await harness!.close();
    vi.restoreAllMocks();

    // MCP on, but its call fails: still Sentinel.
    const failing = await start({ mcp: true, mcpFails: true });
    fakeSentinel(failing.harness, HISTORY);
    const fellBack = await failing.server();
    expect(fellBack.status).toBe(200);
    expect(fellBack.body.source).toBe("sentinel");
  });

  it("minutes capped at 43200", async () => {
    const {
      server,
      resource,
      mcpCalls,
      harness: h,
    } = await start({
      mcp: true,
    });
    const ssh = fakeSentinel(h, HISTORY);
    const big = await server("?minutes=999999");
    expect(big.status).toBe(200);
    expect(big.body.minutes).toBe(43200);
    expect(mcpCalls.at(-1)?.params.arguments.minutes).toBe(43200);

    const history = await resource(APP_UUID, "metrics", "?minutes=999999");
    expect(history.status).toBe(200);
    expect(history.body.minutes).toBe(43200);
    const cpu = ssh.paths().find((p) => p.includes("/cpu/history"))!;
    const query = new URLSearchParams(cpu.split("?")[1]);
    expect(Date.parse(query.get("to")!) - Date.parse(query.get("from")!)).toBe(
      43200 * 60_000,
    );

    for (const bad of ["?minutes=abc", "?minutes=0", "?minutes=-5"]) {
      expect((await server(bad)).status).toBe(400);
      expect((await resource(APP_UUID, "metrics", bad)).status).toBe(400);
    }
  });

  it("metrics-off with canEnable only when allowed", async () => {
    const off = await start({ metricsEnabled: false });
    const ssh = fakeSentinel(off.harness, HISTORY);
    const owner = await off.server();
    expect(owner.status).toBe(409);
    expect(owner.body).toMatchObject({ cause: "metrics-off", canEnable: true });
    const res = await off.resource(APP_UUID, "metrics");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ cause: "metrics-off", canEnable: true });

    // A view grant: the server is readable, but not changeable.
    off.harness.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
      )
      .run(off.connectionId, OTHER, "view");
    const viewer = await off.server("", OTHER);
    expect(viewer.status).toBe(409);
    expect(viewer.body).toMatchObject({
      cause: "metrics-off",
      canEnable: false,
    });
    const refused = await off.harness.request(
      "POST",
      `/connections/${off.connectionId}/servers/${SERVER_UUID}/metrics/enable`,
      {},
      OTHER,
    );
    expect(refused.status).toBe(403);
    expect(ssh.commands).toEqual([]);
    expect(off.fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

    // The owner turns metrics on: Sentinel settings through Coolify's API.
    const enabled = await off.harness.request(
      "POST",
      `/connections/${off.connectionId}/servers/${SERVER_UUID}/metrics/enable`,
      { confirm: true },
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body).toEqual({ enabled: true });
    const patch = off.fake.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`/servers/${SERVER_UUID}/sentinel`);
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      is_metrics_enabled: true,
    });
  });

  it("metrics-off has no canEnable without coolify.configure", async () => {
    const off = await start({ metricsEnabled: false });
    // The role lacks coolify.configure (the connection exists already).
    const has = off.harness.mock.ctx.rbac.has.bind(off.harness.mock.ctx.rbac);
    vi.spyOn(off.harness.mock.ctx.rbac, "has").mockImplementation(
      async (permission) => permission !== "configure" && has(permission),
    );
    const answer = await off.server();
    expect(answer.body).toMatchObject({
      cause: "metrics-off",
      canEnable: false,
    });
    const enable = await off.harness.request(
      "POST",
      `/connections/${off.connectionId}/servers/${SERVER_UUID}/metrics/enable`,
      {},
    );
    expect(enable.status).toBe(403);
  });

  it("not-linked 409", async () => {
    const { server, resource, harness: h } = await start({ linked: false });
    const ssh = fakeSentinel(h, HISTORY);
    for (const answer of [
      await server(),
      await resource(APP_UUID, "metrics"),
      await resource(APP_UUID, "traffic"),
    ]) {
      expect(answer.status).toBe(409);
      expect(answer.body.cause).toBe("not-linked");
    }
    expect(ssh.commands).toEqual([]);
  });

  it("the Sentinel fallback needs coolify.operate and the host's connect access", async () => {
    const viewOnly = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const ssh = fakeSentinel(viewOnly.harness, HISTORY);
    const answer = await viewOnly.server();
    expect(answer.status).toBe(403);
    expect(ssh.commands).toEqual([]);
    await harness!.close();
    vi.restoreAllMocks();

    const noHost = await start();
    const ssh2 = fakeSentinel(noHost.harness, HISTORY);
    vi.spyOn(noHost.harness.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    for (const res of [
      await noHost.server(),
      await noHost.resource(APP_UUID, "metrics"),
      await noHost.resource(APP_UUID, "traffic"),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.cause).toBe("no-host-access");
    }
    expect(ssh2.commands).toEqual([]);
  });

  it("another user's connection is a 404", async () => {
    const { server, resource, harness: h } = await start();
    const ssh = fakeSentinel(h, HISTORY);
    expect((await server("", OTHER)).status).toBe(404);
    expect((await resource(APP_UUID, "metrics", "", OTHER)).status).toBe(404);
    expect((await resource(APP_UUID, "traffic", "", OTHER)).status).toBe(404);
    expect(ssh.commands).toEqual([]);
  });
});

describe("resource metrics", () => {
  it("reads the container's cpu and memory history from Sentinel", async () => {
    const { resource, harness: h } = await start();
    const ssh = fakeSentinel(h, HISTORY);
    const answer = await resource(APP_UUID, "metrics", "?minutes=60");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      source: "sentinel",
      minutes: 60,
      cpu: [[1763546400000, 12.25]],
      memory: [[1763546400000, 4096]],
    });
    expect(ssh.paths().map((p) => p.split("?")[0])).toEqual([
      `/api/container/${APP_UUID}/cpu/history`,
      `/api/container/${APP_UUID}/memory/history`,
    ]);
  });

  it("checks the uuid as one path segment, as every Coolify path does", async () => {
    const { resource, harness: h } = await start();
    const ssh = fakeSentinel(h, HISTORY);
    // A uuid that can't be one segment is never looked up or sent.
    expect((await resource("a%2Fb", "metrics")).status).toBe(404);
    expect(ssh.commands).toEqual([]);
  });

  it("needs coolify.operate", async () => {
    const { resource, harness: h } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const ssh = fakeSentinel(h, HISTORY);
    expect((await resource(APP_UUID, "metrics")).status).toBe(403);
    expect((await resource(APP_UUID, "traffic")).status).toBe(403);
    expect(ssh.commands).toEqual([]);
  });
});

describe("traffic", () => {
  const TRAFFIC: Array<[RegExp, unknown]> = [
    [
      /traffic\/overview\?/,
      { requests: 120, unique_visitors: 9, top_ips: ["198.51.100.7"] },
    ],
    [/traffic\/series\?range=7d$/, [{ bucket: 1763546400000, requests: 4 }]],
    [
      /traffic\/paths\?/,
      [{ path: "/", requests: 80, client_ip: "198.51.100.7" }],
    ],
    [/traffic\/breakdown\/ip\?/, [{ value: "198.51.100.7", requests: 50 }]],
    [/traffic\/breakdown\/country\?/, [{ value: "NL", requests: 70 }]],
  ];

  it("traffic hides IPs unless full", async () => {
    const hidden = await start({ ipMode: "anonymized" });
    const ssh = fakeSentinel(hidden.harness, TRAFFIC);
    const ip = await hidden.resource(
      APP_UUID,
      "traffic",
      "?view=breakdown&dim=ip",
    );
    expect(ip.status).toBe(200);
    expect(ip.body).toMatchObject({ ipsHidden: true, data: [] });
    expect(ssh.paths().some((p) => p.includes("breakdown/ip"))).toBe(false);
    const overview = await hidden.resource(APP_UUID, "traffic");
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      view: "overview",
      ipsHidden: true,
      data: { requests: 120, unique_visitors: 9 },
    });
    const paths = await hidden.resource(APP_UUID, "traffic", "?view=paths");
    expect(paths.body.data).toEqual([{ path: "/", requests: 80 }]);
    expect(JSON.stringify([overview.body, paths.body])).not.toContain(
      "198.51.100.7",
    );
    const country = await hidden.resource(
      APP_UUID,
      "traffic",
      "?view=breakdown&dim=country",
    );
    expect(country.body.data).toEqual([{ value: "NL", requests: 70 }]);
    const series = await hidden.resource(
      APP_UUID,
      "traffic",
      "?view=series&range=7d",
    );
    expect(series.body.data).toEqual([{ bucket: 1763546400000, requests: 4 }]);
    await harness!.close();
    vi.restoreAllMocks();

    const full = await start({ ipMode: "full" });
    fakeSentinel(full.harness, TRAFFIC);
    const shown = await full.resource(
      APP_UUID,
      "traffic",
      "?view=breakdown&dim=ip",
    );
    expect(shown.body).toMatchObject({
      ipsHidden: false,
      data: [{ value: "198.51.100.7", requests: 50 }],
    });
  });

  it("unknown breakdown dimension 400", async () => {
    const { resource, harness: h } = await start();
    const ssh = fakeSentinel(h, TRAFFIC);
    for (const query of [
      "?view=breakdown&dim=secrets",
      "?view=breakdown",
      "?view=breakdown&dim=../summary",
      "?view=everything",
      "?range=1y",
      "?view=paths&limit=0",
    ]) {
      const answer = await resource(APP_UUID, "traffic", query);
      expect(answer.status, query).toBe(400);
    }
    expect(ssh.commands).toEqual([]);
  });

  it("answers traffic-off when analytics is off, and is for applications", async () => {
    const off = await start({ trafficEnabled: false });
    const ssh = fakeSentinel(off.harness, TRAFFIC);
    const answer = await off.resource(APP_UUID, "traffic");
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("traffic-off");
    const db = await off.resource(DB_UUID, "traffic");
    expect(db.status).toBe(400);
    expect(ssh.commands).toEqual([]);
  });
});
