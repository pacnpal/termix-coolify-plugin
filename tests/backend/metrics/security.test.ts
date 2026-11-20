import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import { grant } from "../helpers/lifecycle.js";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  APP_UUID,
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
    id,
    resource: (uuid: string, what: string, query = "", user?: string) =>
      started.harness.request(
        "GET",
        `/connections/${id}/resources/${uuid}/${what}${query}`,
        undefined,
        user,
      ),
  };
}

/** Points the connection at another address, as an edit would. */
function retarget(h: PluginHarness): void {
  h.db.sqlite
    .prepare("UPDATE p_coolify_connections SET base_url = ?")
    .run("https://other.example.test");
}

const HISTORY: Array<[RegExp, unknown]> = [
  [/\/cpu\/history\?/, [{ time: "1763546400000", percent: 5 }]],
  [/\/memory\/history\?/, [{ time: "1763546400000", used: 10 }]],
  [/traffic\/breakdown\/ip\?/, [{ value: "198.51.100.7", requests: 50 }]],
  [
    /traffic\/paths\?/,
    [
      { path: "/reset?token=fake-reset-token", requests: 3 },
      { path: "https://user:fake-pass@example.test/", requests: 1 },
    ],
  ],
  [/traffic\/overview\?/, { requests: 1 }],
];

describe("metrics authorization", () => {
  it("SSH reads need an operate grant: a view grant is refused before any SSH", async () => {
    const { id, resource, harness: h } = await start();
    const ssh = fakeSentinel(h, HISTORY);
    grant(h, id, OTHER, "view");
    for (const what of ["metrics", "traffic"]) {
      const answer = await resource(APP_UUID, what, "", OTHER);
      expect(answer.status, what).toBe(403);
    }
    expect(ssh.commands).toEqual([]);
    h.db.sqlite.prepare("UPDATE p_coolify_grants SET level = 'operate'").run();
    expect((await resource(APP_UUID, "metrics", "", OTHER)).status).toBe(200);
  });

  it("IPs show only with traffic_ip_mode full and configure access", async () => {
    const { id, resource, harness: h } = await start({ ipMode: "full" });
    const ssh = fakeSentinel(h, HISTORY);
    grant(h, id, OTHER, "operate");
    const operate = await resource(
      APP_UUID,
      "traffic",
      "?view=breakdown&dim=ip",
      OTHER,
    );
    expect(operate.status).toBe(200);
    expect(operate.body).toMatchObject({ ipsHidden: true, data: [] });
    expect(ssh.paths().some((p) => p.includes("breakdown/ip"))).toBe(false);
    const owner = await resource(APP_UUID, "traffic", "?view=breakdown&dim=ip");
    expect(owner.body).toMatchObject({
      ipsHidden: false,
      data: [{ value: "198.51.100.7", requests: 50 }],
    });
  });

  it("turning metrics on needs confirm: true, and changes nothing without it", async () => {
    const { id, fake, harness: h } = await start({ metricsEnabled: false });
    const path = `/connections/${id}/servers/${SERVER_UUID}/metrics/enable`;
    const patches = () => fake.calls.filter((c) => c.method === "PATCH");
    const refused = await h.request("POST", path, {});
    expect(refused.status).toBe(400);
    expect(refused.body.cause).toBe("confirm-required");
    expect(patches()).toEqual([]);
    const done = await h.request("POST", path, { confirm: true });
    expect(done.status).toBe(200);
    expect(patches().map((c) => c.path)).toEqual([
      `/servers/${SERVER_UUID}/sentinel`,
    ]);
  });
});

describe("one snapshot per read", () => {
  it("a target change mid-read ends with target-changed before the next SSH command", async () => {
    const { resource, harness: h } = await start();
    const ssh = fakeSentinel(h, HISTORY);
    const inner = ssh.exec.getMockImplementation()!;
    ssh.exec.mockImplementation(async (target, command, opts) => {
      const answer = await inner(target, command, opts);
      if (command.includes("/cpu/history")) retarget(h);
      return answer;
    });
    const answer = await resource(APP_UUID, "metrics");
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("target-changed");
    expect(ssh.paths().filter((p) => p.includes("/memory/"))).toEqual([]);
  });
});

describe("traffic limits", () => {
  it("clamps a large limit instead of passing it on", async () => {
    const { resource, harness: h } = await start();
    const ssh = fakeSentinel(h, HISTORY);
    const answer = await resource(
      APP_UUID,
      "traffic",
      "?view=paths&limit=5000",
    );
    expect(answer.status).toBe(200);
    expect(ssh.paths().find((p) => p.includes("/paths?"))).toMatch(
      /&limit=200$/,
    );
  });

  it("masks credentials in what Sentinel answers", async () => {
    const { resource, harness: h } = await start();
    fakeSentinel(h, HISTORY);
    const answer = await resource(APP_UUID, "traffic", "?view=paths");
    expect(answer.status).toBe(200);
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain("fake-reset-token");
    expect(text).not.toContain("fake-pass");
  });
});

type Run = (
  actionId: string,
  options?: PluginOperationInvokeOptions,
) => Promise<PluginOperationOutcome>;

function withRun(ctx: PluginContext, run: Run): PluginContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "operations") return { ...target.operations, run };
      return Reflect.get(target, prop);
    },
  });
}

describe("coolify.enable-metrics over MCP", () => {
  async function call(allowMcpChanges: boolean, args: Record<string, unknown>) {
    const started = await start({
      metricsEnabled: false,
      settings: { allowMcpChanges },
    });
    const runs = withRunHistory(started.harness.mock);
    const ctx = withRun(started.harness.mock.ctx, (actionId, options) =>
      runs.run(actionId, options?.input ?? {}),
    );
    started.harness.mock.setActor(OWNER);
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__enable_metrics",
        arguments: {
          connectionId: String(started.id),
          serverUuid: SERVER_UUID,
          ...args,
        },
      },
    });
    const result = answer?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    const patches = started.fake.calls.filter((c) => c.method === "PATCH");
    return { result, text: result.content[0].text, patches };
  }

  it("needs Allow changes over MCP", async () => {
    const { result, text, patches } = await call(false, {
      confirm: true,
      confirmed: true,
    });
    expect(result.isError).toBe(true);
    expect(text).toContain("mcp-changes-off");
    expect(patches).toEqual([]);
  });

  it("needs confirmed: true", async () => {
    const { result, text, patches } = await call(true, { confirm: true });
    expect(result.isError).toBe(true);
    expect(text).toContain("confirm-required");
    expect(patches).toEqual([]);
  });

  it("runs with both", async () => {
    const { result, patches } = await call(true, {
      confirm: true,
      confirmed: true,
    });
    expect(result.isError).toBe(false);
    expect(patches).toHaveLength(1);
  });
});
