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
import { defineTables } from "../../../src/backend/db.js";
import {
  createConnections,
  type Connections,
} from "../../../src/backend/connections/service.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;
const TOKEN = "fake-token-service-test";
const CF_SECRET = "fake-cf-secret-service-test";

let db: TestDb;
let mock: MockPluginContext;
let service: Connections;
let fake: ReturnType<typeof healthyCoolify>;
let released: { connectionId: number; removeHosts: boolean }[];

const input = {
  name: "Prod",
  baseUrl: "https://Coolify.Example.Test/",
  token: TOKEN,
};

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  for (const user of ["user-1", "user-2"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  fake = healthyCoolify();
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    db: db.database,
    fetch: (url, init) => fake.fetch(url, init),
    actor: "user-1",
  });
  released = [];
  service = createConnections(mock.ctx, await defineTables(mock.ctx), {
    releaseLinkedHosts: async (connectionId, opts) => {
      released.push({ connectionId, removeHosts: opts.removeHosts });
    },
  });
});

afterEach(() => db.close());

function rawRows() {
  return db.sqlite
    .prepare("SELECT * FROM p_coolify_connections")
    .all() as Record<string, unknown>[];
}

describe("connection service", () => {
  it("token is sealed at rest", async () => {
    const view = await service.create({
      ...input,
      cfAccessId: "fake-cf-id",
      cfAccessSecret: CF_SECRET,
    });
    const [row] = rawRows();
    expect(row.token_sealed).not.toBe(TOKEN);
    expect(String(row.token_sealed)).not.toContain(TOKEN);
    expect(row.cf_access_secret_sealed).not.toBe(CF_SECRET);
    expect(await mock.ctx.secrets.unseal(String(row.token_sealed))).toBe(TOKEN);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(view)).not.toContain(CF_SECRET);
    expect(view.cfAccess).toBe(true);
  });

  it("stores the probe result, instanceKey and a normalized URL", async () => {
    const view = await service.create(input);
    expect(view).toMatchObject({
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      version: "v4.7.5",
      teamName: "Ops team",
      scoped: false,
      lastError: null,
      access: "owner",
      abilities: { read: true, sensitive: true, keys: true, root: false },
    });
    expect(rawRows()[0].instance_key).toBe("https://coolify.example.test#7");
  });

  it("probe marks keys readable only when private_key is present and discards it: the stored row holds no key", async () => {
    await service.create(input);
    const text = JSON.stringify(rawRows());
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("not-a-real-key");
  });

  it("refuses Coolify older than 4.4 and stores nothing", async () => {
    fake.set("GET /version", { text: "v4.2.0" });
    await expect(service.create(input)).rejects.toMatchObject({
      cause: "unsupported-version",
      message: "This plugin needs Coolify 4.4 or newer",
    });
    expect(rawRows()).toHaveLength(0);
  });

  it("keeps a connection that can't be reached, with the cause as lastError", async () => {
    fake.set("GET /health", () => {
      throw new Error("ECONNREFUSED");
    });
    const view = await service.create(input);
    expect(view.lastError).toBe("unreachable");
    expect(view.steps).toEqual([
      { id: "health", ok: false, cause: "unreachable" },
    ]);
  });

  it("validates input", async () => {
    await expect(
      service.create({ ...input, baseUrl: "ftp://x" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create({ ...input, token: " " }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.create({ ...input, name: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.create({ ...input, cfAccessId: "only-the-id" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(rawRows()).toHaveLength(0);
  });

  it("another user gets 404", async () => {
    const view = await service.create(input);
    mock.setActor("user-2");
    expect(await service.list()).toEqual([]);
    expect(await service.get(view.id)).toBeNull();
    expect(await service.access(view.id)).toBeNull();
    await expect(service.target(view.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.update(view.id, { name: "x" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.remove(view.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(rawRows()).toHaveLength(1);
  });

  it("PATCH with empty token keeps the stored one", async () => {
    const view = await service.create(input);
    const before = rawRows()[0].token_sealed;
    await service.update(view.id, { token: "", name: "Renamed" });
    expect(rawRows()[0].token_sealed).toBe(before);
    expect((await service.target(view.id)).token).toBe(TOKEN);
    expect((await service.get(view.id))?.name).toBe("Renamed");

    await service.update(view.id, { token: "fake-new-token" });
    expect((await service.target(view.id)).token).toBe("fake-new-token");
  });

  it("re-probes when the address or token changes", async () => {
    const view = await service.create(input);
    const calls = fake.calls.length;
    await service.update(view.id, { name: "Only a name" });
    expect(fake.calls.length).toBe(calls);
    await service.update(view.id, { token: "fake-other-token" });
    expect(fake.calls.length).toBeGreaterThan(calls);
    const last = fake.calls[fake.calls.length - 1];
    expect(last.init?.headers?.authorization).toBe("Bearer fake-other-token");
  });

  it("clears the Cloudflare Access token with null", async () => {
    const view = await service.create({
      ...input,
      cfAccessId: "fake-cf-id",
      cfAccessSecret: CF_SECRET,
    });
    expect((await service.target(view.id)).cfAccess).toEqual({
      id: "fake-cf-id",
      secret: CF_SECRET,
    });
    const updated = await service.update(view.id, {
      cfAccessId: null,
      cfAccessSecret: null,
    });
    expect(updated.cfAccess).toBe(false);
    expect((await service.target(view.id)).cfAccess).toBeNull();
  });

  it("api() calls Coolify with the stored token", async () => {
    const view = await service.create(input);
    const api = await service.api(view.id);
    await api.team();
    const last = fake.calls[fake.calls.length - 1];
    expect(last.path).toBe("/team");
    expect(last.init?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("remove deletes the connection and its rows, and hands Linked hosts to the release hook", async () => {
    const view = await service.create(input);
    const keep = await service.create({ ...input, name: "Other" });
    db.sqlite
      .prepare(
        "INSERT INTO p_coolify_servers (connection_id, server_uuid) VALUES (?, ?), (?, ?)",
      )
      .run(view.id, "s1", keep.id, "s2");
    db.sqlite
      .prepare(
        "INSERT INTO p_coolify_cache (connection_id, kind, json, fetched_at) VALUES (?, 'x', '{}', '2026-01-01')",
      )
      .run(view.id);
    await service.remove(view.id, { removeHosts: true });
    expect(released).toEqual([{ connectionId: view.id, removeHosts: true }]);
    expect(rawRows().map((r) => r.id)).toEqual([keep.id]);
    expect(
      db.sqlite.prepare("SELECT server_uuid FROM p_coolify_servers").all(),
    ).toEqual([{ server_uuid: "s2" }]);
    expect(db.sqlite.prepare("SELECT * FROM p_coolify_cache").all()).toEqual(
      [],
    );

    await service.remove(keep.id);
    expect(released[1]).toEqual({ connectionId: keep.id, removeHosts: false });
  });

  it("lists only the actor's own connections", async () => {
    await service.create(input);
    mock.setActor("user-2");
    await service.create({ ...input, name: "Theirs" });
    expect((await service.list()).map((c) => c.name)).toEqual(["Theirs"]);
    mock.setActor("user-1");
    expect((await service.list()).map((c) => c.name)).toEqual(["Prod"]);
  });
});
