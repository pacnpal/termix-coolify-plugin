import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import { queueAnswers } from "../helpers/deployments.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { link } from "../helpers/lifecycle.js";
import {
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";

const HOST = 8;

const host = {
  id: HOST,
  userId: OWNER,
  name: "vps1",
  ip: "203.0.113.10",
  port: 22,
  username: "deploy",
  tags: "coolify",
  folder: "Coolify",
  authType: "credential",
};

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

/** One connection whose vps1 server is linked to host 8. */
async function start(after?: (url: string, h: PluginHarness) => void) {
  const fake = healthyCoolify({
    ...resourceLists(),
    ...queueAnswers(),
    "GET /servers": {
      json: [
        {
          uuid: "srv-vps1-uuid",
          name: "vps1",
          ip: "203.0.113.10",
          settings: { is_reachable: true, is_usable: true },
        },
      ],
    },
  });
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const response = await fake.fetch(url, init);
    if (after && harness) after(url, harness);
    return response;
  };
  harness = await startPlugin({ fetch, hosts: [host] });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: "fake-token-host-slots",
  });
  const id = created.body.id as number;
  link(harness, id, "srv-vps1-uuid", HOST);
  const h = harness;
  return {
    fake,
    id,
    run: (hostId = HOST) =>
      h.mock.ctx.operations.run("coolify.host-summary", { hostId }),
  };
}

describe("coolify.host-summary", () => {
  it("answers the Linked host's resource counts and deployments", async () => {
    const { id, run } = await start();
    const outcome = await run();
    expect(outcome.data).toEqual({
      linked: true,
      connectionId: id,
      serverUuid: "srv-vps1-uuid",
      server: { reachable: true, usable: true },
      counts: { running: 3, degraded: 1, stopped: 2, deploying: 1 },
      // web in Coolify's queue, plus the starting blog.
      deploying: 2,
    });
    expect(outcome.summary).toBe(
      "3 running, 1 degraded, 2 stopped, 2 deploying",
    );
    expect(JSON.stringify(outcome)).not.toContain("203.0.113");
  });

  it("an ordinary host is linked: false and reaches no Coolify", async () => {
    const { fake, run } = await start();
    const before = fake.calls.length;
    const outcome = await run(99);
    expect(outcome.data).toEqual({ linked: false });
    expect(fake.calls.length).toBe(before);
  });

  it("is refused for a host the actor can't connect to, before Coolify", async () => {
    const { fake, run } = await start();
    vi.spyOn(harness!.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
    } as never);
    const before = fake.calls.length;
    await expect(run()).rejects.toThrow();
    expect(fake.calls.length).toBe(before);
  });

  it("is refused for another user's connection", async () => {
    const { run } = await start();
    harness!.mock.setActor(OTHER);
    vi.spyOn(harness!.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: true,
    } as never);
    await expect(run()).rejects.toThrow();
  });

  it("a target change while it reads ends with target-changed", async () => {
    let moved = false;
    const { run } = await start((url, h) => {
      if (moved || !new URL(url).pathname.endsWith("/servers")) return;
      moved = true;
      h.db.sqlite
        .prepare("UPDATE p_coolify_connections SET base_url = ?")
        .run("https://other.example.test");
    });
    await expect(run()).rejects.toMatchObject({ code: "target-changed" });
    expect(moved).toBe(true);
  });
});
