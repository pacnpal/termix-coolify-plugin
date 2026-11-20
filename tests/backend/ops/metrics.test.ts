import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { manifest, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  APP_UUID,
  fakeSentinel,
  SERVER_UUID,
  startMetrics,
  type MetricsOptions,
} from "../metrics/fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: MetricsOptions = {}) {
  const started = await startMetrics(options);
  harness = started.harness;
  const ssh = fakeSentinel(started.harness, [
    [
      /^\/api\/container\/k8sappweb1\/cpu\/history\?/,
      [{ time: "1", percent: "3" }],
    ],
    [
      /^\/api\/container\/k8sappweb1\/memory\/history\?/,
      [{ time: "1", used: 5 }],
    ],
    [/traffic\/breakdown\/ip\?/, [{ value: "198.51.100.7", requests: 1 }]],
    [/traffic\/breakdown\/country\?/, [{ value: "NL", requests: 3 }]],
  ]);
  return {
    ...started,
    ssh,
    runs: withRunHistory(started.harness.mock),
    id: String(started.connectionId),
  };
}

function declared(id: string): OperationAction {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id)!;
}

describe("metrics operations", () => {
  it("are server-scope reads for the assistant and MCP", () => {
    const expected: Record<string, { permission: string; keys: string[] }> = {
      "coolify.resource-metrics": {
        permission: "operate",
        keys: ["connectionId", "uuid", "minutes"],
      },
      "coolify.resource-traffic": {
        permission: "operate",
        keys: ["connectionId", "uuid", "view", "dim", "range"],
      },
      "coolify.server-metrics": {
        permission: "view",
        keys: ["connectionId", "serverUuid", "minutes"],
      },
    };
    for (const [id, want] of Object.entries(expected)) {
      const action = declared(id);
      expect(action, id).toBeTruthy();
      expect(action.scope).toBe("server");
      expect(action.risk).toBe("read");
      expect(action.permission).toBe(want.permission);
      expect(action.surfaces).toMatchObject({ assistant: true, mcp: true });
      expect(action.inputs!.map((f) => f.key)).toEqual(want.keys);
      expect(
        action.inputs!.find((f) => f.key === "connectionId"),
      ).toMatchObject({
        optionsFrom: "coolify.list-connections",
        required: true,
      });
    }
    expect(
      declared("coolify.server-metrics").inputs!.find(
        (f) => f.key === "minutes",
      ),
    ).toMatchObject({ type: "number", min: 1, max: 43200 });
  });

  it("resource-metrics returns the container history", async () => {
    const { runs, id } = await start();
    const outcome = await runs.run("coolify.resource-metrics", {
      connectionId: id,
      uuid: APP_UUID,
      minutes: 30,
    });
    expect(outcome.data).toEqual({
      source: "sentinel",
      minutes: 30,
      cpu: [[1, 3]],
      memory: [[1, 5]],
    });
  });

  it("resource-traffic hides IPs unless full, and refuses an unknown dimension", async () => {
    const { runs, id, ssh } = await start({ ipMode: "off" });
    const hidden = await runs.run("coolify.resource-traffic", {
      connectionId: id,
      uuid: APP_UUID,
      view: "breakdown",
      dim: "ip",
    });
    expect(hidden.data).toMatchObject({ ipsHidden: true, data: [] });
    expect(JSON.stringify(runs.history)).not.toContain("198.51.100.7");
    const country = await runs.run("coolify.resource-traffic", {
      connectionId: id,
      uuid: APP_UUID,
      view: "breakdown",
      dim: "country",
    });
    expect(country.data).toMatchObject({
      data: [{ value: "NL", requests: 3 }],
    });
    const before = ssh.commands.length;
    await expect(
      runs.run("coolify.resource-traffic", {
        connectionId: id,
        uuid: APP_UUID,
        view: "breakdown",
        dim: "secrets",
      }),
    ).rejects.toThrow();
    expect(ssh.commands.length).toBe(before);
  });

  it("server-metrics prefers MCP and caps minutes", async () => {
    const { runs, id, mcpCalls } = await start({ mcp: true });
    const outcome = await runs.run("coolify.server-metrics", {
      connectionId: id,
      serverUuid: SERVER_UUID,
      minutes: 43200,
    });
    expect(outcome.data).toMatchObject({ source: "mcp", minutes: 43200 });
    expect(mcpCalls.at(-1)?.params.arguments.minutes).toBe(43200);
  });

  it("server-metrics on an unlinked server without MCP throws not-linked", async () => {
    const { runs, id } = await start({ linked: false });
    await expect(
      runs.run("coolify.server-metrics", {
        connectionId: id,
        serverUuid: SERVER_UUID,
      }),
    ).rejects.toThrow(/Link this server first/);
  });
});
