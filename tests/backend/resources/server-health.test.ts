import { afterEach, describe, expect, it } from "vitest";
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

async function start(overrides = {}) {
  const fake = healthyCoolify({
    ...resourceLists(),
    "GET /servers": SERVERS,
    ...overrides,
  });
  harness = await startPlugin({ fetch: fake.fetch });
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
