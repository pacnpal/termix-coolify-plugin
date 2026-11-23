import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { defineTables, type Tables } from "../../src/backend/db.js";
import { createCache, type Cache } from "../../src/backend/cache.js";
import {
  createConnections,
  type Connections,
} from "../../src/backend/connections/service.js";
import { healthyCoolify } from "./helpers/fake-coolify.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

let db: TestDb;
let mock: MockPluginContext;
let tables: Tables;
let cache: Cache;
let connectionId: number;

type Batch = MockPluginContext["ctx"]["db"]["batch"];
type Query = Parameters<Batch>[0][number];

/** One macrotask, so every other ready write gets to run its next step. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function turns(n: number) {
  for (let i = 0; i < n; i += 1) await turn();
}

/**
 * Runs each statement of a batch on its own, with a turn between them, as
 * two transactions on Postgres or MySQL do: neither sees the other's insert
 * before it commits, so two batches of one key can both delete nothing.
 */
function interleaveBatches() {
  mock.ctx.db.batch = (async (queries: Query[]) => {
    for (const query of queries) {
      const { sql, params } = query.toSQL();
      db.sqlite.prepare(sql).run(...params);
      await turn();
    }
  }) as Batch;
}

/** Holds the next batch until `release`, as a slow database would. */
function holdNextBatch() {
  const batch = mock.ctx.db.batch.bind(mock.ctx.db);
  let reached = () => {};
  let release = () => {};
  const atBatch = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let armed = true;
  mock.ctx.db.batch = (async (queries: Query[]) => {
    if (armed) {
      armed = false;
      reached();
      await released;
    }
    return batch(queries);
  }) as Batch;
  return { atBatch, release };
}

function rows(kind?: string): { kind: string; json: string }[] {
  const all = db.sqlite
    .prepare("SELECT kind, json FROM p_coolify_cache WHERE connection_id = ?")
    .all(connectionId) as { kind: string; json: string }[];
  return kind ? all.filter((r) => r.kind === kind) : all;
}

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
    .run("user-1", "user-1");
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    db: db.database,
    fetch: healthyCoolify({}).fetch,
    actor: "user-1",
  });
  tables = await defineTables(mock.ctx);
  const connections: Connections = createConnections(mock.ctx, tables);
  connectionId = (
    await connections.create({
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: "fake-token-cache-test",
    })
  ).id;
  cache = createCache(mock.ctx, tables);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("cache writes", () => {
  it("two concurrent writes of one key both resolve and the later value is kept", async () => {
    interleaveBatches();
    const first = cache.write(connectionId, "resources", { n: 1 }, 1_000);
    const second = cache.write(connectionId, "resources", { n: 2 }, 2_000);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(rows("resources").map((r) => JSON.parse(r.json))).toEqual([
      { n: 2 },
    ]);
  });

  it("a write that fails resolves and logs only the error's name", async () => {
    const secret = "fake-secret-in-error-message";
    mock.ctx.db.batch = (async () => {
      throw new TypeError(secret);
    }) as Batch;
    const warn = vi.spyOn(mock.ctx.log, "warn");
    await expect(
      cache.write(connectionId, "resources", { n: 1 }, 1_000),
    ).resolves.toBeUndefined();
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(secret);
  });

  it("a drop called after a write started leaves no row", async () => {
    const held = holdNextBatch();
    const write = cache.write(connectionId, "resources", { n: 1 }, 1_000);
    await held.atBatch;
    const drop = cache.drop(connectionId, "resources");
    // Time for a drop that doesn't wait to finish before the write lands.
    await turns(5);
    held.release();
    await Promise.all([write, drop]);
    expect(rows("resources")).toEqual([]);
  });

  it("a drop of every kind waits for the connection's writes of each kind", async () => {
    const held = holdNextBatch();
    const write = cache.write(connectionId, "servers", { n: 1 }, 1_000);
    await held.atBatch;
    const drop = cache.drop(connectionId);
    await turns(5);
    held.release();
    await Promise.all([write, drop]);
    expect(rows()).toEqual([]);
  });

  it("a write started after a drop of every kind lands after it", async () => {
    await cache.write(connectionId, "resources", { n: 1 }, 1_000);
    const held = holdNextBatch();
    const earlier = cache.write(connectionId, "servers", { n: 1 }, 1_000);
    await held.atBatch;
    const drop = cache.drop(connectionId);
    const later = cache.write(connectionId, "resources", { n: 2 }, 2_000);
    await turns(5);
    held.release();
    await Promise.all([earlier, drop, later]);
    expect(rows().map((r) => [r.kind, JSON.parse(r.json)])).toEqual([
      ["resources", { n: 2 }],
    ]);
  });

  it("writes of other keys don't wait for a held one", async () => {
    const held = holdNextBatch();
    const slow = cache.write(connectionId, "servers", { n: 1 }, 1_000);
    await held.atBatch;
    await cache.write(connectionId, "resources", { n: 2 }, 2_000);
    expect(rows("resources")).toHaveLength(1);
    held.release();
    await slow;
    expect(rows("servers")).toHaveLength(1);
  });
});
