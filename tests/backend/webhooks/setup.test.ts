import { fileURLToPath } from "node:url";
import { OWNER_ONLY_SUBJECTS } from "../helpers/events.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../../manifest.json";
import { defineTables, type Tables } from "../../../src/backend/db.js";
import {
  createConnections,
  type Connections,
} from "../../../src/backend/connections/service.js";
import { createSync } from "../../../src/backend/sync/service.js";
import { createEvents } from "../../../src/backend/events/service.js";
import {
  createWebhooks,
  issueWebhookToken,
  type Webhooks,
} from "../../../src/backend/webhooks/service.js";
import {
  createWebhookSetup,
  maskWebhookUrl,
  privateBase,
  WEBHOOK_EVENT_FIELDS,
  WEBHOOK_EVENT_TOGGLES,
  type WebhookSetup,
} from "../../../src/backend/webhooks/setup.js";
import { COOLIFY_WEBHOOK_EVENTS } from "../../../src/backend/webhooks/shape.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;
const OWNER = "user-1";
const OTHER = "user-2";
const COOLIFY = "https://coolify.example.test";
const BASE = "https://termix.example.com";
const OURS =
  /^https:\/\/termix\.example\.com\/plugin-api\/coolify\/webhook\/([A-Za-z0-9_-]{43})$/;
const FOREIGN =
  "https://hooks.example.net/services/T000/B000/fake-secret-path?key=fake-key";

let db: TestDb;
let mock: MockPluginContext;
let tables: Tables;
let connections: Connections;
let webhooks: Webhooks;
let setup: WebhookSetup;
let id: number;
/** What the fake Coolify keeps for the team's webhook channel. */
let channel: Record<string, unknown>;
/** Whether the GET hides webhook_url, as for a token without read:sensitive. */
let hidden: boolean;
let patches: Record<string, unknown>[];
let notificationCalls: string[];
/** PATCHes the fake refuses with a 500 before it accepts one. */
let patchFailures: number;
/** Runs after the fake answers a GET of the channel. */
let afterRead: (() => void) | null;

function webhookRows() {
  return db.sqlite.prepare("SELECT * FROM p_coolify_webhooks").all() as {
    instance_key: string;
    token_hash: string;
    last_received_at: string | null;
  }[];
}

function instanceKey(): string {
  return (
    db.sqlite
      .prepare("SELECT instance_key FROM p_coolify_connections WHERE id = ?")
      .get(id) as { instance_key: string }
  ).instance_key;
}

/** A webhook row for this connection's team, with the token it was made for. */
function seedRow(lastReceivedAt: string | null = null): string {
  const issued = issueWebhookToken();
  db.sqlite
    .prepare(
      "INSERT INTO p_coolify_webhooks (instance_key, token_hash, created_by_user_id, last_received_at) VALUES (?, ?, ?, ?)",
    )
    .run(instanceKey(), issued.tokenHash, OWNER, lastReceivedAt);
  return issued.token;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  for (const user of [OWNER, OTHER]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  channel = { id: 1, team_id: 7, webhook_enabled: false, webhook_url: null };
  hidden = false;
  patches = [];
  notificationCalls = [];
  afterRead = null;
  patchFailures = 0;
  const fake = healthyCoolify();
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    if (path === "/notifications/webhook") {
      notificationCalls.push(method);
      if (method === "GET") {
        const body = { ...channel };
        if (hidden) delete body.webhook_url;
        const answer = json(body);
        afterRead?.();
        return answer;
      }
      if (method === "PATCH") {
        if (patchFailures > 0) {
          patchFailures -= 1;
          return json({ message: "Server error" }, 500);
        }
        const body = JSON.parse(String(init?.body ?? "{}"));
        patches.push(body);
        channel = { ...channel, ...body };
        return json(channel);
      }
    }
    return fake.fetch(url, init);
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
  const events = createEvents(mock.ctx, {
    tables,
    connections,
    sync,
    subjects: OWNER_ONLY_SUBJECTS,
  });
  webhooks = createWebhooks(mock.ctx, { tables, connections, events });
  setup = createWebhookSetup(mock.ctx, { tables, connections, webhooks });
  id = (
    await connections.create({
      name: "Prod",
      baseUrl: COOLIFY,
      token: "fake-token-webhook-setup",
    })
  ).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("webhook setup: the three starting states", () => {
  it("unset: makes a token, keeps only its sha256 and writes our URL with the events ticked", async () => {
    const result = await setup.setup(id, { base: BASE });
    expect(result).toEqual({
      outcome: "configured",
      replaced: false,
      basePrivate: false,
    });
    expect(notificationCalls).toEqual(["GET", "PATCH"]);
    const written = patches[0];
    const match = OURS.exec(String(written.webhook_url));
    expect(match).not.toBeNull();
    const token = match![1];
    expect(written.webhook_enabled).toBe(true);
    for (const field of WEBHOOK_EVENT_FIELDS) expect(written[field]).toBe(true);
    // Nothing else: Coolify refuses unknown fields, and other toggles stay.
    expect(Object.keys(written).sort()).toEqual(
      ["webhook_url", "webhook_enabled", ...WEBHOOK_EVENT_FIELDS].sort(),
    );
    const rows = webhookRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].instance_key).toBe(instanceKey());
    expect(rows[0].token_hash).not.toContain(token);
    expect(await webhooks.verify(token)).toMatchObject({
      instanceKey: instanceKey(),
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("unset with an old row: gives the row a new token and polls until it delivers", async () => {
    const old = seedRow("2026-11-20T10:00:00.000Z");
    await setup.setup(id, { base: BASE });
    const token = OURS.exec(String(patches[0].webhook_url))![1];
    expect(token).not.toBe(old);
    const rows = webhookRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].last_received_at).toBeNull();
    expect(await webhooks.verify(old)).toBeNull();
    expect(await webhooks.verify(token)).not.toBeNull();
  });

  it("ours: keeps the token and its row, and writes the URL on today's address", async () => {
    const token = seedRow("2026-11-20T10:00:00.000Z");
    channel.webhook_url = `https://old.example.com/plugin-api/coolify/webhook/${token}`;
    channel.webhook_enabled = true;
    const before = webhookRows()[0];
    const result = await setup.setup(id, { base: BASE });
    expect(result).toEqual({
      outcome: "configured",
      replaced: false,
      basePrivate: false,
    });
    expect(patches[0].webhook_url).toBe(
      `${BASE}/plugin-api/coolify/webhook/${token}`,
    );
    expect(webhookRows()).toEqual([before]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("someone else's: answers the current URL masked and writes nothing", async () => {
    channel.webhook_url = FOREIGN;
    channel.webhook_enabled = true;
    const result = await setup.setup(id, { base: BASE });
    expect(result).toEqual({
      outcome: "replace-needed",
      current: "https://hooks.example.net/[redacted]",
      basePrivate: false,
    });
    expect(notificationCalls).toEqual(["GET"]);
    expect(webhookRows()).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/fake-secret-path|fake-key/);
  });

  it("a URL shaped like ours whose token isn't this team's row is someone else's", async () => {
    const stranger = issueWebhookToken().token;
    seedRow();
    channel.webhook_url = `https://other-termix.example.org/plugin-api/coolify/webhook/${stranger}`;
    const result = await setup.setup(id, { base: BASE });
    expect(result).toMatchObject({
      outcome: "replace-needed",
      current: "https://other-termix.example.org/[redacted]",
    });
    expect(JSON.stringify(result)).not.toContain(stranger);
    expect(patches).toEqual([]);
  });

  it("another team's row with that token is someone else's too", async () => {
    const issued = issueWebhookToken();
    db.sqlite
      .prepare(
        "INSERT INTO p_coolify_webhooks (instance_key, token_hash, created_by_user_id) VALUES (?, ?, ?)",
      )
      .run(`${COOLIFY}#99`, issued.tokenHash, OWNER);
    channel.webhook_url = `${BASE}/plugin-api/coolify/webhook/${issued.token}`;
    const result = await setup.setup(id, { base: BASE });
    expect(result.outcome).toBe("replace-needed");
    expect(patches).toEqual([]);
  });
});

describe("webhook setup: replacing someone else's", () => {
  beforeEach(() => {
    channel.webhook_url = FOREIGN;
    channel.webhook_enabled = true;
  });

  it("declining changes nothing and leaves polling on", async () => {
    await setup.setup(id, { base: BASE });
    expect(patches).toEqual([]);
    // No row, so no lastReceivedAt: the poller keeps polling this team.
    expect(webhookRows()).toEqual([]);
    expect(channel.webhook_url).toBe(FOREIGN);
  });

  it("refuses to replace without confirmed: true", async () => {
    await expect(
      setup.setup(id, { base: BASE, replace: true }),
    ).rejects.toMatchObject({ code: "confirm-required", status: 400 });
    expect(notificationCalls).toEqual([]);
    expect(webhookRows()).toEqual([]);
  });

  it("replaces it once confirmed", async () => {
    const result = await setup.setup(id, {
      base: BASE,
      replace: true,
      confirmed: true,
    });
    expect(result).toEqual({
      outcome: "configured",
      replaced: true,
      basePrivate: false,
    });
    const token = OURS.exec(String(patches[0].webhook_url))![1];
    expect(await webhooks.verify(token)).not.toBeNull();
  });
});

describe("webhook disable", () => {
  it("needs confirmed: true", async () => {
    await expect(setup.disable(id, {})).rejects.toMatchObject({
      code: "confirm-required",
    });
    expect(notificationCalls).toEqual([]);
  });

  it("removes our URL and our row while it is still ours", async () => {
    const token = seedRow("2026-11-20T10:00:00.000Z");
    channel.webhook_url = `${BASE}/plugin-api/coolify/webhook/${token}`;
    channel.webhook_enabled = true;
    const result = await setup.disable(id, { confirmed: true });
    expect(result).toEqual({ outcome: "disabled" });
    expect(patches).toEqual([{ webhook_url: null, webhook_enabled: false }]);
    expect(webhookRows()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("leaves someone else's URL alone, and drops our row Coolify no longer holds", async () => {
    seedRow("2026-11-20T10:00:00.000Z");
    channel.webhook_url = FOREIGN;
    channel.webhook_enabled = true;
    await expect(setup.disable(id, { confirmed: true })).rejects.toMatchObject({
      code: "not-ours",
      status: 409,
    });
    expect(patches).toEqual([]);
    expect(channel.webhook_url).toBe(FOREIGN);
    // Its token isn't in Coolify: kept, its lastReceivedAt would stop polling.
    expect(webhookRows()).toEqual([]);
  });

  it("does nothing in Coolify when no URL is set", async () => {
    const result = await setup.disable(id, { confirmed: true });
    expect(result).toEqual({ outcome: "not-set" });
    expect(patches).toEqual([]);
  });

  it("a retry after Coolify was cleared but the row wasn't deleted removes the stale row", async () => {
    // A disable that cleared Coolify, then stopped (row delete failed, or
    // the process exited) before the row went: the row still says the
    // webhook delivered, which keeps polling off.
    seedRow("2026-11-20T10:00:00.000Z");
    channel.webhook_url = null;
    channel.webhook_enabled = false;
    const result = await setup.disable(id, { confirmed: true });
    expect(result).toEqual({ outcome: "not-set" });
    expect(patches).toEqual([]);
    expect(webhookRows()).toEqual([]);
  });
});

describe("webhook setup: stale rows", () => {
  it("declining someone else's webhook drops our row Coolify no longer holds, so polling stays on", async () => {
    seedRow("2026-11-20T10:00:00.000Z");
    channel.webhook_url = FOREIGN;
    const result = await setup.setup(id, { base: BASE });
    expect(result.outcome).toBe("replace-needed");
    expect(patches).toEqual([]);
    expect(webhookRows()).toEqual([]);
  });

  it("a setup whose write to Coolify failed is retried into one working token", async () => {
    patchFailures = 1;
    await expect(setup.setup(id, { base: BASE })).rejects.toThrow();
    expect(channel.webhook_url).toBeNull();
    // The write-ahead row has no lastReceivedAt: polling goes on meanwhile.
    expect(webhookRows()).toHaveLength(1);
    expect(webhookRows()[0].last_received_at).toBeNull();
    await setup.setup(id, { base: BASE });
    const token = /webhook\/([A-Za-z0-9_-]{43})$/.exec(
      String(channel.webhook_url),
    )![1];
    expect(webhookRows()).toHaveLength(1);
    expect(await webhooks.verify(token)).not.toBeNull();
  });
});

describe("the event toggles", () => {
  it("cover exactly the events the receiver turns into an event kind", () => {
    const mapped = Object.entries(COOLIFY_WEBHOOK_EVENTS)
      .filter(([, shape]) => shape.map)
      .map(([event]) => event)
      .sort();
    expect(Object.keys(WEBHOOK_EVENT_TOGGLES).sort()).toEqual(mapped);
  });

  it("setup ticks each one's Coolify toggle, status change included", async () => {
    await setup.setup(id, { base: BASE });
    // `<key>_webhook_notifications`, each key from the notification's own
    // getEnabledChannels(...) in Coolify v4.7.5.
    expect(Object.keys(patches[0]).sort()).toEqual(
      [
        "webhook_url",
        "webhook_enabled",
        "deployment_success_webhook_notifications",
        "deployment_failure_webhook_notifications",
        "status_change_webhook_notifications",
        "restart_limit_reached_webhook_notifications",
        "backup_success_webhook_notifications",
        "backup_failure_webhook_notifications",
        "scheduled_task_success_webhook_notifications",
        "scheduled_task_failure_webhook_notifications",
        "server_disk_usage_webhook_notifications",
        "server_unreachable_webhook_notifications",
      ].sort(),
    );
    for (const field of WEBHOOK_EVENT_FIELDS) {
      expect(patches[0][field]).toBe(true);
    }
  });
});

describe("webhook setup: refusals", () => {
  it("refuses without a base address, before asking Coolify", async () => {
    await expect(setup.setup(id, { base: null })).rejects.toMatchObject({
      code: "no-base-url",
      status: 409,
    });
    expect(notificationCalls).toEqual([]);
    expect(webhookRows()).toEqual([]);
  });

  it("refuses when Coolify hides the URL (no read:sensitive), writing nothing", async () => {
    hidden = true;
    channel.webhook_url = FOREIGN;
    await expect(setup.setup(id, { base: BASE })).rejects.toMatchObject({
      code: "secrets-unreadable",
      status: 409,
    });
    await expect(setup.disable(id, { confirmed: true })).rejects.toMatchObject({
      code: "secrets-unreadable",
    });
    await expect(setup.status(id, { base: BASE })).rejects.toMatchObject({
      code: "secrets-unreadable",
    });
    expect(patches).toEqual([]);
    expect(webhookRows()).toEqual([]);
  });

  it("refuses a connection with no known team, or a scoped token", async () => {
    db.sqlite
      .prepare("UPDATE p_coolify_connections SET instance_key = NULL")
      .run();
    await expect(setup.setup(id, { base: BASE })).rejects.toMatchObject({
      code: "no-team",
      status: 409,
    });
    db.sqlite
      .prepare("UPDATE p_coolify_connections SET instance_key = ?")
      .run(`${COOLIFY}#7`);
    const stored = db.sqlite
      .prepare("SELECT abilities FROM p_coolify_connections WHERE id = ?")
      .get(id) as { abilities: string };
    db.sqlite
      .prepare("UPDATE p_coolify_connections SET abilities = ?")
      .run(JSON.stringify({ ...JSON.parse(stored.abilities), scoped: true }));
    await expect(setup.setup(id, { base: BASE })).rejects.toMatchObject({
      code: "scoped-token",
      status: 409,
    });
    expect(notificationCalls).toEqual([]);
  });

  it("stops with target-changed when the connection is repointed between the read and the write", async () => {
    afterRead = () => {
      db.sqlite
        .prepare(
          "UPDATE p_coolify_connections SET token_sealed = 'repointed' WHERE id = ?",
        )
        .run(id);
    };
    await expect(setup.setup(id, { base: BASE })).rejects.toMatchObject({
      code: "target-changed",
      status: 409,
    });
    expect(patches).toEqual([]);
    expect(webhookRows()).toEqual([]);
  });

  it("stops a disable with target-changed too", async () => {
    const token = seedRow();
    channel.webhook_url = `${BASE}/plugin-api/coolify/webhook/${token}`;
    afterRead = () => {
      db.sqlite
        .prepare(
          "UPDATE p_coolify_connections SET token_sealed = 'repointed' WHERE id = ?",
        )
        .run(id);
    };
    await expect(setup.disable(id, { confirmed: true })).rejects.toMatchObject({
      code: "target-changed",
    });
    expect(patches).toEqual([]);
    expect(webhookRows()).toHaveLength(1);
  });

  it("needs coolify.configure", async () => {
    vi.spyOn(mock.ctx.rbac, "has").mockImplementation(
      async (permission: string) => permission !== "configure",
    );
    for (const call of [
      () => setup.status(id, { base: BASE }),
      () => setup.setup(id, { base: BASE }),
      () => setup.setup(id, { base: BASE, replace: true, confirmed: true }),
      () => setup.disable(id, { confirmed: true }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "forbidden",
        status: 403,
      });
    }
    expect(notificationCalls).toEqual([]);
  });

  it("needs the owner or a configure grant; another user's connection is 404", async () => {
    mock.setActor(OTHER);
    await expect(setup.setup(id, { base: BASE })).rejects.toMatchObject({
      status: 404,
    });
    for (const level of ["view", "operate"]) {
      db.sqlite.prepare("DELETE FROM p_coolify_grants").run();
      db.sqlite
        .prepare(
          "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
        )
        .run(id, OTHER, level);
      await expect(setup.setup(id, { base: BASE })).rejects.toMatchObject({
        code: "forbidden",
        status: 403,
      });
    }
    expect(notificationCalls).toEqual([]);
    db.sqlite.prepare("DELETE FROM p_coolify_grants").run();
    db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
      )
      .run(id, OTHER, "configure");
    await expect(setup.setup(id, { base: BASE })).resolves.toMatchObject({
      outcome: "configured",
    });
  });
});

describe("webhook status", () => {
  it("reads unset, ours and someone else's, never showing a token", async () => {
    expect(await setup.status(id, { base: BASE })).toEqual({
      state: "unset",
      enabled: false,
      current: null,
      base: BASE,
      basePrivate: false,
    });
    const token = seedRow();
    channel.webhook_url = `${BASE}/plugin-api/coolify/webhook/${token}`;
    channel.webhook_enabled = true;
    const ours = await setup.status(id, { base: BASE });
    expect(ours).toMatchObject({ state: "ours", enabled: true, current: null });
    expect(JSON.stringify(ours)).not.toContain(token);
    channel.webhook_url = FOREIGN;
    expect(await setup.status(id, { base: null })).toEqual({
      state: "foreign",
      enabled: true,
      current: "https://hooks.example.net/[redacted]",
      base: null,
      basePrivate: false,
    });
    expect(patches).toEqual([]);
  });
});

describe("the private address warning", () => {
  it.each([
    ["http://192.168.1.10:8080", true],
    ["http://10.0.0.5", true],
    ["http://localhost:3000", true],
    ["http://127.0.0.1:8080", true],
    ["http://[fd00::1]:8080", true],
    ["https://termix.local", true],
    ["https://termix.internal", true],
    ["https://termix.example.com", false],
    ["https://203.0.113.9", false],
  ])("%s is private: %s", (base, expected) => {
    expect(privateBase(base)).toBe(expected);
  });

  it("is in the status and the setup answer", async () => {
    const base = "http://192.168.1.10:8080";
    expect(await setup.status(id, { base })).toMatchObject({
      base,
      basePrivate: true,
    });
    expect(await setup.setup(id, { base })).toMatchObject({
      outcome: "configured",
      basePrivate: true,
    });
  });
});

describe("maskWebhookUrl", () => {
  it.each([
    [FOREIGN, "https://hooks.example.net/[redacted]"],
    ["https://hooks.example.net", "https://hooks.example.net"],
    ["https://hooks.example.net/", "https://hooks.example.net"],
    [
      "https://user:pass@hooks.example.net:8443/x",
      "https://hooks.example.net:8443/[redacted]",
    ],
    ["not a url", "[redacted]"],
  ])("%s → %s", (url, masked) => {
    expect(maskWebhookUrl(url)).toBe(masked);
  });
});

describe("the audit", () => {
  it("records setup and disable with no URL or token", async () => {
    await setup.setup(id, { base: BASE });
    const token = OURS.exec(String(patches[0].webhook_url))![1];
    await setup.disable(id, { confirmed: true });
    expect(mock.audits.map((a) => a.action)).toEqual([
      "coolify_webhook_setup",
      "coolify_webhook_disable",
    ]);
    const text = JSON.stringify(mock.audits);
    expect(text).not.toContain(token);
    expect(text).not.toContain("/webhook/");
  });
});
