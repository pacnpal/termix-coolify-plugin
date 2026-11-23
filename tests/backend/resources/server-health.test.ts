import { afterEach, describe, expect, it } from "vitest";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import { queueAnswers } from "../helpers/deployments.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { OTHER, startPlugin, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";

const TOKEN = "fake-token-server-health";

/** Two servers: vps1 reachable, edge not. */
const SERVERS = {
  json: [
    {
      uuid: "srv-vps1-uuid",
      name: "vps1",
      ip: "203.0.113.10",
      settings: { is_reachable: true, is_usable: true },
    },
    {
      uuid: "srv-edge-uuid",
      name: "edge",
      ip: "203.0.113.20",
      settings: { is_reachable: false, is_usable: false },
    },
  ],
};

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(
  overrides = {},
  after?: (url: string, h: PluginHarness) => void,
) {
  const fake = healthyCoolify({
    ...resourceLists(),
    "GET /servers": SERVERS,
    "GET /deployments": { json: [] },
    ...overrides,
  });
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const response = await fake.fetch(url, init);
    if (after && harness) after(url, harness);
    return response;
  };
  harness = await startPlugin({ fetch });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: TOKEN,
  });
  return { harness, fake, id: created.body?.id as number };
}

describe("server health route", () => {
  it("answers each server's reachability and degraded count, nothing more", async () => {
    const { harness, id } = await start();
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      servers: [
        { uuid: "srv-vps1-uuid", reachable: true, usable: true },
        { uuid: "srv-edge-uuid", reachable: false, usable: false },
      ],
      // vps1's worker is running:unhealthy; edge's api is too. vps1's
      // exited cache database is stopped, not degraded.
      degraded: { "srv-vps1-uuid": 1, "srv-edge-uuid": 1 },
      // countResources: Parts left out, exited stopped, starting deploying.
      counts: {
        "srv-vps1-uuid": { running: 3, degraded: 1, stopped: 2, deploying: 1 },
        "srv-edge-uuid": { running: 0, degraded: 1, stopped: 0, deploying: 0 },
      },
      // Nothing in Coolify's queue: only vps1's starting blog.
      deploying: { "srv-vps1-uuid": 1, "srv-edge-uuid": 0 },
    });
    expect(JSON.stringify(answer.body)).not.toContain("203.0.113");
  });

  it("an exited resource, healthy or not, is never degraded", async () => {
    const { harness, id } = await start({
      "GET /applications": {
        json: [
          {
            id: 31,
            uuid: "app-off-uuid",
            name: "off",
            status: "exited:unhealthy",
            destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
          },
          {
            id: 32,
            uuid: "app-gone-uuid",
            name: "gone",
            status: "exited",
            destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
          },
        ],
      },
      "GET /services": { json: [] },
      "GET /databases": { json: [] },
    });
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.degraded).toEqual({ "srv-vps1-uuid": 0 });
  });

  it("serves many hosts from the shared caches: one Coolify read per list", async () => {
    const { harness, fake, id } = await start();
    await harness.request("GET", `/connections/${id}/server-health`);
    const before = fake.calls.length;
    await harness.request("GET", `/connections/${id}/server-health`);
    await harness.request("GET", `/connections/${id}/resources`);
    expect(fake.calls.length).toBe(before);
  });

  it("a token that can't read servers still answers degraded counts", async () => {
    const { harness, id } = await start({
      "GET /servers": { status: 403, json: { message: "Forbidden." } },
    });
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.servers).toBeNull();
    expect(answer.body.degraded["srv-edge-uuid"]).toBe(1);
  });

  it("a server whose application is in Coolify's queue counts as deploying", async () => {
    // web (vps1) is in progress and api (edge) queued; a foreign
    // application's deployment counts for no server.
    const { harness, id } = await start(queueAnswers());
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(answer.status).toBe(200);
    // vps1: web from the queue plus the starting blog; edge: api.
    expect(answer.body.deploying).toEqual({
      "srv-vps1-uuid": 2,
      "srv-edge-uuid": 1,
    });
  });

  it("a queue Coolify won't answer still counts the deploying statuses", async () => {
    const { harness, id } = await start({
      "GET /deployments": { status: 403, json: { message: "Forbidden." } },
    });
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.deploying).toEqual({
      "srv-vps1-uuid": 1,
      "srv-edge-uuid": 0,
    });
  });

  it("resources Coolify won't list answer null counts and deploying", async () => {
    const { harness, id } = await start({
      "GET /applications": { status: 403, json: { message: "Forbidden." } },
    });
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      counts: null,
      deploying: null,
      degraded: null,
    });
  });

  it("a new token within the caches' lifetime answers the new target's counts", async () => {
    const { harness, fake, id } = await start();
    await harness.request("GET", `/connections/${id}/server-health`);
    // The new target has one stopped application on vps1, nothing else.
    fake.set("GET /applications", {
      json: [
        {
          id: 41,
          uuid: "app-new-uuid",
          name: "new",
          status: "exited",
          destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
        },
      ],
    });
    fake.set("GET /services", { json: [] });
    fake.set("GET /databases", { json: [] });
    const update = await harness.request("PATCH", `/connections/${id}`, {
      token: "fake-token-server-health-new",
    });
    expect(update.status).toBe(200);
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(answer.body.counts).toEqual({
      "srv-vps1-uuid": { running: 0, degraded: 0, stopped: 1, deploying: 0 },
    });
  });

  it("a target change while it reads answers target-changed, not mixed targets", async () => {
    let moved = false;
    const { harness, id } = await start({}, (url, h) => {
      if (moved || !new URL(url).pathname.endsWith("/servers")) return;
      moved = true;
      h.db.sqlite
        .prepare("UPDATE p_coolify_connections SET base_url = ?")
        .run("https://other.example.test");
    });
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
    );
    expect(moved).toBe(true);
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("target-changed");
  });

  it("another user's connection answers 404 and reaches no Coolify", async () => {
    const { harness, fake, id } = await start();
    const before = fake.calls.length;
    const answer = await harness.request(
      "GET",
      `/connections/${id}/server-health`,
      undefined,
      OTHER,
    );
    expect(answer.status).toBe(404);
    expect(fake.calls.length).toBe(before);
  });
});
