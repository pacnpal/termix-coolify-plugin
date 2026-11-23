import crypto from "node:crypto";
import { OWNER_ONLY_SUBJECTS } from "../helpers/events.js";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import { eventually } from "../../shared/timing.js";
import manifestJson from "../../../manifest.json";
import { defineTables, type Tables } from "../../../src/backend/db.js";
import {
  createConnections,
  type Connections,
} from "../../../src/backend/connections/service.js";
import { createSync } from "../../../src/backend/sync/service.js";
import {
  createEvents,
  type Events,
} from "../../../src/backend/events/service.js";
import {
  createWebhooks,
  issueWebhookToken,
  WEBHOOK_BODY_MAX,
  WEBHOOK_FANOUT_MAX,
  type Webhooks,
} from "../../../src/backend/webhooks/service.js";
import { healthyCoolify, type FakeAnswer } from "../helpers/fake-coolify.js";
import { COOLIFY_WEBHOOKS } from "../fixtures/coolify-webhooks.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;
const OWNER = "user-1";
const OTHER = "user-2";
const TOKEN_A = "fake-token-webhook-a";
const TOKEN_B = "fake-token-webhook-b";
const TOKEN_C = "fake-token-webhook-c";
const BASE = "https://coolify.example.test";

const SEEN = {
  "GET /applications/app-web-uuid": { json: { uuid: "app-web-uuid" } },
  "GET /databases/db-pg-uuid": { json: { uuid: "db-pg-uuid" } },
  "GET /services/svc-n8n-uuid": { json: { uuid: "svc-n8n-uuid" } },
  "GET /servers/srv-vps1-uuid": { json: { uuid: "srv-vps1-uuid" } },
} satisfies Record<string, FakeAnswer>;

let db: TestDb;
let mock: MockPluginContext;
let tables: Tables;
let connections: Connections;
let events: Events;
let webhooks: Webhooks;
/** Answers for one token only, by "METHOD /path"; "hang" never answers. */
let perToken: Map<string, Record<string, FakeAnswer | "hang">>;
let calls: { token: string; route: string }[];
let a: number;
let b: number;
let c: number;
let token: string;

function tokenOf(init?: PluginFetchInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return (headers.authorization ?? "").replace(/^Bearer /, "");
}

function rows(connectionId: number) {
  return db.sqlite
    .prepare(
      "SELECT * FROM p_coolify_events WHERE connection_id = ? ORDER BY id",
    )
    .all(connectionId) as Record<string, unknown>[];
}

function webhookRow() {
  return db.sqlite.prepare("SELECT * FROM p_coolify_webhooks").get() as Record<
    string,
    unknown
  >;
}

function instanceKeyOf(id: number): string {
  return (
    db.sqlite
      .prepare("SELECT instance_key FROM p_coolify_connections WHERE id = ?")
      .get(id) as { instance_key: string }
  ).instance_key;
}

/** A visibility GET this connection's token made, by route. */
function checks(tokenValue: string) {
  return calls
    .filter((x) => x.token === tokenValue && !x.route.endsWith("/health"))
    .map((x) => x.route)
    .filter((r) => Object.keys(SEEN).includes(r));
}

async function deliver(body: unknown, bytes?: number, t = token) {
  mock.setActor(undefined);
  try {
    const answer = await webhooks.receive(
      t,
      body,
      bytes ?? Buffer.byteLength(JSON.stringify(body)),
    );
    return {
      accepted: answer.accepted,
      results: answer.accepted ? await answer.fanout : null,
    };
  } finally {
    mock.setActor(OWNER);
  }
}

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  for (const user of [OWNER, OTHER]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  perToken = new Map();
  calls = [];
  const fake = healthyCoolify(SEEN);
  const other = healthyCoolify({
    ...SEEN,
    "GET /team": { json: { id: 99, name: "Another team" } },
  });
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const t = tokenOf(init);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    const route = `${method} ${path}`;
    calls.push({ token: t, route });
    const special = perToken.get(t)?.[route];
    if (special === "hang") return new Promise<Response>(() => {});
    if (typeof special === "function") return special(url);
    if (special) {
      return new Response(JSON.stringify(special.json ?? null), {
        status: special.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return (t === TOKEN_C ? other : fake).fetch(url, init);
  };
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    db: db.database,
    fetch,
    actor: OWNER,
  });
  tables = await defineTables(mock.ctx);
  connections = createConnections(mock.ctx, tables);
  const sync = await createSync(mock.ctx, { tables, connections });
  events = createEvents(mock.ctx, {
    tables,
    connections,
    sync,
    subjects: OWNER_ONLY_SUBJECTS,
  });
  webhooks = createWebhooks(mock.ctx, { tables, connections, events });
  a = (await connections.create({ name: "A", baseUrl: BASE, token: TOKEN_A }))
    .id;
  mock.setActor(OTHER);
  b = (await connections.create({ name: "B", baseUrl: BASE, token: TOKEN_B }))
    .id;
  mock.setActor(OWNER);
  // Same address, another team: another instanceKey.
  c = (await connections.create({ name: "C", baseUrl: BASE, token: TOKEN_C }))
    .id;
  expect(instanceKeyOf(a)).toBe(instanceKeyOf(b));
  expect(instanceKeyOf(c)).not.toBe(instanceKeyOf(a));
  const issued = issueWebhookToken();
  token = issued.token;
  db.sqlite
    .prepare(
      "INSERT INTO p_coolify_webhooks (instance_key, token_hash, created_by_user_id) VALUES (?, ?, ?)",
    )
    .run(instanceKeyOf(a), issued.tokenHash, OWNER);
  calls = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

describe("issueWebhookToken", () => {
  it("is 32 random bytes, and only its sha256 is meant to be kept", () => {
    const one = issueWebhookToken();
    const two = issueWebhookToken();
    expect(Buffer.from(one.token, "base64url")).toHaveLength(32);
    expect(one.token).not.toBe(two.token);
    expect(one.tokenHash).toBe(
      crypto.createHash("sha256").update(one.token).digest("hex"),
    );
  });
});

describe("webhook fan-out", () => {
  it("ingests a valid event once per connection of that team that can see it", async () => {
    const got = await deliver(COOLIFY_WEBHOOKS.deployment_failed);
    expect(got.accepted).toBe(true);
    expect(rows(a)).toHaveLength(1);
    expect(rows(b)).toHaveLength(1);
    expect(rows(c)).toHaveLength(0);
    expect(rows(a)[0]).toMatchObject({
      kind: "deployment-failed",
      resource_uuid: "app-web-uuid",
      deployment_uuid: "dep-uuid-2",
    });
    expect(JSON.parse(String(rows(a)[0].detail))).toMatchObject({
      source: "webhook",
      status: "failed",
    });
    // Each connection asked with its own token, the other team not at all.
    expect(checks(TOKEN_A)).toEqual(["GET /applications/app-web-uuid"]);
    expect(checks(TOKEN_B)).toEqual(["GET /applications/app-web-uuid"]);
    expect(checks(TOKEN_C)).toEqual([]);
    expect(mock.operationEvents.map((e) => e.eventId)).toEqual([
      "coolify.deployment-failed",
      "coolify.deployment-failed",
    ]);
  });

  it.each([
    ["403", { status: 403, json: { message: "Forbidden." } }],
    ["404", { status: 404, json: { message: "Not found." } }],
    ["401", { status: 401, json: { message: "Unauthenticated." } }],
    ["500", { status: 500, json: {} }],
    [
      "timeout",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
  ] as [string, FakeAnswer][])(
    "a %s on the visibility check drops it for that connection only, unretried",
    async (_name, answer) => {
      perToken.set(TOKEN_B, { "GET /servers/srv-vps1-uuid": answer });
      const got = await deliver(COOLIFY_WEBHOOKS.server_unreachable);
      expect(got.accepted).toBe(true);
      expect(rows(a)).toHaveLength(1);
      expect(rows(b)).toHaveLength(0);
      expect(checks(TOKEN_B)).toEqual(["GET /servers/srv-vps1-uuid"]);
      expect(got.results).toEqual(
        expect.arrayContaining([
          { connectionId: a, outcome: "stored" },
          { connectionId: b, outcome: "not-visible" },
        ]),
      );
    },
  );

  it("checks the subject live every time: no cache lets one through or keeps one out", async () => {
    await deliver(COOLIFY_WEBHOOKS.backup_failed);
    perToken.set(TOKEN_A, {
      "GET /databases/db-pg-uuid": { status: 404, json: {} },
    });
    await deliver(COOLIFY_WEBHOOKS.backup_success);
    expect(rows(a).map((r) => r.kind)).toEqual(["backup-failed"]);
    expect(rows(b).map((r) => r.kind)).toEqual([
      "backup-failed",
      "backup-succeeded",
    ]);
    expect(checks(TOKEN_A)).toHaveLength(2);
  });

  it("asks a task's service, and accepts but ingests nothing for an event no kind covers", async () => {
    await deliver(COOLIFY_WEBHOOKS.task_failed);
    expect(checks(TOKEN_A)).toEqual(["GET /services/svc-n8n-uuid"]);
    calls = [];
    const got = await deliver(COOLIFY_WEBHOOKS.test);
    expect(got).toEqual({ accepted: true, results: [] });
    expect(calls).toEqual([]);
    expect(rows(a)).toHaveLength(1);
  });

  it("skips a connection whose owner lost coolify.view without asking Coolify", async () => {
    vi.spyOn(mock.ctx.rbac, "hasFor").mockImplementation(
      async (user) => user !== OTHER,
    );
    const got = await deliver(COOLIFY_WEBHOOKS.server_unreachable);
    expect(rows(b)).toHaveLength(0);
    expect(checks(TOKEN_B)).toEqual([]);
    expect(got.results).toContainEqual({ connectionId: b, outcome: "skipped" });
  });

  it("hands ingest the revision the check was made under", async () => {
    const ingest = vi.spyOn(events, "ingest");
    await deliver(COOLIFY_WEBHOOKS.high_disk_usage);
    const revision = (await connections.unattendedSnapshot(a))!.revision;
    expect(ingest).toHaveBeenCalledWith(
      a,
      expect.objectContaining({ kind: "high-disk", source: "webhook" }),
      { revision },
    );
  });

  it("counts the visibility checks against the connection's request budget", async () => {
    vi.useFakeTimers();
    // Spend the connection's whole minute (150 requests) first.
    const api = await (await connections.unattendedSnapshot(a))!.api();
    for (let i = 0; i < 150; i++) await api.team();
    mock.setActor(undefined);
    const answer = await webhooks.receive(
      token,
      COOLIFY_WEBHOOKS.server_unreachable,
      200,
    );
    mock.setActor(OWNER);
    expect(answer.accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    // B has budget left and is asked; A waits for its window.
    expect(checks(TOKEN_B)).toEqual(["GET /servers/srv-vps1-uuid"]);
    expect(checks(TOKEN_A)).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    if (answer.accepted) await answer.fanout;
    expect(checks(TOKEN_A)).toEqual(["GET /servers/srv-vps1-uuid"]);
    expect(rows(a)).toHaveLength(1);
  });

  it("drops the event for a connection repointed to another team after it was picked", async () => {
    const original = connections.unattendedSnapshot.bind(connections);
    let repointed = false;
    vi.spyOn(connections, "unattendedSnapshot").mockImplementation(
      async (id) => {
        if (id === a && !repointed) {
          repointed = true;
          // Between the instanceKey selection and the snapshot: A now
          // reaches team 99 with TOKEN_C.
          mock.setActor(OWNER);
          await connections.update(a, { token: TOKEN_C });
          mock.setActor(undefined);
          calls = [];
        }
        return original(id);
      },
    );
    const got = await deliver(COOLIFY_WEBHOOKS.server_unreachable);
    expect(repointed).toBe(true);
    expect(instanceKeyOf(a)).toBe(instanceKeyOf(c));
    expect(checks(TOKEN_C)).toEqual([]);
    expect(rows(a)).toHaveLength(0);
    expect(rows(b)).toHaveLength(1);
    expect(got.results).toContainEqual({ connectionId: a, outcome: "dropped" });
  });

  it("gives a resource event the server from the check's own answer, and so its Linked host", async () => {
    db.sqlite
      .prepare(
        "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
      )
      .run(a, "srv-vps1-uuid", 41);
    perToken.set(TOKEN_A, {
      "GET /applications/app-web-uuid": {
        json: {
          uuid: "app-web-uuid",
          destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
        },
      },
    });
    perToken.set(TOKEN_B, {
      "GET /applications/app-web-uuid": {
        json: {
          uuid: "app-web-uuid",
          destination: { server: { uuid: "../not-a-uuid" } },
        },
      },
    });
    await deliver(COOLIFY_WEBHOOKS.deployment_failed);
    expect(rows(a)[0]).toMatchObject({
      server_uuid: "srv-vps1-uuid",
      host_id: 41,
    });
    // A malformed server uuid is left out, not a reason to drop the event.
    expect(rows(b)[0]).toMatchObject({ server_uuid: null, host_id: null });
    expect(mock.operationEvents.map((e) => e.hostId ?? null).sort()).toEqual(
      [41, null].sort(),
    );
    // Still one GET per connection: the server came from the check itself.
    expect(checks(TOKEN_A)).toEqual(["GET /applications/app-web-uuid"]);
  });

  it("sends no check for a connection repointed while the check waited for its budget", async () => {
    vi.useFakeTimers();
    const api = await (await connections.unattendedSnapshot(a))!.api();
    for (let i = 0; i < 150; i++) await api.team();
    mock.setActor(undefined);
    const answer = await webhooks.receive(
      token,
      COOLIFY_WEBHOOKS.server_unreachable,
      200,
    );
    mock.setActor(OWNER);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checks(TOKEN_A)).toEqual([]);
    await connections.update(a, { token: "fake-token-webhook-a2" });
    calls = [];
    await vi.advanceTimersByTimeAsync(60_000);
    const results = answer.accepted ? await answer.fanout : [];
    // Nothing went out for A, with the old token or the new one.
    expect(
      calls.filter((x) => x.route === "GET /servers/srv-vps1-uuid"),
    ).toEqual([]);
    expect(results).toContainEqual({ connectionId: a, outcome: "dropped" });
    expect(rows(a)).toHaveLength(0);
    expect(rows(b)).toHaveLength(1);
  });

  it("drops the event for a connection repointed while it was checked", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    // The check's answer waits for the gate; the fake's type wants a
    // Response, and fetch awaits whatever it is given.
    perToken.set(TOKEN_A, {
      "GET /servers/srv-vps1-uuid": () =>
        gate.then(
          () =>
            new Response(JSON.stringify({ uuid: "srv-vps1-uuid" }), {
              headers: { "content-type": "application/json" },
            }),
        ) as unknown as Response,
    });
    mock.setActor(undefined);
    const answer = await webhooks.receive(
      token,
      COOLIFY_WEBHOOKS.server_unreachable,
      200,
    );
    mock.setActor(OWNER);
    await eventually(() =>
      expect(checks(TOKEN_A)).toEqual(["GET /servers/srv-vps1-uuid"]),
    );
    await connections.update(a, { token: "fake-token-webhook-a2" });
    release();
    const results = answer.accepted ? await answer.fanout : [];
    expect(results).toContainEqual({ connectionId: a, outcome: "dropped" });
    expect(rows(a)).toHaveLength(0);
  });
});

describe("webhook refusals", () => {
  it("an unknown token, a malformed one and a bad body are all refused, storing nothing", async () => {
    const unknown = crypto.randomBytes(32).toString("base64url");
    for (const [t, body] of [
      [unknown, COOLIFY_WEBHOOKS.test],
      ["short", COOLIFY_WEBHOOKS.test],
      [token, { ...COOLIFY_WEBHOOKS.test, extra: 1 }],
      [token, { event: "test" }],
      [token, null],
    ] as [string, unknown][]) {
      const got = await deliver(body, 100, t);
      expect(got).toEqual({ accepted: false, results: null });
    }
    expect(webhookRow().last_received_at).toBeNull();
    expect(calls).toEqual([]);
  });

  it("refuses a body over 64 KB and takes one of exactly 64 KB", async () => {
    expect(WEBHOOK_BODY_MAX).toBe(65_536);
    expect((await deliver(COOLIFY_WEBHOOKS.test, 65_537)).accepted).toBe(false);
    expect((await deliver(COOLIFY_WEBHOOKS.test, 65_536)).accepted).toBe(true);
    // The body's own size counts even when the caller says less.
    const big = { ...COOLIFY_WEBHOOKS.test, message: "x".repeat(65_536) };
    expect((await deliver(big, 10)).accepted).toBe(false);
  });

  it("compares the token's hash in constant time", async () => {
    const equal = vi.spyOn(crypto, "timingSafeEqual");
    await deliver(COOLIFY_WEBHOOKS.test);
    expect(equal).toHaveBeenCalledTimes(1);
    const [x, y] = equal.mock.calls[0] as [Buffer, Buffer];
    expect(x).toHaveLength(32);
    expect(y).toHaveLength(32);
  });

  it("sets lastReceivedAt on every accepted delivery", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-23T10:00:00.000Z") });
    await deliver(COOLIFY_WEBHOOKS.test);
    expect(webhookRow().last_received_at).toBe("2026-11-23T10:00:00.000Z");
    vi.setSystemTime(Date.parse("2026-11-23T10:05:00.000Z"));
    await deliver(COOLIFY_WEBHOOKS.server_reachable);
    expect(webhookRow().last_received_at).toBe("2026-11-23T10:05:00.000Z");
  });

  it("verify finds the token's row, and nothing for any other token", async () => {
    expect(await webhooks.verify(token)).toMatchObject({
      instanceKey: instanceKeyOf(a),
    });
    expect(
      await webhooks.verify(crypto.randomBytes(32).toString("base64url")),
    ).toBeNull();
    expect(await webhooks.verify(42)).toBeNull();
  });

  it(`at ${WEBHOOK_FANOUT_MAX} fan-outs in flight, refuses a delivery as busy so Coolify retries it`, async () => {
    perToken.set(TOKEN_A, { "GET /servers/srv-vps1-uuid": "hang" });
    perToken.set(TOKEN_B, { "GET /servers/srv-vps1-uuid": "hang" });
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.parse("2026-11-23T10:00:00.000Z"),
    });
    mock.setActor(undefined);
    for (let i = 0; i < WEBHOOK_FANOUT_MAX; i++) {
      const held = await webhooks.receive(
        token,
        COOLIFY_WEBHOOKS.server_unreachable,
        200,
      );
      expect(held.accepted).toBe(true);
    }
    vi.setSystemTime(Date.parse("2026-11-23T10:05:00.000Z"));
    const over = await webhooks.receive(
      token,
      COOLIFY_WEBHOOKS.backup_failed,
      200,
    );
    expect(over).toEqual({ accepted: false, busy: true });
    // Not counted as delivered, and nothing asked or ingested for it.
    expect(webhookRow().last_received_at).toBe("2026-11-23T10:00:00.000Z");
    expect(calls.some((x) => x.route === "GET /databases/db-pg-uuid")).toBe(
      false,
    );
    expect(rows(a)).toHaveLength(0);
    // An event no kind covers holds no slot, so it is still accepted.
    const test = await webhooks.receive(token, COOLIFY_WEBHOOKS.test, 200);
    mock.setActor(OWNER);
    expect(test.accepted).toBe(true);
  });
});

describe("run identity and status changes", () => {
  const taskRun = (taskUuid: string) => ({
    ...COOLIFY_WEBHOOKS.task_failed,
    task_uuid: taskUuid,
  });

  it("two different tasks of one resource failing in the same minute are two events", async () => {
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.parse("2026-11-23T10:00:10.000Z"),
    });
    await deliver(taskRun("task-one"));
    vi.setSystemTime(Date.parse("2026-11-23T10:00:20.000Z"));
    await deliver(taskRun("task-two"));
    expect(rows(a).map((r) => r.dedupe_key)).toEqual([
      expect.stringMatching(/^task\|task-failed\|task-one\|/),
      expect.stringMatching(/^task\|task-failed\|task-two\|/),
    ]);
    // Coolify's retry of the same delivery is one event.
    vi.setSystemTime(Date.parse("2026-11-23T10:00:40.000Z"));
    expect((await deliver(taskRun("task-one"))).results).toContainEqual({
      connectionId: a,
      outcome: "duplicate",
    });
    expect(rows(a)).toHaveLength(2);
  });

  it("a poll and a webhook of the same task run are one event", async () => {
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.parse("2026-11-23T10:00:30.000Z"),
    });
    const revision = (await connections.unattendedSnapshot(a))!.revision;
    // What the poller's diff hands the pipeline for that run.
    const polled = await events.ingest(
      a,
      {
        kind: "task-failed",
        source: "poll",
        resourceUuid: "svc-n8n-uuid",
        taskUuid: "task-uuid",
        name: "svc",
        status: "failed",
        at: Date.parse("2026-11-23T10:00:05.000Z"),
      },
      { revision },
    );
    expect(polled.outcome).toBe("stored");
    await deliver(COOLIFY_WEBHOOKS.task_failed);
    expect(rows(a)).toHaveLength(1);
  });

  it("a status_changed delivery is one status-changed event", async () => {
    await deliver(COOLIFY_WEBHOOKS.status_changed);
    expect(rows(a)).toHaveLength(1);
    expect(rows(a)[0]).toMatchObject({
      kind: "status-changed",
      resource_uuid: "app-web-uuid",
    });
    expect(checks(TOKEN_A)).toEqual(["GET /applications/app-web-uuid"]);
  });
});
