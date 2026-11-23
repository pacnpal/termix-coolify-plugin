import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAttention } from "../../src/backend/attention/service.js";
import { setSensitive } from "./containers/fixtures.js";
import { queueAnswers } from "./helpers/deployments.js";
import type { fakeCoolify } from "./helpers/fake-coolify.js";
import { lifecycleAnswers, link, startLifecycle } from "./helpers/lifecycle.js";
import type { PluginHarness } from "./helpers/plugin.js";
import { resourceLists } from "./helpers/resources.js";

/**
 * #123: a signed-in list read answers only for the revision it started
 * under. Each test repoints the connection once every request of a read has
 * been answered, so all of them went out under the old target and only a
 * check made after the fetch can tell its rows are the old target's.
 */

const MOVED_URL = "https://coolify-moved.example.test";
const LISTS = ["GET /applications", "GET /services", "GET /databases"];

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start() {
  const started = await startLifecycle({ overrides: queueAnswers() });
  harness = started.harness;
  return started;
}

/** What the fake answers for `route`, as its JSON body. */
function bodyOf(route: string): unknown {
  const answers = { ...resourceLists(), ...lifecycleAnswers() } as Record<
    string,
    { json?: unknown }
  >;
  return answers[route]!.json;
}

/**
 * Answers `routes` as before (or with the bodies given), and moves the
 * connection to MOVED_URL as the last of them is answered. Returns whether
 * it moved.
 */
function moveOnceAnswered(
  h: PluginHarness,
  fake: ReturnType<typeof fakeCoolify>,
  id: number,
  routes: string[] | Record<string, unknown>,
): () => boolean {
  const bodies = Array.isArray(routes)
    ? Object.fromEntries(routes.map((r) => [r, bodyOf(r)]))
    : routes;
  const left = new Set(Object.keys(bodies));
  let moved = false;
  for (const [route, body] of Object.entries(bodies)) {
    fake.set(route, () => {
      left.delete(route);
      if (left.size === 0 && !moved) {
        moved = true;
        h.db.sqlite
          .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
          .run(MOVED_URL, id);
      }
      return Response.json(body);
    });
  }
  return () => moved;
}

const targetChanged = { code: "target-changed", status: 409 };

describe("list reads across a connection repoint", () => {
  it("coolify.list-resources-all ends target-changed and returns no rows", async () => {
    const { harness, fake, id } = await start();
    const moved = moveOnceAnswered(harness, fake, id, LISTS);
    await expect(
      harness.mock.ctx.operations.run("coolify.list-resources-all", {
        input: { connectionId: String(id) },
      }),
    ).rejects.toMatchObject(targetChanged);
    expect(moved()).toBe(true);
  });

  it("coolify.resource-get ends target-changed instead of the old target's row", async () => {
    const { harness, fake, id } = await start();
    const moved = moveOnceAnswered(harness, fake, id, LISTS);
    await expect(
      harness.mock.ctx.operations.run("coolify.resource-get", {
        input: { connectionId: String(id), uuid: "app-web-uuid" },
      }),
    ).rejects.toMatchObject(targetChanged);
    expect(moved()).toBe(true);
  });

  it("a Linked host's coolify.list-resources ends target-changed", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const moved = moveOnceAnswered(harness, fake, id, LISTS);
    await expect(
      harness.mock.ctx.operations.run("coolify.list-resources", { hostId: 7 }),
    ).rejects.toMatchObject(targetChanged);
    expect(moved()).toBe(true);
  });

  it("the server signals read unknown, not the old target's state", async () => {
    const { harness, fake, id } = await start();
    // edge is unreachable on the old target: a stale answer would be "fail".
    link(harness, id, "srv-edge-uuid", 8);
    for (const op of ["coolify.signal-server", "coolify.signal-updates"]) {
      const moved = moveOnceAnswered(harness, fake, id, ["GET /servers"]);
      const outcome = await harness.mock.ctx.operations.run(op, { hostId: 8 });
      expect(moved(), op).toBe(true);
      expect(outcome.data, op).toMatchObject({
        status: "unknown",
        value: null,
      });
      // Back to the first target for the next signal.
      harness.db.sqlite
        .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
        .run("https://coolify.example.test", id);
    }
  });

  it("the degraded signal reads unknown, never a count of the old target", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const moved = moveOnceAnswered(harness, fake, id, LISTS);
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.signal-degraded",
      { hostId: 7 },
    );
    expect(moved()).toBe(true);
    expect(outcome.data).toMatchObject({ status: "unknown", value: null });
  });

  it("the deploying signal reads unknown when its only connection moved", async () => {
    const { harness, fake, id } = await start();
    const moved = moveOnceAnswered(harness, fake, id, LISTS);
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.signal-deploying",
      {},
    );
    expect(moved()).toBe(true);
    expect(outcome.data).toMatchObject({ status: "unknown", value: null });
  });

  it("a server signal whose statuses arrive after a repoint reads unknown", async () => {
    const { harness, id } = await start();
    link(harness, id, "srv-edge-uuid", 8);
    // The fetch's own check passes; the connection moves while its cache
    // write is slow, so only the read's last check can tell.
    const db = harness.mock.ctx.db;
    const batch = db.batch.bind(db);
    let armed = true;
    db.batch = (async (...args: Parameters<typeof batch>) => {
      if (armed) {
        armed = false;
        harness.db.sqlite
          .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
          .run(MOVED_URL, id);
      }
      return batch(...args);
    }) as typeof db.batch;
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.signal-server",
      { hostId: 8 },
    );
    expect(armed).toBe(false);
    expect(outcome.data).toMatchObject({ status: "unknown", value: null });
  });

  it("attention shows target-changed for that connection, never its old rows", async () => {
    const { harness, fake, id } = await start();
    const moved = moveOnceAnswered(harness, fake, id, [
      ...LISTS,
      "GET /servers",
    ]);
    const answer = await harness.request("GET", "/attention");
    expect(moved()).toBe(true);
    expect(answer.status).toBe(200);
    const [mine] = answer.body.connections;
    expect(mine).toMatchObject({
      id,
      error: { cause: "target-changed" },
      running: [],
      failed: [],
      degraded: [],
      unreachable: [],
    });
    expect(answer.body.counts).toEqual({
      running: 0,
      failed: 0,
      degraded: 0,
      unreachable: 0,
    });
  });

  it("attention keeps no part when the connection moved after every part was read", async () => {
    const view = {
      id: 1,
      name: "Prod",
      access: "owner",
      scoped: false,
      revision: "rev-old",
    };
    const row = {
      uuid: "app-api-uuid",
      name: "api",
      kind: "application",
      status: "running:unhealthy",
      parentUuid: null,
      serverName: "edge",
      projectName: "Shop",
      environmentName: "staging",
    };
    const attention = createAttention(
      { rbac: { has: async () => true } } as unknown as PluginContext,
      {
        connections: {
          list: async () => [view],
          access: async () => "owner",
          // Each part answered for rev-old; the connection is elsewhere now.
          revision: async () => "rev-new",
        },
        resources: { list: async () => [row] },
        servers: {
          list: async () => [
            { uuid: "srv-edge-uuid", name: "edge", reachable: false },
          ],
        },
        deployments: { queue: async () => ({ running: [], recent: [] }) },
      } as unknown as Parameters<typeof createAttention>[1],
    );
    const answer = await attention.read();
    expect(answer.connections).toEqual([
      expect.objectContaining({
        id: 1,
        error: expect.objectContaining({ cause: "target-changed" }),
        degraded: [],
        unreachable: [],
      }),
    ]);
    expect(answer.counts).toMatchObject({ degraded: 0, unreachable: 0 });
  });
});

/** The same rule for the other reads that answer what Coolify sent. */
describe("snapshot reads across a connection repoint", () => {
  it("the host sync preview ends target-changed", async () => {
    const { harness, fake, id } = await start();
    const moved = moveOnceAnswered(harness, fake, id, ["GET /servers"]);
    await expect(
      harness.mock.ctx.operations.run("coolify.sync-preview", {
        input: { connectionId: String(id) },
      }),
    ).rejects.toMatchObject(targetChanged);
    expect(moved()).toBe(true);
  });

  it("a server's update status ends target-changed", async () => {
    const { harness, fake, id } = await start();
    const moved = moveOnceAnswered(harness, fake, id, {
      "GET /servers/srv-vps1-uuid": {
        uuid: "srv-vps1-uuid",
        name: "vps1",
        settings: { is_reachable: true, is_usable: true },
      },
    });
    await expect(
      harness.mock.ctx.operations.run("coolify.server-updates", {
        input: { connectionId: String(id), serverUuid: "srv-vps1-uuid" },
      }),
    ).rejects.toMatchObject(targetChanged);
    expect(moved()).toBe(true);
  });

  it("a generic API read ends target-changed", async () => {
    const { harness, fake, id } = await start();
    const moved = moveOnceAnswered(harness, fake, id, ["GET /servers"]);
    await expect(
      harness.mock.ctx.operations.run("coolify.api-read", {
        input: { connectionId: String(id), operationId: "list-servers" },
      }),
    ).rejects.toMatchObject(targetChanged);
    expect(moved()).toBe(true);
  });

  it("a logs snapshot from Coolify ends target-changed", async () => {
    const { harness, fake, id } = await start();
    setSensitive(harness, id, true);
    // The resource list is read first (authorize), under the old target.
    await harness.mock.ctx.operations.run("coolify.list-resources-all", {
      input: { connectionId: String(id) },
    });
    const moved = moveOnceAnswered(harness, fake, id, {
      "GET /applications/app-web-uuid/logs": { logs: "old target line\n" },
    });
    await expect(
      harness.mock.ctx.operations.run("coolify.logs-tail", {
        input: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          confirm: true,
        },
      }),
    ).rejects.toMatchObject(targetChanged);
    expect(moved()).toBe(true);
  });
});
