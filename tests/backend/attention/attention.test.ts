import { afterEach, describe, expect, it } from "vitest";
import {
  deploymentRaw,
  queueAnswers,
  tagAnswers,
} from "../helpers/deployments.js";
import type { FakeCall } from "../helpers/fake-coolify.js";
import {
  grant,
  LIFECYCLE_TOKEN,
  startLifecycle,
} from "../helpers/lifecycle.js";
import {
  manifest,
  OTHER,
  OWNER,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const SECOND_TOKEN = "fake-token-second";
const MINUTE = 60_000;

const applications = (resourceLists()["GET /applications"] as { json: unknown })
  .json;

/** A time `minutes` before now, as Coolify writes it. */
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * MINUTE).toISOString();

const when = (minutes: number, ended = true) => ({
  created_at: ago(minutes + 2),
  updated_at: ago(minutes),
  finished_at: ended ? ago(minutes) : null,
});

/**
 * web: running now, a failure ten minutes ago (its latest ended one), and an
 * older finished one. api: a failure three days ago (too old to count), and
 * a failure an hour ago that a later finished deployment replaced.
 */
function histories() {
  return {
    "GET /deployments/applications/app-web-uuid": {
      json: {
        count: 3,
        deployments: [
          deploymentRaw("dep-run", "in_progress", { extra: when(1, false) }),
          deploymentRaw("dep-web-failed", "failed", { extra: when(10) }),
          deploymentRaw("dep-web-done", "finished", { extra: when(60) }),
        ],
      },
    },
    "GET /deployments/applications/app-api-uuid": {
      json: {
        count: 3,
        deployments: [
          deploymentRaw("dep-api-fixed", "finished", {
            appUuid: "app-api-uuid",
            extra: when(30),
          }),
          deploymentRaw("dep-api-replaced", "failed", {
            appUuid: "app-api-uuid",
            extra: when(60),
          }),
          deploymentRaw("dep-api-ancient", "failed", {
            appUuid: "app-api-uuid",
            extra: when(3 * 24 * 60),
          }),
        ],
      },
    },
  };
}

async function start(permissions?: string[]) {
  const started = await startLifecycle({
    permissions,
    overrides: {
      ...queueAnswers(),
      ...tagAnswers(applications),
      ...histories(),
    },
  });
  harness = started.harness;
  return started;
}

/** A second connection of the owner's, to the same fake Coolify. */
async function second(h: PluginHarness): Promise<number> {
  const created = await h.mock.ctx.operations.run("coolify.connection-create", {
    input: {
      name: "Staging",
      baseUrl: "https://coolify.example.test",
      token: SECOND_TOKEN,
    },
  });
  return (created.data as { id: number }).id;
}

function tokenOf(call: FakeCall): string {
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  return String(headers.authorization ?? "").replace(/^Bearer /, "");
}

/** Coolify reads of `path` made with `token`, after `from` calls. */
function reads(
  calls: FakeCall[],
  from: number,
  path: string,
  token: string,
): number {
  return calls
    .slice(from)
    .filter(
      (c) => c.method === "GET" && c.path === path && tokenOf(c) === token,
    ).length;
}

const uuids = (rows: { uuid: string }[]) => rows.map((r) => r.uuid);

describe("the attention read behind the sidebar panel and the rail badge", () => {
  it("serves the panel and the badge from one Coolify read per connection", async () => {
    const { harness, fake, id } = await start();
    const other = await second(harness);
    const from = fake.calls.length;
    // The panel and the badge ask at the same time, then the panel again,
    // and the operation (Operations Center, MCP) after them.
    const [panel, badge] = await Promise.all([
      harness.request("GET", "/attention"),
      harness.request("GET", "/attention"),
    ]);
    const again = await harness.request("GET", "/attention");
    await harness.mock.ctx.operations.run("coolify.attention", { input: {} });
    expect(panel.status).toBe(200);
    expect(badge.body.badge).toBe(panel.body.badge);
    expect(again.body.connections).toEqual(panel.body.connections);
    expect(panel.body.connections.map((c: { id: number }) => c.id)).toEqual([
      id,
      other,
    ]);
    for (const token of [LIFECYCLE_TOKEN, SECOND_TOKEN]) {
      expect(reads(fake.calls, from, "/deployments", token)).toBe(1);
      expect(reads(fake.calls, from, "/applications", token)).toBe(1);
      expect(reads(fake.calls, from, "/servers", token)).toBe(1);
      expect(
        reads(
          fake.calls,
          from,
          "/deployments/applications/app-web-uuid",
          token,
        ),
      ).toBe(1);
    }
    // The tab's own queue read is the same cached one.
    await harness.request("GET", `/connections/${id}/deployments`);
    expect(reads(fake.calls, from, "/deployments", LIFECYCLE_TOKEN)).toBe(1);
  });

  it("counts running deployments plus recent failures for the badge", async () => {
    const { harness, id } = await start();
    const answer = await harness.request("GET", "/attention");
    expect(answer.status).toBe(200);
    const [mine] = answer.body.connections;
    expect(mine).toMatchObject({ id, name: "Prod", error: null });
    expect(uuids(mine.running)).toEqual(["dep-run", "dep-api-queued"]);
    // Only web's: api's newer finished deployment replaced its failure, and
    // the three-day-old one is not recent.
    expect(uuids(mine.failed)).toEqual(["dep-web-failed"]);
    expect(mine.failed[0]).toMatchObject({
      resourceUuid: "app-web-uuid",
      resourceName: "web",
    });
    expect(answer.body.counts).toMatchObject({ running: 2, failed: 1 });
    expect(answer.body.badge).toBe(3);
    expect(JSON.stringify(answer.body)).not.toContain(LIFECYCLE_TOKEN);
  });

  it("lists degraded resources and unreachable servers, never exited or Parts", async () => {
    const { harness } = await start();
    const answer = await harness.request("GET", "/attention");
    const [mine] = answer.body.connections;
    // api and worker are running:unhealthy; cache is exited, which is stopped.
    expect(uuids(mine.degraded).sort((a, b) => a.localeCompare(b))).toEqual([
      "app-api-uuid",
      "app-worker-uuid",
    ]);
    expect(mine.degraded[0]).toMatchObject({ kind: "application" });
    expect(uuids(mine.unreachable)).toEqual(["srv-edge-uuid"]);
    expect(mine.unreachable[0]).toEqual({
      uuid: "srv-edge-uuid",
      name: "edge",
    });
    expect(answer.body.counts).toMatchObject({ degraded: 2, unreachable: 1 });
    // Degraded resources and servers are attention items, not badge counts.
    expect(answer.body.badge).toBe(3);
    expect(JSON.stringify(answer.body)).not.toContain("203.0.113");
  });

  it("keeps the other parts when one of a connection's reads fails", async () => {
    const { harness, fake } = await start();
    fake.set("GET /servers", { status: 500, json: { message: "boom" } });
    const answer = await harness.request("GET", "/attention");
    expect(answer.status).toBe(200);
    const [mine] = answer.body.connections;
    expect(mine.error).toMatchObject({ cause: expect.any(String) });
    expect(mine.unreachable).toEqual([]);
    expect(uuids(mine.running)).toEqual(["dep-run", "dep-api-queued"]);
    expect(answer.body.badge).toBe(3);
  });

  it("never shows a connection the user can't view", async () => {
    const { harness, fake, id } = await start();
    const from = fake.calls.length;
    const stranger = await harness.request(
      "GET",
      "/attention",
      undefined,
      OTHER,
    );
    expect(stranger.status).toBe(200);
    expect(stranger.body.connections).toEqual([]);
    expect(stranger.body.badge).toBe(0);
    expect(JSON.stringify(stranger.body)).not.toContain("Prod");
    expect(fake.calls.slice(from)).toEqual([]);

    grant(harness, id, OTHER, "view");
    const granted = await harness.request(
      "GET",
      "/attention",
      undefined,
      OTHER,
    );
    expect(granted.body.connections).toEqual([
      expect.objectContaining({ id, access: "view" }),
    ]);
    const owner = await harness.request("GET", "/attention", undefined, OWNER);
    expect(owner.body.connections[0].access).toBe("owner");
  });

  it("needs coolify.view, and reads nothing without it", async () => {
    const { harness, fake } = await start([]);
    const from = fake.calls.length;
    const refused = await harness.request("GET", "/attention");
    expect(refused.status).toBe(403);
    await expect(
      harness.mock.ctx.operations.run("coolify.attention", { input: {} }),
    ).rejects.toThrow();
    expect(fake.calls.slice(from)).toEqual([]);
  });

  it("declares coolify.attention as a read for view", async () => {
    const action = manifest.contributes!.operations!.actions!.find(
      (a) => a.id === "coolify.attention",
    );
    expect(action).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "view",
      surfaces: { assistant: true, mcp: true },
    });
    const { harness } = await start();
    const outcome = await harness.mock.ctx.operations.run("coolify.attention", {
      input: {},
    });
    expect(outcome.summary).toBe(
      "2 deployments in progress, 1 recent failure, 2 degraded resources, 1 unreachable server",
    );
    expect((outcome.data as { badge: number }).badge).toBe(3);
  });
});
