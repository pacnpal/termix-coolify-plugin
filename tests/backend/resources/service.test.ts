import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../../manifest.json";
import { defineTables, type Tables } from "../../../src/backend/db.js";
import {
  createConnections,
  type Connections,
} from "../../../src/backend/connections/service.js";
import {
  createResources,
  RESOURCE_TTL_MS,
  type Resources,
} from "../../../src/backend/resources/service.js";
import { resourceHealth } from "../../../src/shared/resource-health.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { resourceLists, SECRET } from "../helpers/resources.js";
import { byText } from "../helpers/order.js";
import { HEAVY_TEST_MS } from "../../shared/timing.js";
import { failCacheWrites } from "../helpers/cache.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;
const TOKEN = "fake-token-resources-test";

const RESOURCE_KEYS = [
  "buildPack",
  "engine",
  "environmentName",
  "fqdns",
  "id",
  "kind",
  "lastDeployAt",
  "name",
  "parentUuid",
  "projectName",
  "serverName",
  "serverUuid",
  "status",
  "uuid",
];

let db: TestDb;
let mock: MockPluginContext;
let fake: ReturnType<typeof healthyCoolify>;
/** A second Coolify at MOVED_URL, which sees only the narrower list. */
let moved: ReturnType<typeof healthyCoolify>;
const BASE_URL = "https://coolify.example.test";
const MOVED_URL = "https://coolify-moved.example.test";
let connections: Connections;
let resources: Resources;
let tables: Tables;
let clock: number;
let connectionId: number;

const NEW_TOKEN = "fake-token-resources-new";

/** A narrower token's view: one application the old token's list lacks. */
const NARROWER = {
  json: [{ id: 99, uuid: "app-only-uuid", name: "only", status: "running" }],
};

let gate: { reached: () => void; released: Promise<void> } | null = null;

/** Holds the next `/applications` answer until `release` is called. */
function holdNextApplications() {
  let reached = () => {};
  let release = () => {};
  const atFetch = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  gate = { reached, released };
  return { atFetch, release };
}

function authorizations(): (string | null)[] {
  return listCalls().map((c) =>
    new Headers(c.init?.headers as Record<string, string>).get("authorization"),
  );
}

/**
 * Holds the next cache write until `release`, as a slow database would, so
 * the write can land after an invalidate's drop.
 */
function holdNextCacheWrite() {
  const db = mock.ctx.db;
  const batch = db.batch.bind(db);
  let reached = () => {};
  let release = () => {};
  const atWrite = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let armed = true;
  db.batch = (async (...args: Parameters<typeof batch>) => {
    if (armed) {
      armed = false;
      reached();
      await released;
    }
    return batch(...args);
  }) as typeof db.batch;
  return { atWrite, release };
}

function listCalls() {
  return fake.calls.filter((c) =>
    ["/applications", "/services", "/databases", "/resources"].includes(c.path),
  );
}

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  for (const user of ["user-1", "user-2"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  fake = healthyCoolify(resourceLists());
  moved = healthyCoolify({
    "GET /applications": NARROWER,
    "GET /services": { json: [] },
    "GET /databases": { json: [] },
  });
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    db: db.database,
    fetch: async (url, init) => {
      // Coolify answers now; a held answer reaches the plugin on release.
      const response = url.startsWith(MOVED_URL)
        ? await moved.fetch(BASE_URL + url.slice(MOVED_URL.length), init)
        : await fake.fetch(url, init);
      const held = gate;
      if (held && new URL(url).pathname.endsWith("/applications")) {
        gate = null;
        held.reached();
        await held.released;
      }
      return response;
    },
    actor: "user-1",
  });
  tables = await defineTables(mock.ctx);
  connections = createConnections(mock.ctx, tables);
  clock = Date.parse("2026-11-19T10:00:00Z");
  resources = createResources(mock.ctx, {
    tables,
    connections,
    now: () => clock,
  });
  connectionId = (
    await connections.create({
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
    })
  ).id;
  fake.calls.length = 0;
});

afterEach(() => {
  gate = null;
  db.close();
});

describe("resource service", () => {
  it("merges apps, services with parts, and databases", async () => {
    const rows = await resources.list(connectionId);
    expect(rows.map((r) => `${r.kind}:${r.uuid}`)).toEqual([
      "application:app-web-uuid",
      "application:app-api-uuid",
      "application:app-worker-uuid",
      "application:app-docs-uuid",
      "application:app-blog-uuid",
      "service:svc-n8n-uuid",
      "service-application:part-n8n-uuid",
      "service-application:part-worker-uuid",
      "service-application:part-runner-uuid",
      "service-database:part-postgres-uuid",
      "service-database:part-redis-uuid",
      "database:db-main-uuid",
      "database:db-cache-uuid",
    ]);
    const parts = rows.filter((r) => r.parentUuid);
    expect(parts).toHaveLength(5);
    expect(new Set(parts.map((p) => p.parentUuid))).toEqual(
      new Set(["svc-n8n-uuid"]),
    );
    expect(rows[0]).toMatchObject({
      name: "web",
      serverUuid: "srv-vps1-uuid",
      serverName: "vps1",
      projectName: "Shop",
      environmentName: "production",
      fqdns: ["https://a.x", "https://b.x"],
      lastDeployAt: "2026-11-18T09:03:00.000000Z",
    });
    // The per-type lists, once each, and never the heavy /resources.
    expect(listCalls().map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        "GET /applications",
        "GET /services",
        "GET /databases",
      ]),
    );
    expect(listCalls()).toHaveLength(3);
    expect(fake.calls.some((c) => c.path.startsWith("/resources"))).toBe(false);
  });

  it("exited counts as stopped, not degraded", () => {
    // Coolify reports a resource you stopped yourself as exited, so exited is
    // Stopped, whatever its health suffix says.
    expect(resourceHealth("exited")).toBe("stopped");
    expect(resourceHealth("exited:unhealthy")).toBe("stopped");
    expect(resourceHealth("exited:healthy")).toBe("stopped");
    expect(resourceHealth("restarting")).toBe("degraded");
    expect(resourceHealth("dead")).toBe("degraded");
  });

  it("a bare unhealthy state is degraded", () => {
    expect(resourceHealth("unhealthy")).toBe("degraded");
    expect(resourceHealth("UNHEALTHY")).toBe("degraded");
  });

  it("status degraded covers unhealthy, restarting and degraded", async () => {
    expect(resourceHealth("running:unhealthy")).toBe("degraded");
    expect(resourceHealth("degraded:unhealthy")).toBe("degraded");
    expect(resourceHealth("running:healthy")).toBe("running");
    expect(resourceHealth("running:unknown")).toBe("running");
    expect(resourceHealth("starting")).toBe("deploying");
    expect(resourceHealth("stopped")).toBe("stopped");
    expect(resourceHealth("")).toBe("stopped");
    // Service Parts are counted through their service, not twice.
    expect(await resources.counts(connectionId)).toEqual({
      running: 3,
      degraded: 2,
      stopped: 2,
      deploying: 1,
    });
    expect(await resources.counts(connectionId, "srv-vps1-uuid")).toEqual({
      running: 3,
      degraded: 1,
      stopped: 2,
      deploying: 1,
    });
  });

  it("answers the list when the cache write fails", async () => {
    const refused = failCacheWrites(mock.ctx);
    const rows = await resources.list(connectionId);
    expect(rows).toHaveLength(13);
    expect(refused()).toBe(1);
  });

  it("second call within 20s uses the cache", async () => {
    await resources.list(connectionId);
    const fetched = fake.calls.length;
    clock += RESOURCE_TTL_MS - 1;
    await resources.list(connectionId);
    await resources.get(connectionId, "app-web-uuid");
    await resources.byServer(connectionId, "srv-vps1-uuid");
    await resources.counts(connectionId);
    expect(RESOURCE_TTL_MS).toBe(20_000);
    expect(fake.calls.length).toBe(fetched);

    clock += 2;
    await resources.list(connectionId);
    expect(listCalls()).toHaveLength(6);

    await resources.list(connectionId, { refresh: true });
    expect(listCalls()).toHaveLength(9);
  });

  it("asks Coolify once when several callers miss the cache together", async () => {
    await Promise.all([
      resources.list(connectionId),
      resources.list(connectionId),
      resources.counts(connectionId),
    ]);
    expect(listCalls()).toHaveLength(3);
  });

  it("invalidate drops the cached list", async () => {
    await resources.list(connectionId);
    await resources.invalidate(connectionId);
    await resources.list(connectionId);
    expect(listCalls()).toHaveLength(6);
  });

  it("a load after invalidate never joins or caches a fetch from before it", async () => {
    const hold = holdNextApplications();
    const before = resources.list(connectionId);
    await hold.atFetch;
    await resources.invalidate(connectionId);
    fake.set("GET /applications", NARROWER);
    const after = resources.list(connectionId);
    // Callers after invalidate share one new fetch.
    const alsoAfter = resources.list(connectionId);
    hold.release();
    const [, rows, sameRows] = await Promise.all([before, after, alsoAfter]);
    expect(rows.map((r) => r.uuid)).toContain("app-only-uuid");
    expect(sameRows).toBe(rows);
    const applications = fake.calls.filter((c) => c.path === "/applications");
    expect(applications).toHaveLength(2);

    fake.calls.length = 0;
    const cached = (await resources.list(connectionId)).map((r) => r.uuid);
    expect(listCalls()).toHaveLength(0);
    expect(cached).toContain("app-only-uuid");
    expect(cached).not.toContain("app-web-uuid");
  });

  it("a cache write held past an invalidate is never served", async () => {
    // The write is held past invalidate's generation change; its drop is
    // queued behind the write (cache.ts), so it lands first.
    const hold = holdNextCacheWrite();
    const stale = resources.list(connectionId);
    await hold.atWrite;
    const invalidated = resources.invalidate(connectionId);
    hold.release();
    await Promise.all([stale, invalidated]);

    fake.set("GET /applications", NARROWER);
    fake.calls.length = 0;
    const uuids = (await resources.list(connectionId)).map((r) => r.uuid);
    expect(listCalls().length).toBeGreaterThan(0);
    expect(uuids).toContain("app-only-uuid");
    expect(uuids).not.toContain("app-web-uuid");
  });

  it("a cache write that landed after invalidate is not served after a restart", async () => {
    const hold = holdNextCacheWrite();
    const stale = resources.list(connectionId);
    await hold.atWrite;
    const invalidated = resources.invalidate(connectionId);
    hold.release();
    await Promise.all([stale, invalidated]);

    // A restart: a new instance over the same tables, with the row still there.
    const restarted = createResources(mock.ctx, {
      tables,
      connections,
      now: () => clock,
    });
    fake.set("GET /applications", NARROWER);
    fake.calls.length = 0;
    const uuids = (await restarted.list(connectionId)).map((r) => r.uuid);
    expect(listCalls().length).toBeGreaterThan(0);
    expect(uuids).toContain("app-only-uuid");
    expect(uuids).not.toContain("app-web-uuid");
  });

  it("a token change stops serving resources cached under the old token", async () => {
    await resources.list(connectionId);
    await connections.update(connectionId, { token: NEW_TOKEN });
    fake.set("GET /applications", NARROWER);
    fake.calls.length = 0;
    const uuids = (await resources.list(connectionId)).map((r) => r.uuid);
    expect(uuids).toContain("app-only-uuid");
    expect(uuids).not.toContain("app-web-uuid");
    expect(authorizations().length).toBeGreaterThan(0);
    for (const auth of authorizations()) {
      expect(auth).toBe(`Bearer ${NEW_TOKEN}`);
    }
  });

  it("a new address stops serving resources cached from the old one", async () => {
    await resources.list(connectionId);
    await connections.update(connectionId, { baseUrl: MOVED_URL });
    fake.calls.length = 0;
    moved.calls.length = 0;
    const uuids = (await resources.list(connectionId)).map((r) => r.uuid);
    expect(uuids).toEqual(["app-only-uuid"]);
    expect(listCalls()).toHaveLength(0);
    expect(moved.calls.filter((c) => c.path === "/applications")).toHaveLength(
      1,
    );
  });

  it("a fetch in flight during a token change does not repopulate the cache", async () => {
    const hold = holdNextApplications();
    const stale = resources.list(connectionId);
    await hold.atFetch;
    await connections.update(connectionId, { token: NEW_TOKEN });
    fake.set("GET /applications", NARROWER);
    // A caller after the change gets its own fetch, not the old one.
    const fresh = (await resources.list(connectionId)).map((r) => r.uuid);
    expect(fresh).toContain("app-only-uuid");
    hold.release();
    await stale;
    fake.calls.length = 0;
    const uuids = (await resources.list(connectionId)).map((r) => r.uuid);
    expect(uuids).toContain("app-only-uuid");
    expect(uuids).not.toContain("app-web-uuid");
    for (const auth of authorizations()) {
      expect(auth).toBe(`Bearer ${NEW_TOKEN}`);
    }
  });

  it("other user 404", async () => {
    // The owner fills the cache; the other user must not be served from it.
    await resources.list(connectionId);
    const fetched = fake.calls.length;
    mock.setActor("user-2");
    for (const call of [
      () => resources.list(connectionId),
      () => resources.get(connectionId, "app-web-uuid"),
      () => resources.byServer(connectionId, "srv-vps1-uuid"),
      () => resources.counts(connectionId),
    ]) {
      await expect(call()).rejects.toMatchObject({
        status: 404,
        code: "not-found",
      });
    }
    expect(fake.calls.length).toBe(fetched);
  });

  it("no Coolify secret field survives into the resource DTOs or the cache", async () => {
    const rows = await resources.list(connectionId);
    for (const row of rows) {
      expect(Object.keys(row).sort(byText), row.uuid).toEqual(RESOURCE_KEYS);
    }
    const answers = [
      rows,
      await resources.get(connectionId, "app-web-uuid"),
      await resources.get(connectionId, "part-postgres-uuid"),
      await resources.byServer(connectionId, "srv-edge-uuid"),
    ];
    for (const answer of answers) {
      expect(JSON.stringify(answer)).not.toContain(SECRET);
    }
    const cached = db.sqlite
      .prepare("SELECT kind, json FROM p_coolify_cache")
      .all() as { kind: string; json: string }[];
    expect(cached.map((c) => c.kind)).toEqual(["resources"]);
    expect(cached[0].json).not.toContain(SECRET);
    expect(cached[0].json).not.toContain(TOKEN);
  });

  it("get finds a resource or a Part by uuid, and byServer filters", async () => {
    expect(await resources.get(connectionId, "part-redis-uuid")).toMatchObject({
      kind: "service-database",
      parentUuid: "svc-n8n-uuid",
      engine: "redis:7-alpine",
    });
    expect(await resources.get(connectionId, "missing-uuid")).toBeNull();
    const edge = await resources.byServer(connectionId, "srv-edge-uuid");
    expect(edge.map((r) => r.uuid)).toEqual(["app-api-uuid"]);
  });

  // Fixed work: GET retries wait out the request layer's real backoff
  // (0.5 s, then 1.5 s), so it takes 2 s idle; a busy machine stretched
  // past Vitest's 5 s (#105). An explicit timeout keeps a wide margin.
  it(
    "lets a Coolify failure through as a CoolifyError and caches nothing",
    async () => {
      fake.set("GET /services", { status: 500, json: { message: "boom" } });
      await expect(resources.list(connectionId)).rejects.toMatchObject({
        name: "CoolifyError",
      });
      const cached = db.sqlite
        .prepare("SELECT count(*) AS n FROM p_coolify_cache")
        .get() as { n: number };
      expect(cached.n).toBe(0);
    },
    HEAVY_TEST_MS,
  );
});
