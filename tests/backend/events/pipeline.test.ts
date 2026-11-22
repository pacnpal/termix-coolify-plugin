import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../../manifest.json";
import { defineTables } from "../../../src/backend/db.js";
import {
  createConnections,
  type Connections,
} from "../../../src/backend/connections/service.js";
import { createSync } from "../../../src/backend/sync/service.js";
import {
  createEvents,
  createEventStore,
  EVENT_LOG_LIMIT,
  type Events,
  type EventStore,
  type SourceEvent,
} from "../../../src/backend/events/service.js";
import { EVENT_KINDS } from "../../../src/backend/events/kinds.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { HEAVY_TEST_MS } from "../../shared/timing.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;
const OWNER = "user-1";
const OTHER = "user-2";
const TOKEN = "fake-token-events-owner";
const OTHER_TOKEN = "fake-token-events-other";

let db: TestDb;
let mock: MockPluginContext;
let connections: Connections;
let events: Events;
let store: EventStore;
let clock: number;
let own: number;
let others: number;

async function revisionOf(id: number, user = OWNER): Promise<string> {
  mock.setActor(user);
  const revision = await connections.revision(id);
  mock.setActor(OWNER);
  return revision!;
}

/** What a poller or webhook would hand the pipeline, for connection `id`. */
async function ingest(id: number, event: SourceEvent, user = OWNER) {
  // Sources run with no actor: the pipeline must not need one.
  const revision = await revisionOf(id, user);
  mock.setActor(undefined);
  try {
    return await events.ingest(id, event, { revision });
  } finally {
    mock.setActor(OWNER);
  }
}

function rows(connectionId: number) {
  return db.sqlite
    .prepare(
      "SELECT * FROM p_coolify_events WHERE connection_id = ? ORDER BY id",
    )
    .all(connectionId) as Record<string, unknown>[];
}

function link(connectionId: number, serverUuid: string, hostId: number) {
  db.sqlite
    .prepare(
      "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
    )
    .run(connectionId, serverUuid, hostId);
}

const failedDeploy = (deploymentUuid: string): SourceEvent => ({
  kind: "deployment-failed",
  source: "poll",
  resourceUuid: "app-web-uuid",
  serverUuid: "srv-vps1-uuid",
  deploymentUuid,
  name: "web",
  status: "failed",
});

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  for (const user of [OWNER, OTHER]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  const fake = healthyCoolify();
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    db: db.database,
    fetch: fake.fetch,
    actor: OWNER,
  });
  const tables = await defineTables(mock.ctx);
  connections = createConnections(mock.ctx, tables);
  const sync = await createSync(mock.ctx, { tables, connections });
  clock = Date.parse("2026-11-19T10:00:30.000Z");
  store = createEventStore(mock.ctx, tables);
  events = createEvents(mock.ctx, {
    tables,
    connections,
    sync,
    now: () => clock,
    store,
  });
  own = (
    await connections.create({
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
    })
  ).id;
  mock.setActor(OTHER);
  others = (
    await connections.create({
      name: "Theirs",
      baseUrl: "https://coolify-other.example.test",
      token: OTHER_TOKEN,
    })
  ).id;
  mock.setActor(OWNER);
});

afterEach(() => {
  db.close();
});

describe("event kinds", () => {
  it("every kind is a declared operations event, and every declared event a kind", () => {
    const declared = manifest
      .contributes!.operations!.events!.map((e) => e.id)
      .sort();
    expect(Object.keys(EVENT_KINDS).map((k) => `coolify.${k}`)).toEqual(
      expect.arrayContaining(declared),
    );
    expect(declared).toEqual(
      Object.keys(EVENT_KINDS)
        .map((k) => `coolify.${k}`)
        .sort(),
    );
    // hostId comes only with a Linked server, so no event may need one.
    for (const event of manifest.contributes!.operations!.events!) {
      expect(event.scope).toBe("server");
    }
  });
});

describe("dedupe", () => {
  it("two events with the same deployment uuid store and emit once", async () => {
    expect(await ingest(own, failedDeploy("dep-1"))).toMatchObject({
      outcome: "stored",
    });
    // A minute later, from the other source and even as another kind.
    clock += 90_000;
    expect(
      await ingest(own, {
        ...failedDeploy("dep-1"),
        kind: "deployment-finished",
        source: "webhook",
        status: "finished",
      }),
    ).toEqual({ outcome: "duplicate" });
    expect(rows(own)).toHaveLength(1);
    expect(mock.operationEvents.map((e) => e.eventId)).toEqual([
      "coolify.deployment-failed",
    ]);
    // Another deployment is another event.
    expect(await ingest(own, failedDeploy("dep-2"))).toMatchObject({
      outcome: "stored",
    });
    expect(mock.operationEvents).toHaveLength(2);
  });

  it("dedupes by event, resource and minute, and a new minute is a new event", async () => {
    const limit: SourceEvent = {
      kind: "restart-limit",
      source: "poll",
      resourceUuid: "app-web-uuid",
      name: "web",
    };
    clock = Date.parse("2026-11-19T10:00:00.000Z");
    expect(await ingest(own, limit)).toMatchObject({ outcome: "stored" });
    clock = Date.parse("2026-11-19T10:00:59.999Z");
    expect(await ingest(own, { ...limit, source: "webhook" })).toEqual({
      outcome: "duplicate",
    });
    // Other resource, other kind: not the same event.
    expect(
      await ingest(own, { ...limit, resourceUuid: "app-api-uuid" }),
    ).toMatchObject({ outcome: "stored" });
    expect(
      await ingest(own, { ...limit, kind: "container-restarted" }),
    ).toMatchObject({ outcome: "stored" });
    // The next minute starts exactly at :00.000.
    clock = Date.parse("2026-11-19T10:01:00.000Z");
    expect(await ingest(own, limit)).toMatchObject({ outcome: "stored" });
    expect(rows(own)).toHaveLength(4);
    expect(mock.operationEvents).toHaveLength(4);
  });

  it("the minute is the source's own time when it gives one", async () => {
    const at = Date.parse("2026-11-19T09:58:10.000Z");
    const disk: SourceEvent = {
      kind: "high-disk",
      source: "webhook",
      serverUuid: "srv-vps1-uuid",
      at,
    };
    expect(await ingest(own, disk)).toMatchObject({ outcome: "stored" });
    clock += 5 * 60_000;
    // The poller sees the same thing later, stamped with the same minute.
    expect(
      await ingest(own, { ...disk, source: "poll", at: at + 30_000 }),
    ).toEqual({ outcome: "duplicate" });
    // A time in the future is not trusted: the clock's minute is used.
    expect(
      await ingest(own, { ...disk, at: clock + 24 * 60 * 60_000 }),
    ).toMatchObject({ outcome: "stored" });
    expect(await ingest(own, disk)).toMatchObject({ outcome: "duplicate" });
  });

  it("the same event on two connections is stored on each", async () => {
    await ingest(own, failedDeploy("dep-1"));
    await ingest(others, failedDeploy("dep-1"), OTHER);
    expect(rows(own)).toHaveLength(1);
    expect(rows(others)).toHaveLength(1);
  });
});

describe("event log", () => {
  it(
    "keeps the newest 1000 per connection",
    async () => {
      expect(EVENT_LOG_LIMIT).toBe(1000);
      const insert = db.sqlite.prepare(
        "INSERT INTO p_coolify_events (connection_id, kind, title, dedupe_key, created_at) VALUES (?, 'high-disk', 'old', ?, '2026-11-01T00:00:00.000Z')",
      );
      for (let i = 0; i < EVENT_LOG_LIMIT; i += 1) insert.run(own, `old-${i}`);
      insert.run(others, "theirs-0");
      const oldest = rows(own)[0].id as number;
      await ingest(own, failedDeploy("dep-new-1"));
      await ingest(own, failedDeploy("dep-new-2"));
      const kept = rows(own);
      expect(kept).toHaveLength(EVENT_LOG_LIMIT);
      expect(kept.map((r) => r.id)).not.toContain(oldest);
      expect(kept.map((r) => r.id)).not.toContain(oldest + 1);
      expect(kept.at(-1)).toMatchObject({ deployment_uuid: "dep-new-2" });
      // Another connection's log is its own.
      expect(rows(others)).toHaveLength(1);
    },
    HEAVY_TEST_MS,
  );

  it("removing a connection removes its events, and later events for it are dropped", async () => {
    await ingest(own, failedDeploy("dep-1"));
    await ingest(others, failedDeploy("dep-1"), OTHER);
    const revision = await revisionOf(own);
    await connections.remove(own);
    expect(rows(own)).toEqual([]);
    expect(rows(others)).toHaveLength(1);
    mock.setActor(undefined);
    expect(
      await events.ingest(own, failedDeploy("dep-2"), { revision }),
    ).toEqual({ outcome: "dropped", reason: "connection-gone" });
    mock.setActor(OWNER);
    expect(rows(own)).toEqual([]);
    expect(mock.operationEvents).toHaveLength(2);
  });

  it("an event read under an older target is dropped", async () => {
    mock.setActor(undefined);
    expect(
      await events.ingest(own, failedDeploy("dep-1"), { revision: "stale" }),
    ).toEqual({ outcome: "dropped", reason: "target-changed" });
    mock.setActor(OWNER);
    expect(rows(own)).toEqual([]);
    expect(mock.operationEvents).toEqual([]);
  });

  it("a connection whose owner lost coolify.view gets no events", async () => {
    const hasFor = vi.spyOn(mock.ctx.rbac, "hasFor").mockResolvedValue(false);
    expect(await ingest(own, failedDeploy("dep-1"))).toEqual({
      outcome: "dropped",
      reason: "no-access",
    });
    expect(hasFor).toHaveBeenCalledWith(OWNER, "view");
    expect(rows(own)).toEqual([]);
    expect(mock.operationEvents).toEqual([]);
  });

  it("an event the pipeline doesn't know or that lacks its subject is dropped", async () => {
    const bad: unknown[] = [
      { kind: "made-up", source: "poll", resourceUuid: "app-web-uuid" },
      { kind: "restart-limit", source: "poll" },
      { kind: "high-disk", source: "poll", resourceUuid: "app-web-uuid" },
      { kind: "restart-limit", source: "carrier-pigeon", resourceUuid: "a" },
      { kind: "restart-limit", source: "poll", resourceUuid: "../servers" },
      { kind: "restart-limit", source: "poll", resourceUuid: "a b" },
      null,
    ];
    for (const event of bad) {
      expect(await ingest(own, event as SourceEvent)).toEqual({
        outcome: "dropped",
        reason: "invalid",
      });
    }
    expect(rows(own)).toEqual([]);
    expect(mock.operationEvents).toEqual([]);
    // A team-wide event needs no subject.
    expect(
      await ingest(own, { kind: "token-expiring", source: "webhook" }),
    ).toMatchObject({ outcome: "stored" });
  });
});

describe("redaction", () => {
  it("stores and emits nothing secret, credentialed or log-shaped from what Coolify sent", async () => {
    const answer = await ingest(own, {
      kind: "backup-failed",
      source: "webhook",
      resourceUuid: "db-main-uuid",
      serverUuid: "srv-vps1-uuid",
      name: `main ${TOKEN}`,
      status: "failed: Authorization: Bearer fake-bearer-events-1234",
      fields: {
        token: "fake-field-token-5678",
        api_key: "fake-api-key-90",
        url: "https://backup:fake-url-pass@s3.example.test/bucket?X-Amz-Signature=fake-sig",
        message: `dump failed\nDB_PASSWORD=fake-log-pass\n${TOKEN}`,
        logs: "pg_dump: a log line",
        output: "more output",
        backup_log: "and more",
        detail:
          "-----BEGIN FAKE PRIVATE KEY-----\nfake-key-body\n-----END FAKE PRIVATE KEY-----",
        nested: { password: "fake-nested-pass" },
        list: ["fake-list-item"],
        size_mb: 12,
        ok: false,
        frequency: "0 0 * * *",
      },
    });
    expect(answer).toMatchObject({ outcome: "stored" });
    const stored = JSON.stringify(rows(own));
    const emitted = JSON.stringify(mock.operationEvents);
    const returned = JSON.stringify(answer);
    for (const text of [stored, emitted, returned]) {
      for (const secret of [
        TOKEN,
        "fake-bearer-events-1234",
        "fake-field-token-5678",
        "fake-api-key-90",
        "fake-url-pass",
        "fake-sig",
        "fake-log-pass",
        "pg_dump",
        "more output",
        "and more",
        "fake-key-body",
        "fake-nested-pass",
        "fake-list-item",
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    const [row] = rows(own);
    const detail = JSON.parse(row.detail as string);
    expect(detail.fields).toEqual({
      token: "[redacted]",
      api_key: "[redacted]",
      url: "https://backup:[redacted]@s3.example.test/bucket?X-Amz-Signature=[redacted]",
      // Only the first line of a text survives: the rest reads as log text.
      message: "dump failed",
      detail: expect.not.stringContaining("fake-key-body"),
      size_mb: 12,
      ok: false,
      frequency: "0 0 * * *",
    });
    expect(detail.name).toBe("main [redacted]");
    expect(mock.operationEvents[0].payload).toMatchObject({
      name: "main [redacted]",
      uuid: "db-main-uuid",
    });
  });

  it("caps long text", async () => {
    await ingest(own, {
      kind: "task-failed",
      source: "poll",
      resourceUuid: "app-web-uuid",
      name: "n".repeat(5000),
      fields: { message: "m".repeat(5000) },
    });
    const detail = JSON.parse(rows(own)[0].detail as string);
    expect(detail.name.length).toBeLessThanOrEqual(255);
    expect(detail.fields.message.length).toBeLessThanOrEqual(500);
  });
});

describe("hostId", () => {
  it("is set only when the subject's server is Linked", async () => {
    link(own, "srv-vps1-uuid", 7);
    await ingest(own, failedDeploy("dep-linked"));
    await ingest(own, {
      ...failedDeploy("dep-unlinked"),
      serverUuid: "srv-edge-uuid",
    });
    await ingest(own, { ...failedDeploy("dep-no-server"), serverUuid: null });
    // The same server linked on another connection doesn't count.
    link(others, "srv-other-uuid", 9);
    await ingest(own, {
      kind: "server-unreachable",
      source: "poll",
      serverUuid: "srv-other-uuid",
    });
    expect(mock.operationEvents.map((e) => e.hostId)).toEqual([
      7,
      undefined,
      undefined,
      undefined,
    ]);
    expect(rows(own).map((r) => r.host_id)).toEqual([7, null, null, null]);
    expect(mock.operationEvents[0]).toEqual({
      eventId: "coolify.deployment-failed",
      hostId: 7,
      payload: {
        connectionId: own,
        uuid: "app-web-uuid",
        name: "web",
        deploymentUuid: "dep-linked",
        status: "failed",
      },
    });
  });
});

describe("emitted payloads", () => {
  it("hold exactly the keys manifest.json declares for each kind", async () => {
    const subjects = {
      resource: { resourceUuid: "app-web-uuid", serverUuid: "srv-vps1-uuid" },
      server: { serverUuid: "srv-vps1-uuid" },
      any: { resourceUuid: "app-web-uuid" },
      team: {},
    };
    for (const [kind, { subject }] of Object.entries(EVENT_KINDS)) {
      await ingest(own, {
        kind: kind as SourceEvent["kind"],
        source: "poll",
        name: "x",
        ...subjects[subject],
      });
    }
    const declared = new Map(
      manifest.contributes!.operations!.events!.map((e) => [
        e.id,
        e.payload!.map((f) => f.key).sort(),
      ]),
    );
    expect(mock.operationEvents).toHaveLength(Object.keys(EVENT_KINDS).length);
    for (const event of mock.operationEvents) {
      expect(Object.keys(event.payload as object).sort()).toEqual(
        declared.get(event.eventId),
      );
    }
  });
});

describe("reading the log", () => {
  it("lists newest first, a page at a time, with filters", async () => {
    await ingest(own, failedDeploy("dep-1"));
    clock += 60_000;
    await ingest(own, {
      kind: "server-unreachable",
      source: "poll",
      serverUuid: "srv-vps1-uuid",
      name: "vps1",
    });
    clock += 60_000;
    await ingest(own, failedDeploy("dep-2"));
    const page = await events.list(own, { limit: 2 });
    expect(page.rows.map((r) => r.kind)).toEqual([
      "deployment-failed",
      "server-unreachable",
    ]);
    expect(page.rows[0]).toMatchObject({
      connectionId: own,
      kind: "deployment-failed",
      title: "Deployment failed: web",
      resourceUuid: "app-web-uuid",
      serverUuid: "srv-vps1-uuid",
      deploymentUuid: "dep-2",
      hostId: null,
      name: "web",
      status: "failed",
      source: "poll",
      severity: "warning",
      fields: {},
      createdAt: "2026-11-19T10:02:30.000Z",
    });
    expect(page.nextBefore).toBe(page.rows[1].id);
    const rest = await events.list(own, { before: page.nextBefore! });
    expect(rest.rows.map((r) => r.deploymentUuid)).toEqual(["dep-1"]);
    expect(rest.nextBefore).toBeNull();
    expect(
      (await events.list(own, { kind: "server-unreachable" })).rows,
    ).toHaveLength(1);
    expect(
      (await events.list(own, { uuid: "srv-vps1-uuid" })).rows,
    ).toHaveLength(3);
    expect(
      (await events.list(own, { uuid: "app-web-uuid" })).rows,
    ).toHaveLength(2);
  });

  it("refuses another user's connection and bad input", async () => {
    await ingest(others, failedDeploy("dep-1"), OTHER);
    await expect(events.list(others, {})).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
    await expect(events.list(own, { kind: "made-up" })).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(events.list(own, { limit: 0 })).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(events.list(own, { before: -1 })).rejects.toMatchObject({
      code: "invalid-input",
    });
    vi.spyOn(mock.ctx.rbac, "has").mockResolvedValue(false);
    await expect(events.list(own, {})).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

/** Makes the `nth` call of `target[method]` reject once; the rest pass. */
function failOnce<T extends object>(target: T, method: keyof T, nth = 1) {
  const real = (target[method] as (...a: unknown[]) => unknown).bind(target);
  let calls = 0;
  return vi.spyOn(target, method as never).mockImplementation((async (
    ...args: unknown[]
  ) => {
    calls += 1;
    if (calls === nth) throw new Error("injected failure");
    return real(...args);
  }) as never);
}

function dedupeKeys(connectionId: number) {
  return rows(connectionId).map((r) => r.dedupe_key);
}

describe("a failure after the insert", () => {
  it.each([
    ["the read-back", () => failOnce(store, "byKey", 2)],
    // The first snapshot read is before the insert, the second after it.
    [
      "the second connection check",
      () => failOnce(connections, "unattendedSnapshot", 2),
    ],
    ["the prune", () => failOnce(store, "prune")],
    ["the persist", () => failOnce(mock.ctx.db, "persist")],
    ["the emit", () => failOnce(mock.ctx.operations, "emit")],
  ])("%s leaves nothing that suppresses a retry", async (_, inject) => {
    inject();
    await expect(ingest(own, failedDeploy("dep-1"))).rejects.toThrow(
      "injected failure",
    );
    expect(dedupeKeys(own)).toEqual([]);
    expect((await events.list(own, {})).rows).toEqual([]);
    expect(await ingest(own, failedDeploy("dep-1"))).toMatchObject({
      outcome: "stored",
    });
    expect(mock.operationEvents.map((e) => e.eventId)).toEqual([
      "coolify.deployment-failed",
    ]);
    expect(dedupeKeys(own)).toEqual(["deployment|dep-1"]);
  });

  it("a row the cleanup couldn't delete is never listed, never a duplicate, and is swept", async () => {
    failOnce(mock.ctx.operations, "emit");
    failOnce(store, "remove");
    await expect(ingest(own, failedDeploy("dep-1"))).rejects.toThrow(
      "injected failure",
    );
    // Left behind as a pending row: not the event's dedupe key.
    expect(dedupeKeys(own)).toEqual([expect.stringMatching(/^pending\|/)]);
    expect((await events.list(own, {})).rows).toEqual([]);
    expect(await ingest(own, failedDeploy("dep-1"))).toMatchObject({
      outcome: "stored",
    });
    expect(mock.operationEvents).toHaveLength(1);
    expect(dedupeKeys(own)).toEqual(["deployment|dep-1"]);
  });
});
