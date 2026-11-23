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
import { defineTables, type Tables } from "../../../src/backend/db.js";
import {
  createConnections,
  type Connections,
} from "../../../src/backend/connections/service.js";
import { createSync, type Sync } from "../../../src/backend/sync/service.js";
import {
  createEvents,
  type EventRecord,
  type Events,
  type SourceEvent,
} from "../../../src/backend/events/service.js";
import { EVENT_KINDS } from "../../../src/backend/events/kinds.js";
import {
  createAlerts,
  type Alerts,
} from "../../../src/backend/alerts/service.js";
import {
  alertTabData,
  DEFAULT_ALERT_KINDS,
} from "../../../src/shared/alerts.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { eventually } from "../../shared/timing.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;
const OWNER = "user-1";
const GRANTEE = "user-2";
const OUTSIDER = "user-3";
const TOKEN = "fake-token-alerts-owner";

let db: TestDb;
let mock: MockPluginContext;
let tables: Tables;
let connections: Connections;
let sync: Sync;
let alerts: Alerts;
let events: Events;
let own: number;
/** Who holds coolify.view, as ctx.rbac.hasFor answers. */
let viewers: Set<string>;

function grant(connectionId: number, userId: string, level = "view") {
  db.sqlite
    .prepare(
      "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
    )
    .run(connectionId, userId, level);
}

function revoke(connectionId: number, userId: string) {
  db.sqlite
    .prepare(
      "DELETE FROM p_coolify_grants WHERE connection_id = ? AND user_id = ?",
    )
    .run(connectionId, userId);
}

/** What a poller would hand the pipeline, with no actor, then the alerts. */
async function ingest(event: SourceEvent, id = own) {
  mock.setActor(OWNER);
  const revision = (await connections.revision(id))!;
  mock.setActor(undefined);
  try {
    return await events.ingest(id, event, { revision });
  } finally {
    await alerts.idle();
    mock.setActor(OWNER);
  }
}

function sentTo(userId: string) {
  return mock.notifications
    .map((n) => n.notification)
    .filter(
      (n) =>
        typeof n.audience === "object" &&
        "userId" in n.audience &&
        n.audience.userId === userId,
    );
}

const failed = (deploymentUuid = "dep-1"): SourceEvent => ({
  kind: "deployment-failed",
  source: "poll",
  resourceUuid: "app-web-uuid",
  serverUuid: "srv-vps1-uuid",
  deploymentUuid,
  name: "web",
  status: "failed",
});

const finished = (deploymentUuid = "dep-2"): SourceEvent => ({
  ...failed(deploymentUuid),
  kind: "deployment-finished",
  status: "finished",
});

function build(onStored?: (event: EventRecord) => unknown) {
  events = createEvents(mock.ctx, {
    tables,
    connections,
    sync,
    onStored: onStored ?? ((event) => alerts.notify(event)),
  });
}

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  for (const user of [OWNER, GRANTEE, OUTSIDER]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    db: db.database,
    fetch: healthyCoolify().fetch,
    actor: OWNER,
    permissions: ["coolify.view"],
  });
  viewers = new Set([OWNER, GRANTEE, OUTSIDER]);
  vi.spyOn(mock.ctx.rbac, "hasFor").mockImplementation(
    async (userId: string, permission: string) =>
      permission === "view" && viewers.has(userId),
  );
  tables = await defineTables(mock.ctx);
  connections = createConnections(mock.ctx, tables);
  sync = await createSync(mock.ctx, { tables, connections });
  alerts = createAlerts(mock.ctx, { tables, connections });
  build();
  own = (
    await connections.create({
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
    })
  ).id;
  grant(own, GRANTEE);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("alerts for stored events", () => {
  it("sends the owner and a granted user with view one alert each", async () => {
    expect((await ingest(failed())).outcome).toBe("stored");
    for (const user of [OWNER, GRANTEE]) {
      const sent = sentTo(user);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        category: "coolify.deployment-failed",
        severity: EVENT_KINDS["deployment-failed"].severity,
        link: { tab: "coolify" },
      });
      expect(sent[0].title).toContain("web");
      expect(sent[0].title).toContain("Deployment failed");
      expect(sent[0].body).toContain("Prod");
      expect(typeof sent[0].dedupeKey).toBe("string");
    }
    expect(sentTo(OUTSIDER)).toEqual([]);
    expect(mock.notifications).toHaveLength(2);
  });

  it("sends nothing to a user without coolify.view, or after a grant is revoked", async () => {
    viewers.delete(GRANTEE);
    await ingest(failed("dep-a"));
    expect(sentTo(GRANTEE)).toEqual([]);
    expect(sentTo(OWNER)).toHaveLength(1);

    viewers.add(GRANTEE);
    revoke(own, GRANTEE);
    await ingest(failed("dep-b"));
    expect(sentTo(GRANTEE)).toEqual([]);
    expect(sentTo(OWNER)).toHaveLength(2);
  });

  it("checks view and the grant at send time, not when the event was stored", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let hookRun: Promise<void> = Promise.resolve();
    build((event) => {
      hookRun = held.then(() => alerts.notify(event));
      return hookRun;
    });
    mock.setActor(OWNER);
    const revision = (await connections.revision(own))!;
    mock.setActor(undefined);
    expect((await events.ingest(own, failed(), { revision })).outcome).toBe(
      "stored",
    );
    // Lost between the event and its alert.
    revoke(own, GRANTEE);
    viewers.delete(OWNER);
    release();
    await hookRun;
    expect(alerts.pending()).toBe(0);
    mock.setActor(OWNER);
    expect(mock.notifications).toEqual([]);
  });

  it("sends nothing for a grant with a level it doesn't know", async () => {
    revoke(own, GRANTEE);
    grant(own, GRANTEE, "admin");
    await ingest(failed());
    expect(sentTo(GRANTEE)).toEqual([]);
  });

  it("applies the default kinds when a person picked none", async () => {
    expect(DEFAULT_ALERT_KINDS).toEqual([
      "deployment-failed",
      "restart-limit",
      "server-unreachable",
      "backup-failed",
      "task-failed",
      "high-disk",
      "certificate-problem",
      "token-expiring",
    ]);
    await ingest(finished());
    expect(mock.notifications).toEqual([]);
    await ingest({
      kind: "high-disk",
      source: "poll",
      serverUuid: "srv-vps1-uuid",
      name: "vps1",
      status: "92%",
    });
    expect(sentTo(OWNER)).toHaveLength(1);
    expect(sentTo(GRANTEE)).toHaveLength(1);
  });

  it("sends each person only the kinds they picked", async () => {
    await alerts.setPrefs(own, ["deployment-finished"]);
    mock.setActor(GRANTEE);
    await alerts.setPrefs(own, []);
    mock.setActor(OWNER);
    await ingest(failed());
    await ingest(finished());
    expect(sentTo(OWNER).map((n) => n.category)).toEqual([
      "coolify.deployment-finished",
    ]);
    expect(sentTo(GRANTEE)).toEqual([]);
  });

  it("sends no second alert for a duplicate event", async () => {
    expect((await ingest(failed())).outcome).toBe("stored");
    expect((await ingest(failed())).outcome).toBe("duplicate");
    expect(sentTo(OWNER)).toHaveLength(1);
    expect(sentTo(GRANTEE)).toHaveLength(1);
  });

  it("keeps the dedupe key per person and per subject", async () => {
    await ingest(failed("dep-a"));
    await ingest(failed("dep-b"));
    const keys = mock.notifications.map((n) => n.notification.dedupeKey);
    expect(new Set(keys).size).toBe(4);
  });

  it("keeps two tasks of one resource, ending together, as two alerts", async () => {
    // The pipeline keeps them apart by taskUuid (#118); the hub must not
    // fold the second into the first while it is unread.
    const task = (taskUuid: string): SourceEvent => ({
      kind: "task-failed",
      source: "webhook",
      resourceUuid: "app-web-uuid",
      taskUuid,
      name: "web",
    });
    expect((await ingest(task("task-a"))).outcome).toBe("stored");
    expect((await ingest(task("task-b"))).outcome).toBe("stored");
    const keys = sentTo(OWNER).map((n) => n.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps a status change back to running apart from the one before", async () => {
    await alerts.setPrefs(own, ["status-changed"]);
    const change = (to: string, at: number): SourceEvent => ({
      kind: "status-changed",
      source: "poll",
      resourceUuid: "app-web-uuid",
      name: "web",
      status: to,
      at,
    });
    await ingest(change("degraded", Date.parse("2026-11-19T10:00:00Z")));
    await ingest(change("running", Date.parse("2026-11-19T10:05:00Z")));
    const keys = sentTo(OWNER).map((n) => n.dedupeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("folds a repeating condition on one subject while it is unread", async () => {
    const disk = (at: number): SourceEvent => ({
      kind: "high-disk",
      source: "poll",
      serverUuid: "srv-vps1-uuid",
      name: "vps1",
      at,
    });
    await ingest(disk(Date.parse("2026-11-19T10:00:00Z")));
    await ingest(disk(Date.parse("2026-11-19T10:05:00Z")));
    const keys = sentTo(OWNER).map((n) => n.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("leaves ingest stored when the hook throws or rejects", async () => {
    const warn = vi.spyOn(mock.ctx.log, "warn");
    build(() => {
      throw new TypeError("secret fake-token-alerts-owner");
    });
    expect((await ingest(failed("dep-a"))).outcome).toBe("stored");
    build(async () => {
      throw new RangeError("secret fake-token-alerts-owner");
    });
    expect((await ingest(failed("dep-b"))).outcome).toBe("stored");
    await eventually(() => expect(warn).toHaveBeenCalledTimes(2));
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("TypeError");
    expect(logged).toContain("RangeError");
    expect(logged).not.toContain("fake-token");
  });

  it("doesn't wait for the hook before answering", async () => {
    build(() => new Promise(() => {}));
    mock.setActor(OWNER);
    const revision = (await connections.revision(own))!;
    mock.setActor(undefined);
    expect((await events.ingest(own, failed(), { revision })).outcome).toBe(
      "stored",
    );
    mock.setActor(OWNER);
  });

  it("still alerts everyone else when one send fails", async () => {
    const warn = vi.spyOn(mock.ctx.log, "warn");
    const send = mock.ctx.notify.send;
    vi.spyOn(mock.ctx.notify, "send").mockImplementation(async (n) => {
      const to = n.audience as { userId: string };
      if (to.userId === OWNER) throw new Error("hub down fake-token");
      return send(n);
    });
    expect((await ingest(failed())).outcome).toBe("stored");
    expect(sentTo(GRANTEE)).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("fake-token");
  });

  it("links to the subject in the Coolify tab", async () => {
    await ingest(failed());
    await ingest({
      kind: "server-unreachable",
      source: "poll",
      serverUuid: "srv-vps1-uuid",
      name: "vps1",
    });
    await ingest({ kind: "token-expiring", source: "webhook", name: "ci" });
    const [app, server, team] = sentTo(OWNER);
    expect(app.link).toEqual({ tab: "coolify" });
    expect(app.context?.tab).toEqual({
      section: "resources",
      connectionId: own,
      uuid: "app-web-uuid",
    });
    expect(server.context?.tab).toEqual({
      section: "resources",
      connectionId: own,
      serverUuid: "srv-vps1-uuid",
    });
    expect(team.context?.tab).toEqual({
      section: "overview",
      connectionId: own,
    });
    expect(app.context?.tab).toEqual(
      alertTabData({
        connectionId: own,
        resourceUuid: "app-web-uuid",
        serverUuid: "srv-vps1-uuid",
      }),
    );
  });

  it("builds its text only from the redacted event", async () => {
    await ingest({
      ...failed(),
      name: `web ${TOKEN} https://admin:hunter2-fake@db.example.test/x`,
      status: `failed password=hunter2-fake`,
    });
    const [sent] = sentTo(OWNER);
    const text = JSON.stringify(sent);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("hunter2-fake");
    expect(sent.title).toContain("web");
  });

  it("keeps a $ pattern in a name as it is", async () => {
    await ingest({ ...failed(), name: "web-$&-{{connection}}" });
    const [sent] = sentTo(OWNER);
    expect(sent.title).toContain("web-$&-{{connection}}");
  });
});

describe("alert preferences", () => {
  it("answers the defaults until a person saves their own", async () => {
    expect(await alerts.prefs(own)).toMatchObject({
      connectionId: own,
      kinds: [...DEFAULT_ALERT_KINDS],
      isDefault: true,
    });
    await alerts.setPrefs(own, ["backup-failed", "backup-failed", "high-disk"]);
    expect(await alerts.prefs(own)).toMatchObject({
      kinds: ["backup-failed", "high-disk"],
      isDefault: false,
    });
  });

  it("keeps each person's own preferences apart", async () => {
    mock.setActor(GRANTEE);
    await alerts.setPrefs(own, ["high-disk"]);
    mock.setActor(OWNER);
    expect((await alerts.prefs(own)).isDefault).toBe(true);
    mock.setActor(GRANTEE);
    expect((await alerts.prefs(own)).kinds).toEqual(["high-disk"]);
  });

  it("takes two concurrent first saves, the later one winning", async () => {
    const [first, second] = await Promise.all([
      alerts.setPrefs(own, ["high-disk"]),
      alerts.setPrefs(own, ["backup-failed", "task-failed"]),
    ]);
    expect(first.kinds).toEqual(["high-disk"]);
    expect(second.kinds).toEqual(["backup-failed", "task-failed"]);
    const rows = db.sqlite
      .prepare("SELECT kinds FROM p_coolify_alert_prefs")
      .all() as { kinds: string }[];
    expect(rows.map((r) => JSON.parse(r.kinds))).toEqual([
      ["backup-failed", "task-failed"],
    ]);
    expect((await alerts.prefs(own)).kinds).toEqual([
      "backup-failed",
      "task-failed",
    ]);
  });

  it("applies a save and a reset in the order they were asked", async () => {
    await alerts.setPrefs(own, ["high-disk"]);
    await Promise.all([
      alerts.setPrefs(own, null),
      alerts.setPrefs(own, ["task-failed"]),
    ]);
    expect((await alerts.prefs(own)).kinds).toEqual(["task-failed"]);
    await Promise.all([
      alerts.setPrefs(own, ["backup-failed"]),
      alerts.setPrefs(own, null),
    ]);
    expect((await alerts.prefs(own)).isDefault).toBe(true);
  });

  it("goes back to the defaults on reset", async () => {
    await alerts.setPrefs(own, []);
    expect((await alerts.prefs(own)).kinds).toEqual([]);
    await alerts.setPrefs(own, null);
    expect((await alerts.prefs(own)).isDefault).toBe(true);
  });

  it("rejects unknown kinds and anything but a list", async () => {
    for (const bad of [["deployment-failed", "nope"], "high-disk", [1], {}]) {
      await expect(alerts.setPrefs(own, bad)).rejects.toMatchObject({
        code: "invalid-input",
      });
    }
    expect((await alerts.prefs(own)).isDefault).toBe(true);
  });

  it("is 404 on another user's connection, read or write", async () => {
    mock.setActor(OUTSIDER);
    await expect(alerts.prefs(own)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(alerts.setPrefs(own, ["high-disk"])).rejects.toMatchObject({
      code: "not-found",
    });
    const count = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_coolify_alert_prefs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("needs coolify.view", async () => {
    vi.spyOn(mock.ctx.rbac, "has").mockResolvedValue(false);
    await expect(alerts.prefs(own)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(alerts.setPrefs(own, [])).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("goes with the connection when it is removed", async () => {
    await alerts.setPrefs(own, ["high-disk"]);
    await connections.remove(own);
    const count = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_coolify_alert_prefs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});
