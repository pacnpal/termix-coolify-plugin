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

type Headers = Record<string, string> | undefined;

/** A /team answer, already read, held back for one request until released. */
let hold: {
  match: (headers: Headers) => boolean;
  held: Promise<void>;
  reached: () => void;
} | null = null;

function holdAfterTeamWhen(
  match: (headers: Headers) => boolean,
  held: Promise<void>,
): Promise<void> {
  return new Promise((reached) => {
    hold = { match, held, reached };
  });
}

/** Holds the /team answer sent with one token. */
function holdAfterTeam(auth: string, held: Promise<void>): Promise<void> {
  return holdAfterTeamWhen((h) => h?.authorization === auth, held);
}

beforeEach(async () => {
  hold = null;
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
    fetch: async (url, init) => {
      const answer = await fake.fetch(url, init);
      const h = hold;
      if (
        h &&
        url.endsWith("/api/v1/team") &&
        h.match(init?.headers as Headers)
      ) {
        hold = null;
        h.reached();
        await h.held;
      }
      return answer;
    },
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

  it("a new token repairs a connection whose stored token can't be unsealed", async () => {
    const view = await service.create({
      ...input,
      cfAccessId: "fake-cf-id",
      cfAccessSecret: CF_SECRET,
    });
    db.sqlite
      .prepare(
        "UPDATE p_coolify_connections SET token_sealed = ?, cf_access_secret_sealed = ?",
      )
      .run("fake-damaged-seal", "fake-damaged-seal");
    await expect(service.target(view.id)).rejects.toMatchObject({
      cause: "unauthorized",
    });

    // An unrelated change needs no secret.
    const renamed = await service.update(view.id, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");

    // A new token alone can't be checked: the Cloudflare Access secret is damaged too.
    await expect(
      service.update(view.id, { token: "fake-repair-token" }),
    ).rejects.toMatchObject({ status: 400 });

    const calls = fake.calls.length;
    const repaired = await service.update(view.id, {
      token: "fake-repair-token",
      cfAccessId: "fake-cf-id-2",
      cfAccessSecret: "fake-cf-secret-2",
    });
    expect(repaired.lastError).toBeNull();
    expect(fake.calls.length).toBeGreaterThan(calls);
    expect(
      fake.calls
        .slice(calls)
        .every(
          (c) => c.init?.headers?.authorization === "Bearer fake-repair-token",
        ),
    ).toBe(true);
    expect(await service.target(view.id)).toMatchObject({
      token: "fake-repair-token",
      cfAccess: { id: "fake-cf-id-2", secret: "fake-cf-secret-2" },
    });
  });

  it("changing baseUrl without a token when the old one can't be unsealed is refused", async () => {
    const view = await service.create(input);
    db.sqlite
      .prepare("UPDATE p_coolify_connections SET token_sealed = ?")
      .run("fake-damaged-seal");
    const calls = fake.calls.length;
    await expect(
      service.update(view.id, { baseUrl: "https://other.example.test" }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("token"),
    });
    // Nothing was sent, so no empty token went out, and nothing was stored.
    expect(fake.calls.length).toBe(calls);
    expect(rawRows()[0].base_url).toBe("https://coolify.example.test");
  });

  it("a probe of an old target is dropped after an update changed the target", async () => {
    const view = await service.create(input);
    // Hold the old token's probe after it has read the old team.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reachedTeam = holdAfterTeam(`Bearer ${TOKEN}`, held);

    const stale = service.probe(view.id);
    await reachedTeam;
    fake.set("GET /team", { json: { id: 9, name: "New team" } });
    const updated = await service.update(view.id, {
      token: "fake-newer-token",
    });
    expect(updated.teamName).toBe("New team");

    release();
    await stale;
    const stored = await service.get(view.id);
    expect(stored?.teamName).toBe("New team");
    expect(rawRows()[0].instance_key).toBe("https://coolify.example.test#9");
    expect((await service.target(view.id)).token).toBe("fake-newer-token");
  });

  it("a stale probe result does not overwrite a newer update, when it ran inside an update", async () => {
    const view = await service.create(input);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reachedTeam = holdAfterTeam("Bearer fake-older-token", held);

    const older = service.update(view.id, { token: "fake-older-token" });
    await reachedTeam;
    fake.set("GET /team", { json: { id: 9, name: "New team" } });
    const newer = service.update(view.id, { token: "fake-newer-token" });

    release();
    // Updates to one connection run one after another, in the order asked.
    await expect(older).resolves.toMatchObject({ teamName: "Ops team" });
    await expect(newer).resolves.toMatchObject({ teamName: "New team" });
    expect((await service.get(view.id))?.teamName).toBe("New team");
    expect(rawRows()[0].instance_key).toBe("https://coolify.example.test#9");
    expect((await service.target(view.id)).token).toBe("fake-newer-token");
  });

  it("concurrent updates to one connection apply in order and none is lost", async () => {
    const view = await service.create(input);
    const cert = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----";
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reachedTeam = holdAfterTeam("Bearer fake-older-token", held);

    const older = service.update(view.id, { token: "fake-older-token" });
    await reachedTeam;
    const newer = service.update(view.id, {
      caCert: cert,
      allowPrivate: true,
      name: "Renamed",
    });

    release();
    await expect(older).resolves.toBeTruthy();
    await expect(newer).resolves.toBeTruthy();
    const [row] = rawRows();
    expect(row.name).toBe("Renamed");
    expect(row.ca_cert).toBe(cert);
    expect(row.allow_private).toBeTruthy();
    expect((await service.target(view.id)).token).toBe("fake-older-token");
  });

  it("an update racing a rename does not answer conflict when its write applied", async () => {
    const view = await service.create(input);
    // Start a rename right after the update's write is persisted, and give it
    // time to land before the update would read its row back.
    const persist = mock.ctx.db.persist;
    let rename: Promise<unknown> | null = null;
    mock.ctx.db.persist = async () => {
      await persist();
      if (!rename) {
        rename = service.update(view.id, { name: "Renamed" });
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    const saved = service.update(view.id, {
      token: "fake-newer-token",
      name: "From update",
    });
    await expect(saved).resolves.toMatchObject({ name: "From update" });
    await rename;
    mock.ctx.db.persist = persist;
    expect((await service.target(view.id)).token).toBe("fake-newer-token");
    expect((await service.get(view.id))?.name).toBe("Renamed");
  });

  it("ipv6 private check uses real prefixes", async () => {
    const refuse = async (baseUrl: string) =>
      expect(
        service.create({ ...input, baseUrl, allowPrivate: true }),
        baseUrl,
      ).rejects.toMatchObject({ status: 400 });
    const allow = async (baseUrl: string) =>
      expect(
        (await service.create({ ...input, baseUrl, allowPrivate: true }))
          .baseUrl,
        baseUrl,
      ).toBe(baseUrl);
    for (const host of ["fc::1", "fe8::1", "fec0::1", "2001:db8::1"]) {
      await refuse(`http://[${host}]:8000`);
    }
    for (const host of ["fc00::1", "fdff:ffff::1", "fe80::1", "febf::1"]) {
      await allow(`http://[${host}]:8000`);
    }
    // IPv4-mapped: the embedded IPv4 decides (URL writes it in hex).
    const mapped = await service.create({
      ...input,
      baseUrl: "http://[::ffff:10.0.0.1]:8000",
      allowPrivate: true,
    });
    expect(mapped.baseUrl).toBe("http://[::ffff:a00:1]:8000");
    await refuse("http://[::ffff:8.8.8.8]:8000");
  });

  it("refuses plain http to a public host before sending anything", async () => {
    for (const baseUrl of [
      "http://coolify.example.test",
      "http://203.0.113.5:8000",
      "http://192.168.1.10:8000",
    ]) {
      await expect(
        service.create({ ...input, baseUrl }),
        baseUrl,
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("HTTPS"),
      });
    }
    expect(fake.calls).toHaveLength(0);
    expect(rawRows()).toHaveLength(0);

    const view = await service.create(input);
    const calls = fake.calls.length;
    await expect(
      service.update(view.id, { baseUrl: "http://coolify.example.test" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fake.calls.length).toBe(calls);
    expect(rawRows()[0].base_url).toBe("https://coolify.example.test");
  });

  it("allows plain http to loopback, and to a private host only with allowPrivate", async () => {
    for (const baseUrl of [
      "http://localhost:8000",
      "http://127.0.0.1:8000",
      "http://[::1]:8000",
    ]) {
      const saved = await service.create({ ...input, baseUrl });
      expect(saved.baseUrl, baseUrl).toBe(baseUrl);
    }
    for (const baseUrl of ["http://192.168.1.10:8000", "http://10.0.0.5"]) {
      const saved = await service.create({
        ...input,
        baseUrl,
        allowPrivate: true,
      });
      expect(saved.baseUrl, baseUrl).toBe(baseUrl);
    }
  });

  it("http to a .lan name is refused even with allowPrivateHosts", async () => {
    // A name can resolve anywhere, so only https protects its token.
    for (const baseUrl of [
      "http://coolify.lan",
      "http://coolify",
      "http://coolify.local:8000",
      "http://coolify.internal",
      "http://coolify.localdomain",
      "http://coolify.home.arpa",
    ]) {
      await expect(
        service.create({ ...input, baseUrl, allowPrivate: true }),
        baseUrl,
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/HTTPS.*private IP address/),
      });
    }
    expect(fake.calls).toHaveLength(0);
    expect(rawRows()).toHaveLength(0);
  });

  it("http to a private IP literal is allowed only with allowPrivateHosts", async () => {
    for (const baseUrl of [
      "http://192.168.1.10:8000",
      "http://172.16.4.2",
      "http://169.254.10.1",
      "http://[fd00::5]:8000",
    ]) {
      await expect(
        service.create({ ...input, baseUrl }),
        baseUrl,
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/HTTPS.*private IP address/),
      });
      const saved = await service.create({
        ...input,
        baseUrl,
        allowPrivate: true,
      });
      expect(saved.baseUrl, baseUrl).toBe(baseUrl);
    }
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
