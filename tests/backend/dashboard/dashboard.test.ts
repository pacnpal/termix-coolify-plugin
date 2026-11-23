import { afterEach, describe, expect, it } from "vitest";
import type { FakeCall } from "../helpers/fake-coolify.js";
import {
  grant,
  LIFECYCLE_TOKEN,
  lifecycleAnswers,
  startLifecycle,
} from "../helpers/lifecycle.js";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Coolify's /vulnerabilities, worst first, with fake names. */
const VULNERABILITIES = {
  json: {
    resources: [
      {
        uuid: "app-web-uuid",
        name: "web",
        type: "application",
        server_uuid: "srv-vps1-uuid",
        images: { update: 1, total: 1 },
        security: {
          status: "update_now",
          label: "Update now",
          problem_count: 7,
          exploited_count: 1,
          any_exploited: true,
          critical_count: 2,
          high_count: 3,
          medium_count: 2,
          checked_at: "2026-11-21T10:00:00Z",
        },
      },
      {
        uuid: "db-main-uuid",
        name: "main",
        type: "database",
        security: {
          status: "update_available",
          problem_count: 2,
          exploited_count: 0,
          critical_count: 0,
          high_count: 1,
          medium_count: 1,
        },
      },
      {
        uuid: "svc-n8n-uuid",
        name: "n8n",
        type: "service",
        security: { status: "no_fix", problem_count: 1, medium_count: 1 },
      },
      {
        uuid: "app-api-uuid",
        name: "api",
        type: "application",
        security: { status: "ok", problem_count: 0 },
      },
      {
        uuid: "app-worker-uuid",
        name: "worker",
        type: "application",
        security: { status: "not_checked" },
      },
    ],
  },
};

async function start(permissions?: string[]) {
  const started = await startLifecycle({
    permissions,
    overrides: { "GET /vulnerabilities": VULNERABILITIES },
  });
  harness = started.harness;
  return started;
}

const readsOf = (calls: FakeCall[], from: number, path: string) =>
  calls.slice(from).filter((c) => c.method === "GET" && c.path === path).length;

describe("the connection overview behind the dashboard card", () => {
  it("counts resources by status and servers, from the caches the tab reads", async () => {
    const { harness, fake, id } = await start();
    // The tab has already read both lists.
    await harness.request("GET", `/connections/${id}/resources`);
    await harness.request("GET", `/connections/${id}/server-health`);
    const from = fake.calls.length;
    const answer = await harness.request("GET", `/connections/${id}/overview`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      connectionId: id,
      // api and worker are running:unhealthy; one resource is stopped and
      // cache is exited, which counts as stopped too. Parts are left out.
      counts: { degraded: 2, stopped: 2, deploying: 1 },
      servers: { total: 2, unreachable: 1, unusable: 1 },
      fetchedAt: expect.any(String),
    });
    expect(answer.body.total).toBe(
      Object.values(answer.body.counts as Record<string, number>).reduce(
        (a, b) => a + b,
        0,
      ),
    );
    // Nothing of its own: both lists came from the shared caches.
    expect(fake.calls.slice(from)).toEqual([]);
    expect(JSON.stringify(answer.body)).not.toContain("203.0.113");
    expect(JSON.stringify(answer.body)).not.toContain(LIFECYCLE_TOKEN);

    const op = await harness.mock.ctx.operations.run(
      "coolify.connection-overview",
      { input: { connectionId: String(id) } },
    );
    expect(op.data).toEqual(answer.body);
    expect(op.summary).toMatch(/2 degraded/);
    expect(fake.calls.slice(from)).toEqual([]);
  });

  it("answers counts without servers when the token can't read servers", async () => {
    const { harness, fake, id } = await start();
    fake.set("GET /servers", { status: 403, json: { message: "denied" } });
    const answer = await harness.request("GET", `/connections/${id}/overview`);
    expect(answer.status).toBe(200);
    expect(answer.body.servers).toBeNull();
    expect(answer.body.counts).toMatchObject({ degraded: 2 });
  });

  it("is another user's 404 until shared, and needs coolify.view", async () => {
    const { harness, fake, id } = await start();
    const from = fake.calls.length;
    const stranger = await harness.request(
      "GET",
      `/connections/${id}/overview`,
      undefined,
      OTHER,
    );
    expect(stranger.status).toBe(404);
    expect(fake.calls.slice(from)).toEqual([]);
    grant(harness, id, OTHER, "view");
    const shared = await harness.request(
      "GET",
      `/connections/${id}/overview`,
      undefined,
      OTHER,
    );
    expect(shared.status).toBe(200);
  });

  it("refuses without coolify.view and reads nothing", async () => {
    const { harness, fake, id } = await start([]);
    const from = fake.calls.length;
    const refused = await harness.request("GET", `/connections/${id}/overview`);
    expect(refused.status).toBe(403);
    expect(fake.calls.slice(from)).toEqual([]);
  });
});

describe("the vulnerability summary behind the dashboard card", () => {
  it("counts resources by security status and problems by severity", async () => {
    const { harness, id } = await start();
    const answer = await harness.request(
      "GET",
      `/connections/${id}/vulnerabilities`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      connectionId: id,
      resources: 5,
      affected: 3,
      statuses: {
        updateNow: 1,
        updateAvailable: 1,
        noFix: 1,
        checkNeeded: 0,
        ok: 1,
        notChecked: 1,
      },
      problems: { total: 10, critical: 2, high: 4, medium: 4, exploited: 1 },
      fetchedAt: expect.any(String),
    });
    // Counts only: no Coolify names or labels leave the plugin.
    expect(JSON.stringify(answer.body)).not.toContain("web");
    expect(JSON.stringify(answer.body)).not.toContain("Update now");
  });

  it("shares one cached Coolify read between the card, the operation and a second card", async () => {
    const { harness, fake, id } = await start();
    const from = fake.calls.length;
    const [a, b] = await Promise.all([
      harness.request("GET", `/connections/${id}/vulnerabilities`),
      harness.request("GET", `/connections/${id}/vulnerabilities`),
    ]);
    const op = await harness.mock.ctx.operations.run(
      "coolify.vulnerability-summary",
      { input: { connectionId: String(id) } },
    );
    expect(a.body).toEqual(b.body);
    expect(op.data).toEqual(a.body);
    expect(op.summary).toMatch(/3 of 5 resources/);
    expect(readsOf(fake.calls, from, "/vulnerabilities")).toBe(1);
    // refresh skips the cache.
    await harness.request(
      "GET",
      `/connections/${id}/vulnerabilities?refresh=1`,
    );
    expect(readsOf(fake.calls, from, "/vulnerabilities")).toBe(2);
  });

  it("never serves a summary read before the connection's token changed", async () => {
    const { harness, fake, id } = await start();
    await harness.request("GET", `/connections/${id}/vulnerabilities`);
    const updated = await harness.request("PATCH", `/connections/${id}`, {
      token: "fake-token-replacement",
    });
    expect(updated.status).toBe(200);
    const from = fake.calls.length;
    await harness.request("GET", `/connections/${id}/vulnerabilities`);
    expect(readsOf(fake.calls, from, "/vulnerabilities")).toBe(1);
  });

  it("is another user's 404, and refuses without coolify.view", async () => {
    const { harness, fake, id } = await start();
    const from = fake.calls.length;
    const stranger = await harness.request(
      "GET",
      `/connections/${id}/vulnerabilities`,
      undefined,
      OTHER,
    );
    expect(stranger.status).toBe(404);
    expect(readsOf(fake.calls, from, "/vulnerabilities")).toBe(0);
  });

  it("needs coolify.view and asks Coolify nothing without it", async () => {
    const { harness, fake, id } = await start([]);
    const from = fake.calls.length;
    const refused = await harness.request(
      "GET",
      `/connections/${id}/vulnerabilities`,
    );
    expect(refused.status).toBe(403);
    expect(readsOf(fake.calls, from, "/vulnerabilities")).toBe(0);
  });
});

describe("dashboard reads answer only for the target they started on", () => {
  const FIXTURES = { ...resourceLists(), ...lifecycleAnswers() };

  it.each([
    ["the overview", "/overview", "GET /applications"],
    ["the overview", "/overview", "GET /servers"],
    ["the resource card's list", "/resources", "GET /applications"],
  ])(
    "%s (%s) answers target-changed when the connection moves during %s",
    async (_what, path, route) => {
      const { harness, fake, id } = await start();
      const body = (FIXTURES[route] as { json: unknown }).json;
      // The connection gets a new address (so a new revision) while this
      // read is out, as an edit landing at that moment would.
      fake.set(route, () => {
        harness.db.sqlite
          .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
          .run("https://coolify-moved.example.test", id);
        return Response.json(body);
      });
      const answer = await harness.request("GET", `/connections/${id}${path}`);
      expect(answer.status).toBe(409);
      expect(answer.body.cause).toBe("target-changed");
    },
  );
});
