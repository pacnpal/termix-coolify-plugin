import { afterEach, describe, expect, it } from "vitest";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import {
  LIFECYCLE_TOKEN,
  lifecycleAnswers,
  link,
} from "../helpers/lifecycle.js";
import { startPlugin, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";

const NEW_TOKEN = "fake-token-signals-new";

/** The edge server as Coolify reports it once it can reach it again. */
const REACHABLE_EDGE = {
  json: [
    {
      uuid: "srv-edge-uuid",
      name: "edge",
      ip: "203.0.113.20",
      settings: { is_reachable: true, is_usable: true },
    },
  ],
};

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/**
 * A plugin with one connection whose edge server is linked to host 8. The
 * next `/servers` answer can be held, as a slow Coolify would.
 */
async function start() {
  const fake = healthyCoolify({ ...resourceLists(), ...lifecycleAnswers() });
  let gate: { reached: () => void; released: Promise<void> } | null = null;
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const response = await fake.fetch(url, init);
    const held = gate;
    if (held && new URL(url).pathname.endsWith("/servers")) {
      gate = null;
      held.reached();
      await held.released;
    }
    return response;
  };
  harness = await startPlugin({ fetch });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: LIFECYCLE_TOKEN,
  });
  const id = created.body.id as number;
  link(harness, id, "srv-edge-uuid", 8);
  const h = harness;
  return {
    fake,
    id,
    signal: async () =>
      (await h.mock.ctx.operations.run("coolify.signal-server", { hostId: 8 }))
        .data as { status: string },
    /** Holds the next `/servers` answer until `release` is called. */
    holdNextServers() {
      let reached = () => {};
      let release = () => {};
      const atFetch = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      gate = { reached, released };
      return { atFetch, release };
    },
    serverCalls: () =>
      fake.calls
        .filter((c) => c.method === "GET" && c.path === "/servers")
        .map((c) =>
          new Headers(c.init?.headers as Record<string, string>).get(
            "authorization",
          ),
        ),
  };
}

describe("server signals and a changed connection target", () => {
  it("a token change within the cache's minute reads the new target", async () => {
    const { fake, id, signal, serverCalls } = await start();
    expect(await signal()).toMatchObject({ status: "fail" });
    const update = await harness!.request("PATCH", `/connections/${id}`, {
      token: NEW_TOKEN,
    });
    expect(update.status).toBe(200);
    fake.set("GET /servers", REACHABLE_EDGE);
    const before = serverCalls().length;
    expect(await signal()).toMatchObject({ status: "ok" });
    const after = serverCalls().slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.at(-1)).toBe(`Bearer ${NEW_TOKEN}`);
  });

  it("a fetch started before a token change does not fill the cache", async () => {
    const { fake, id, signal, holdNextServers } = await start();
    const hold = holdNextServers();
    const stale = signal();
    await hold.atFetch;
    const update = await harness!.request("PATCH", `/connections/${id}`, {
      token: NEW_TOKEN,
    });
    expect(update.status).toBe(200);
    fake.set("GET /servers", REACHABLE_EDGE);
    hold.release();
    // The caller from before the change gets the old target's answer.
    expect(await stale).toMatchObject({ status: "fail" });
    expect(await signal()).toMatchObject({ status: "ok" });
  });
});
