import { describe, expect, it } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../../../src/backend/connections/service.js";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";
import type {
  CoolifyHttp,
  CoolifyRequestOptions,
} from "../../../src/backend/coolify/http.js";
import { createMetrics } from "../../../src/backend/metrics/service.js";

const SERVER = "srv-vps1-uuid";

/**
 * A request layer standing in for http.ts: `changeDuringWait` names the
 * request during whose budget wait the connection is pointed elsewhere, as an
 * edit landing while the request queues. Then beforeFetch runs, as
 * http.ts runs it right before the fetch, and only then is it "sent".
 */
function setup(changeDuringWait: (method: string, path: string) => boolean) {
  let changed = false;
  const sent: string[] = [];
  const guarded: boolean[] = [];
  const http: CoolifyHttp = {
    async request<T>(
      method: string,
      path: string,
      opts: CoolifyRequestOptions = {},
    ): Promise<T> {
      if (changeDuringWait(method, path)) changed = true;
      guarded.push(opts.beforeFetch !== undefined);
      await opts.beforeFetch?.();
      sent.push(`${method} ${path}`);
      if (path === "/mcp") {
        throw Object.assign(new Error("off"), { name: "CoolifyError" });
      }
      return (
        method === "GET"
          ? {
              uuid: SERVER,
              name: "vps1",
              settings: { is_metrics_enabled: false },
            }
          : {}
      ) as T;
    },
  };
  const snap = {
    view: { access: "owner", revision: "r1" },
    api: createCoolifyApi(http),
    http,
  };
  const ctx = {
    rbac: { has: async () => true },
  } as unknown as PluginContext;
  const metrics = createMetrics(ctx, {
    connections: {
      snapshot: async () => snap,
      access: async () => "owner",
    } as never,
    containers: {
      target: async () => {
        throw new Error("unused");
      },
      assertHostAccess: async () => undefined,
      assertSnapshotHolds: async () => {
        if (changed) {
          throw new ConnectionError("target-changed", "changed");
        }
      },
    },
    sync: { linkedHostFor: async () => null },
    run: async () => {
      throw new Error("no SSH in this test");
    },
  });
  return { metrics, sent, guarded };
}

describe("metrics: the snapshot check runs right before each fetch", () => {
  it("a change during the PATCH's budget wait sends nothing and ends with target-changed", async () => {
    const { metrics, sent } = setup((method) => method === "PATCH");
    await expect(
      metrics.enableMetrics(1, SERVER, { confirm: true }),
    ).rejects.toMatchObject({ code: "target-changed" });
    expect(sent).toEqual([`GET /servers/${SERVER}`]);
  });

  it("every Coolify call a read makes carries the check", async () => {
    const { metrics, guarded } = setup(() => false);
    await expect(metrics.serverMetrics(1, SERVER)).rejects.toMatchObject({
      code: "metrics-off",
    });
    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.every(Boolean)).toBe(true);
  });
});
