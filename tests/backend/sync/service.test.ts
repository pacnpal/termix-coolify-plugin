import { afterEach, describe, expect, it, vi } from "vitest";
import { startPlugin, type PluginHarness } from "../helpers/plugin.js";
import {
  LOCAL,
  LOCAL_PRIVATE_MARKER,
  PRIVATE_MARKER,
  TUNNEL,
  WEB1,
  WEB2,
  deployKey,
  dumpTables,
  serverRows,
  startWithConnection,
  syncCoolify,
} from "./fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: Parameters<typeof startWithConnection>[0] = {}) {
  const started = await startWithConnection(options);
  harness = started.harness;
  return started;
}

type Choice = {
  uuid: string;
  include: boolean;
  addressOverride?: string | null;
  credentialId?: number | null;
};

function only(...uuids: string[]): Choice[] {
  return [WEB1, WEB2, LOCAL, TUNNEL].map((s) => ({
    uuid: s.uuid,
    include: uuids.includes(s.uuid),
  }));
}

async function preview(h: PluginHarness, id: number) {
  const res = await h.request("GET", `/connections/${id}/servers`);
  expect(res.status).toBe(200);
  return res.body as any[];
}

async function apply(h: PluginHarness, id: number, choices: Choice[]) {
  const res = await h.request("POST", `/connections/${id}/sync`, { choices });
  expect(res.status).toBe(200);
  return res.body as any[];
}

function byUuid(rows: any[], uuid: string) {
  const found = rows.find((r) => (r.server?.uuid ?? r.uuid) === uuid);
  if (!found) throw new Error(`no row for ${uuid}`);
  return found;
}

function lockProvider(h: PluginHarness) {
  const [provider] = h.mock.hostLockProviders;
  if (!provider) throw new Error("no lock provider");
  return provider;
}

describe("host sync", () => {
  it("preview lists every server with what it would become", async () => {
    const { harness: h, connectionId } = await start();
    const rows = await preview(h, connectionId);
    expect(rows.map((r) => r.server.uuid).sort()).toEqual(
      ["srv-local", "srv-vps1", "srv-web1", "srv-web2"].sort(),
    );
    expect(byUuid(rows, "srv-web1")).toMatchObject({
      status: "new",
      mode: "coolify",
      hostId: null,
    });
    expect(byUuid(rows, "srv-local")).toMatchObject({
      status: "blocked",
      cause: "needs-address",
      suggestedAddress: "coolify.example.test",
    });
    expect(byUuid(rows, "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "needs-tunnel-support",
      tunnel: true,
    });
  });

  it("mode A copies each Coolify key once", async () => {
    const { harness: h, connectionId } = await start();
    const results = await apply(h, connectionId, only("srv-web1", "srv-web2"));
    expect(byUuid(results, "srv-web1").status).toBe("created");
    expect(byUuid(results, "srv-web2").status).toBe("created");

    expect(h.mock.createdSshKeys).toHaveLength(1);
    const [key] = h.mock.createdSshKeys;
    expect(key.name).toBe("Coolify: Prod / deploy key");
    expect(key.keyType).toBe("ssh-ed25519");

    const hosts = await h.mock.ctx.hosts.listOwned();
    expect(hosts).toHaveLength(2);
    for (const host of hosts) {
      expect(host.credentialId).toBe(key.id);
      expect(host.authType).toBe("credential");
      expect(host.folder).toBe("Coolify");
      expect(host.tags).toBe("coolify");
    }
  });

  it("re-sync reuses the credential and replaces it only when the fingerprint changes", async () => {
    const { harness: h, fake, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    await apply(h, connectionId, only("srv-web1", "srv-web2"));
    expect(h.mock.createdSshKeys).toHaveLength(1);

    fake.set("GET /security/keys/key-uuid", {
      json: deployKey({ fingerprint: "SHA256:fake-rotated-fingerprint" }),
    });
    await apply(h, connectionId, only("srv-web1", "srv-web2"));
    expect(h.mock.createdSshKeys).toHaveLength(2);
    const newId = h.mock.createdSshKeys[1].id;
    for (const host of await h.mock.ctx.hosts.listOwned()) {
      expect(host.credentialId).toBe(newId);
    }
  });

  it("every key copy is audited", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, [
      ...only("srv-web1", "srv-web2").filter((c) => c.uuid !== "srv-local"),
      { uuid: "srv-local", include: true, addressOverride: "10.0.0.2" },
    ]);
    expect(h.mock.createdSshKeys).toHaveLength(2);
    const copies = h.mock.audits.filter(
      (a) => a.action === "coolify_key_copied",
    );
    expect(copies).toHaveLength(2);
    expect(copies.map((a) => a.resourceName).sort()).toEqual([
      "Coolify: Prod / deploy key",
      "Coolify: Prod / localhost key",
    ]);
    for (const audit of copies) {
      expect(audit.success).toBe(true);
      expect(audit.resourceType).toBe("credential");
      expect(String(audit.resourceId)).toMatch(/^\d+$/);
    }
    expect(JSON.stringify(h.mock.audits)).not.toContain(PRIVATE_MARKER);
  });

  it("mode B when keys are unreadable asks for credentialId", async () => {
    const fake = syncCoolify({
      "GET /security/keys/key-uuid": {
        json: deployKey({ private_key: undefined }),
      },
      "GET /security/keys/key-local": {
        json: { id: 1, uuid: "key-local", name: "localhost key" },
      },
    });
    const { harness: h, connectionId } = await start({
      fake,
      ownCredentials: [42],
    });
    const rows = await preview(h, connectionId);
    expect(byUuid(rows, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "needs-credential",
      mode: "termix",
    });

    const blocked = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(blocked, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "needs-credential",
    });
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(0);
    expect(h.mock.createdSshKeys).toHaveLength(0);

    const picked = await apply(h, connectionId, [
      { uuid: "srv-web1", include: true, credentialId: 42 },
    ]);
    expect(byUuid(picked, "srv-web1").status).toBe("created");
    const [host] = await h.mock.ctx.hosts.listOwned();
    expect(host.credentialId).toBe(42);
    expect(h.mock.createdSshKeys).toHaveLength(0);
    expect(byUuid(await preview(h, connectionId), "srv-web1")).toMatchObject({
      status: "linked",
      credentialId: 42,
    });
  });

  it("a readable-key token whose key comes back without material falls back to a picked credential", async () => {
    const fake = syncCoolify();
    const { harness: h, connectionId } = await start({ fake });
    fake.set("GET /security/keys/key-uuid", {
      status: 403,
      json: { message: "Forbidden." },
    });
    const results = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(results, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "needs-credential",
    });
  });

  it("a key copy that fails is remembered, so the preview asks for a credential", async () => {
    const fake = syncCoolify();
    const { harness: h, connectionId } = await start({
      fake,
      ownCredentials: [42],
    });
    fake.set("GET /security/keys/key-uuid", {
      status: 403,
      json: { message: "Forbidden." },
    });
    await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(await preview(h, connectionId), "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "needs-credential",
      mode: "termix",
    });

    // A picked credential clears it.
    const picked = await apply(h, connectionId, [
      { uuid: "srv-web1", include: true, credentialId: 42 },
    ]);
    expect(byUuid(picked, "srv-web1").status).toBe("created");
    expect(byUuid(await preview(h, connectionId), "srv-web1")).toMatchObject({
      status: "linked",
      mode: "termix",
      credentialId: 42,
    });
  });

  it("a failed key copy clears once a later copy succeeds", async () => {
    const fake = syncCoolify();
    const { harness: h, connectionId } = await start({ fake });
    fake.set("GET /security/keys/key-uuid", {
      status: 403,
      json: { message: "Forbidden." },
    });
    await apply(h, connectionId, only("srv-web1"));
    fake.set("GET /security/keys/key-uuid", { json: deployKey() });
    // Including the server with no credential picked tries the copy again.
    const res = await h.request("POST", `/connections/${connectionId}/sync`, {
      choices: only("srv-web1"),
    });
    expect(byUuid(res.body, "srv-web1").status).toBe("created");
    expect(byUuid(await preview(h, connectionId), "srv-web1")).toMatchObject({
      status: "linked",
      mode: "coolify",
    });
  });

  it("a copied credential deleted in Termix is copied again, and the new id is saved", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    expect(h.mock.createdSshKeys).toHaveLength(1);
    const oldId = h.mock.createdSshKeys[0].id;

    // The user deleted that credential: it is no longer among their keys.
    const listKeys = h.mock.ctx.credentials.listSshKeys.bind(
      h.mock.ctx.credentials,
    );
    vi.spyOn(h.mock.ctx.credentials, "listSshKeys").mockImplementation(
      async () => (await listKeys()).filter((k) => k.id !== oldId),
    );
    const again = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(again, "srv-web1").status).toBe("updated");
    expect(h.mock.createdSshKeys).toHaveLength(2);
    const newId = h.mock.createdSshKeys[1].id;
    expect(newId).not.toBe(oldId);
    const [row] = serverRows(h).filter((r) => r.server_uuid === "srv-web1");
    expect(row.credential_id).toBe(newId);
    const [host] = await h.mock.ctx.hosts.listOwned();
    expect(host.credentialId).toBe(newId);
  });

  it("a copied credential that can't be checked is refused, not reused", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    vi.spyOn(h.mock.ctx.credentials, "listSshKeys").mockRejectedValue(
      new Error("no credentials.view"),
    );
    const again = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(again, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "credential-check-failed",
    });
    expect(h.mock.createdSshKeys).toHaveLength(1);
  });

  it("a picked credential that isn't one of the actor's own is refused and nothing is stored", async () => {
    const { harness: h, connectionId } = await start({
      settings: { allowKeyCopy: false },
      ownCredentials: [42],
    });
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const list = vi.spyOn(h.mock.ctx.credentials, "list");
    const results = await apply(h, connectionId, [
      { uuid: "srv-web1", include: true, credentialId: 99 },
      { uuid: "srv-web2", include: true, credentialId: 42 },
    ]);
    expect(byUuid(results, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "credential-not-found",
      hostId: null,
    });
    expect(byUuid(results, "srv-web2").status).toBe("created");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].credentialId).toBe(42);
    expect(list).toHaveBeenCalledTimes(1);
    expect(serverRows(h).map((r) => r.server_uuid)).toEqual(["srv-web2"]);
  });

  it("a stored termix credential that is gone blocks the row in apply and preview", async () => {
    const { harness: h, connectionId } = await start({
      settings: { allowKeyCopy: false },
      ownCredentials: [42],
    });
    await apply(h, connectionId, [
      { uuid: "srv-web1", include: true, credentialId: 42 },
    ]);
    const [host] = await h.mock.ctx.hosts.listOwned();
    vi.spyOn(h.mock.ctx.credentials, "list").mockResolvedValue([]);
    expect(byUuid(await preview(h, connectionId), "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "credential-not-found",
    });
    const update = vi.spyOn(h.mock.ctx.hosts, "update");
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const results = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(results, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "credential-not-found",
      hostId: host.id,
    });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("when the credential list can't be read, every termix-mode row is blocked", async () => {
    const { harness: h, connectionId } = await start({
      ownCredentials: [42],
    });
    vi.spyOn(h.mock.ctx.credentials, "list").mockRejectedValue(
      new Error("no credentials.view"),
    );
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const results = await apply(h, connectionId, [
      { uuid: "srv-web1", include: true, credentialId: 42 },
      { uuid: "srv-web2", include: true },
    ]);
    expect(byUuid(results, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "credential-check-failed",
    });
    // A copied Coolify key is the plugin's own credential: not checked.
    expect(byUuid(results, "srv-web2").status).toBe("created");
    expect(create).toHaveBeenCalledTimes(1);
    // Nothing was stored for the refused server.
    expect(serverRows(h).map((r) => r.server_uuid)).toEqual(["srv-web2"]);
  });

  it("admin setting allowKeyCopy=false forces mode B", async () => {
    const { harness: h, connectionId } = await start({
      settings: { allowKeyCopy: false },
    });
    // The probe at connect read one key; sync itself must read none.
    const before = h.mock.fetches.length;
    const rows = await preview(h, connectionId);
    expect(byUuid(rows, "srv-web1")).toMatchObject({
      status: "blocked",
      cause: "needs-credential",
      mode: "termix",
    });
    const results = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(results, "srv-web1").cause).toBe("needs-credential");
    expect(h.mock.createdSshKeys).toHaveLength(0);
    expect(
      h.mock.fetches
        .slice(before)
        .some((f) => f.url.includes("/security/keys")),
    ).toBe(false);
  });

  it("the Coolify host without an address is refused needs-address while others sync", async () => {
    const { harness: h, connectionId } = await start();
    const results = await apply(h, connectionId, only("srv-web1", "srv-local"));
    expect(byUuid(results, "srv-local")).toMatchObject({
      status: "blocked",
      cause: "needs-address",
    });
    expect(byUuid(results, "srv-web1").status).toBe("created");
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(1);

    const second = await apply(h, connectionId, [
      { uuid: "srv-local", include: true, addressOverride: "10.0.0.2" },
    ]);
    expect(byUuid(second, "srv-local").status).toBe("created");
    const local = (await h.mock.ctx.hosts.listOwned()).find(
      (x) => x.name === "localhost",
    );
    expect(local?.ip).toBe("10.0.0.2");
    expect(byUuid(await preview(h, connectionId), "srv-local")).toMatchObject({
      status: "linked",
      addressOverride: "10.0.0.2",
    });
  });

  it("refuses an address override that isn't a host name or IP", async () => {
    const { harness: h, connectionId } = await start();
    const res = await h.request("POST", `/connections/${connectionId}/sync`, {
      choices: [{ uuid: "srv-local", include: true, addressOverride: "a;b" }],
    });
    expect(res.status).toBe(400);
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(0);
  });

  it("a tunnelled server is refused with the tunnel cause", async () => {
    const { harness: h, connectionId } = await start();
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const results = await apply(h, connectionId, only("srv-vps1", "srv-web1"));
    expect(byUuid(results, "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "needs-tunnel-support",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls)).not.toContain("ssh-terminal");
  });

  it("apply updates an existing linked host in place", async () => {
    const { harness: h, fake, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    const [before] = await h.mock.ctx.hosts.listOwned();

    fake.set("GET /servers", {
      json: [{ ...WEB1, name: "web-1-renamed" }, WEB2, LOCAL, TUNNEL],
    });
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const update = vi.spyOn(h.mock.ctx.hosts, "update");
    const results = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(results, "srv-web1")).toMatchObject({
      status: "updated",
      hostId: before.id,
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      before.id,
      expect.objectContaining({ name: "web-1-renamed" }),
    );
    const after = await h.mock.ctx.hosts.listOwned();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
  });

  it("gone server is reported, not deleted", async () => {
    const { harness: h, fake, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    const [host] = await h.mock.ctx.hosts.listOwned();

    fake.set("GET /servers", { json: [WEB2, LOCAL, TUNNEL] });
    const remove = vi.spyOn(h.mock.ctx.hosts, "delete");
    const rows = await preview(h, connectionId);
    expect(byUuid(rows, "srv-web1")).toMatchObject({
      status: "gone",
      hostId: host.id,
    });
    const results = await apply(h, connectionId, only("srv-web2"));
    expect(byUuid(results, "srv-web1")).toMatchObject({
      status: "gone",
      hostId: host.id,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(
      (await h.mock.ctx.hosts.listOwned()).some((x) => x.id === host.id),
    ).toBe(true);
    expect(lockProvider(h).isLocked(host.id)).toBe(true);
  });

  it("linked hosts are locked and Unlink releases the lock", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    const [host] = await h.mock.ctx.hosts.listOwned();
    const provider = lockProvider(h);
    expect(provider.isLocked(host.id)).toBe(true);
    expect(provider.lockedHosts?.()).toEqual([host.id]);
    expect(provider.note(host.id)).toBeTruthy();
    expect(provider.allowManualCreate()).toBe(true);

    const update = vi.spyOn(h.mock.ctx.hosts, "update");
    const res = await h.request(
      "POST",
      `/connections/${connectionId}/servers/srv-web1/unlink`,
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hostId: host.id, removed: false });
    expect(provider.isLocked(host.id)).toBe(false);
    expect(provider.lockedHosts?.()).toEqual([]);
    expect(update).toHaveBeenCalledWith(
      host.id,
      expect.objectContaining({ pluginEnable: { coolify: false } }),
    );
    expect(
      (await h.mock.ctx.hosts.listOwned()).some((x) => x.id === host.id),
    ).toBe(true);
    const [row] = serverRows(h).filter((r) => r.server_uuid === "srv-web1");
    expect(row.host_id).toBeNull();
    expect(row.credential_id).not.toBeNull();
    expect(byUuid(await preview(h, connectionId), "srv-web1").status).toBe(
      "new",
    );
  });

  it("unlink with removeHost deletes the host", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    const [host] = await h.mock.ctx.hosts.listOwned();
    const res = await h.request(
      "POST",
      `/connections/${connectionId}/servers/srv-web1/unlink`,
      { removeHost: true },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hostId: host.id, removed: true });
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(0);
    expect(lockProvider(h).isLocked(host.id)).toBe(false);
  });

  it("unlinking a server with no Linked host answers 404", async () => {
    const { harness: h, connectionId } = await start();
    const res = await h.request(
      "POST",
      `/connections/${connectionId}/servers/srv-web1/unlink`,
      {},
    );
    expect(res.status).toBe(404);
    expect(res.body.cause).toBe("not-linked");
  });

  it("host.deleted unlinks the row and keeps the override and credential choice", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, [
      { uuid: "srv-local", include: true, addressOverride: "10.0.0.2" },
    ]);
    const [host] = await h.mock.ctx.hosts.listOwned();
    const [before] = serverRows(h);
    expect(before.host_id).toBe(host.id);

    await h.mock.ctx.hosts.delete(host.id);
    h.mock.ctx.events.emit("host.deleted", { hostId: host.id });
    await vi.waitFor(() => {
      expect(serverRows(h)[0].host_id).toBeNull();
    });
    const [after] = serverRows(h);
    expect(after.address_override).toBe("10.0.0.2");
    expect(after.credential_id).toBe(before.credential_id);
    expect(after.credential_mode).toBe("coolify");
    expect(lockProvider(h).isLocked(host.id)).toBe(false);
  });

  it("a Linked host deleted outside the plugin is created again on the next sync", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    const [host] = await h.mock.ctx.hosts.listOwned();
    await h.mock.ctx.hosts.delete(host.id);
    const results = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(results, "srv-web1").status).toBe("created");
    expect(h.mock.createdSshKeys).toHaveLength(1);
  });

  it("removing the connection unlinks its hosts, or deletes them with removeHosts", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1", "srv-web2"));
    const hosts = await h.mock.ctx.hosts.listOwned();
    const update = vi.spyOn(h.mock.ctx.hosts, "update");
    const res = await h.request("DELETE", `/connections/${connectionId}`);
    expect(res.status).toBe(200);
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(2);
    for (const host of hosts) {
      expect(lockProvider(h).isLocked(host.id)).toBe(false);
    }
    expect(serverRows(h)).toHaveLength(0);
  });

  it("removing the connection with removeHosts deletes its Linked hosts", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1", "srv-web2"));
    const res = await h.request(
      "DELETE",
      `/connections/${connectionId}?removeHosts=true`,
    );
    expect(res.status).toBe(200);
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(0);
  });

  it("puts hosts in a folder named after the connection when there are several", async () => {
    const { harness: h } = await start();
    const second = await h.request("POST", "/connections", {
      name: "Staging",
      baseUrl: "https://coolify.example.test",
      token: "fake-token-sync-second",
    });
    const ensure = vi.spyOn(h.mock.ctx.hosts.folders, "ensure");
    await apply(h, second.body.id, only("srv-web1"));
    expect(ensure).toHaveBeenCalledWith("Coolify / Staging", {
      icon: "Rocket",
    });
    const [host] = await h.mock.ctx.hosts.listOwned();
    expect(host.folder).toBe("Coolify / Staging");
  });

  it("turns on the Docker plugin's host switch when Docker runs", async () => {
    const { harness: h, connectionId } = await start({ dockerRunning: true });
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    await apply(h, connectionId, only("srv-web1"));
    expect(create.mock.calls[0][0].pluginEnable).toEqual({
      coolify: true,
      docker: true,
    });
  });

  it("no private key ever reaches plugin tables, logs, audits or responses", async () => {
    const { harness: h, connectionId } = await start();
    const logs: unknown[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(h.mock.ctx.log, level).mockImplementation((...args) => {
        logs.push(args);
      });
    }
    const responses = [
      await preview(h, connectionId),
      await apply(h, connectionId, [
        { uuid: "srv-web1", include: true },
        { uuid: "srv-web2", include: true },
        { uuid: "srv-local", include: true, addressOverride: "10.0.0.2" },
        { uuid: "srv-vps1", include: true },
      ]),
      await preview(h, connectionId),
      (
        await h.request(
          "POST",
          `/connections/${connectionId}/servers/srv-web2/unlink`,
          {},
        )
      ).body,
    ];
    expect(h.mock.createdSshKeys).toHaveLength(2);
    const seen = JSON.stringify([
      dumpTables(h),
      logs,
      responses,
      h.mock.audits,
      await h.mock.ctx.hosts.listOwned(),
    ]);
    for (const marker of [
      PRIVATE_MARKER,
      LOCAL_PRIVATE_MARKER,
      "PRIVATE KEY",
    ]) {
      expect(seen).not.toContain(marker);
    }
  });
});

describe("host sync routes", () => {
  it("refuse sync and unlink without coolify.configure", async () => {
    harness = await startPlugin({
      fetch: syncCoolify().fetch,
      permissions: ["coolify.view"],
    });
    const sync = await harness.request("POST", "/connections/1/sync", {
      choices: [],
    });
    expect(sync.status).toBe(403);
    const unlink = await harness.request(
      "POST",
      "/connections/1/servers/srv-web1/unlink",
      {},
    );
    expect(unlink.status).toBe(403);
  });

  it("refuse the servers list without coolify.view", async () => {
    harness = await startPlugin({
      fetch: syncCoolify().fetch,
      permissions: [],
    });
    const res = await harness.request("GET", "/connections/1/servers");
    expect(res.status).toBe(403);
  });

  it("another user gets 404", async () => {
    const { harness: h, connectionId } = await start();
    for (const [method, path, body] of [
      ["GET", `/connections/${connectionId}/servers`, undefined],
      ["POST", `/connections/${connectionId}/sync`, { choices: [] }],
      ["POST", `/connections/${connectionId}/servers/srv-web1/unlink`, {}],
    ] as const) {
      const res = await h.request(method, path, body, "user-2");
      expect(res.status, path).toBe(404);
    }
  });

  it("refuses a malformed choices body with 400", async () => {
    const { harness: h, connectionId } = await start();
    for (const body of [
      {},
      { choices: "all" },
      { choices: [{ uuid: 5, include: true }] },
      { choices: [{ uuid: "srv-web1", include: true, credentialId: -1 }] },
    ]) {
      const res = await h.request(
        "POST",
        `/connections/${connectionId}/sync`,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("host sync under concurrency", () => {
  it("two overlapping syncs of one connection create one host and one link row", async () => {
    const { harness: h, connectionId } = await start();
    // Each host create waits until a second one arrives (or 150 ms pass), so
    // two syncs that both read "no host yet" would both create one.
    const create = h.mock.ctx.hosts.create.bind(h.mock.ctx.hosts);
    let arrived = 0;
    let release: () => void = () => {};
    const both = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(h.mock.ctx.hosts, "create").mockImplementation(async (input) => {
      arrived += 1;
      if (arrived >= 2) release();
      await Promise.race([both, sleep(150)]);
      return create(input);
    });
    const [first, second] = await Promise.all([
      apply(h, connectionId, only("srv-web1")),
      apply(h, connectionId, only("srv-web1")),
    ]);
    const statuses = [first, second]
      .map((results) => byUuid(results, "srv-web1").status)
      .sort();
    expect(statuses).toEqual(["created", "updated"]);
    const hosts = await h.mock.ctx.hosts.listOwned();
    expect(hosts).toHaveLength(1);
    const rows = serverRows(h).filter((r) => r.server_uuid === "srv-web1");
    expect(rows).toHaveLength(1);
    expect(rows[0].host_id).toBe(hosts[0].id);
    expect(lockProvider(h).lockedHosts()).toEqual([hosts[0].id]);
  });

  it("an unlink that overlaps a sync waits for it and releases the host", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));
    // The re-sync pauses in its host update; the unlink is sent meanwhile.
    const update = h.mock.ctx.hosts.update.bind(h.mock.ctx.hosts);
    let paused: () => void = () => {};
    const inUpdate = new Promise<void>((resolve) => (paused = resolve));
    let unlinkDone: () => void = () => {};
    const unlinked$ = new Promise<void>((resolve) => (unlinkDone = resolve));
    const spy = vi
      .spyOn(h.mock.ctx.hosts, "update")
      .mockImplementationOnce(async (id, input) => {
        paused();
        await Promise.race([unlinked$, sleep(150)]);
        return update(id, input);
      });
    const resync = apply(h, connectionId, only("srv-web1"));
    await inUpdate;
    spy.mockImplementation(update);
    const unlinking = h
      .request("POST", `/connections/${connectionId}/servers/srv-web1/unlink`, {
        removeHost: false,
      })
      .finally(unlinkDone);
    await resync;
    const unlinked = await unlinking;
    expect(unlinked.status).toBe(200);
    expect(lockProvider(h).lockedHosts()).toEqual([]);
    const [row] = serverRows(h).filter((r) => r.server_uuid === "srv-web1");
    expect(row.host_id).toBeNull();
  });

  it("a sync queued behind a connection's removal leaves no host, row or lock", async () => {
    const { harness: h, connectionId } = await start();
    await apply(h, connectionId, only("srv-web1"));

    // The removal pauses while releasing the Linked host, and again before
    // deleting the rows, so a sync sent meanwhile is queued behind it.
    const deleteHost = h.mock.ctx.hosts.delete.bind(h.mock.ctx.hosts);
    let releasing: () => void = () => {};
    const inRelease = new Promise<void>((resolve) => (releasing = resolve));
    vi.spyOn(h.mock.ctx.hosts, "delete").mockImplementation(async (id) => {
      releasing();
      await sleep(20);
      return deleteHost(id);
    });
    const batch = h.mock.ctx.db.batch.bind(h.mock.ctx.db);
    vi.spyOn(h.mock.ctx.db, "batch").mockImplementation(async (queries) => {
      await sleep(100);
      return batch(queries);
    });

    const removal = h.request(
      "DELETE",
      `/connections/${connectionId}?removeHosts=true`,
    );
    await inRelease;
    const sync = h.request("POST", `/connections/${connectionId}/sync`, {
      choices: only("srv-web1", "srv-web2"),
    });
    expect((await removal).status).toBe(200);
    expect((await sync).status).toBe(404);

    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(0);
    expect(serverRows(h)).toHaveLength(0);
    expect(lockProvider(h).lockedHosts()).toEqual([]);
  });

  it("an apply whose connection was removed before its first host write creates nothing", async () => {
    const { harness: h, connectionId } = await start();
    // The connection disappears between the start of the sync and its first
    // host write (here: while Coolify lists the servers).
    const ensure = vi.spyOn(h.mock.ctx.hosts.folders, "ensure");
    const before = h.mock.ctx.fetch;
    vi.spyOn(h.mock.ctx, "fetch").mockImplementation(async (url, init) => {
      const res = await before(url, init);
      if (String(url).endsWith("/servers")) {
        h.db.sqlite
          .prepare("DELETE FROM p_coolify_connections WHERE id = ?")
          .run(connectionId);
      }
      return res;
    });
    const res = await h.request("POST", `/connections/${connectionId}/sync`, {
      choices: only("srv-web1"),
    });
    expect(res.status).toBe(404);
    expect(ensure).not.toHaveBeenCalled();
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(0);
    expect(lockProvider(h).lockedHosts()).toEqual([]);
  });

  it("a link row that can't be saved removes the host it just created", async () => {
    const { harness: h, connectionId } = await start();
    const create = h.mock.ctx.hosts.create.bind(h.mock.ctx.hosts);
    // Another writer takes the (connection, server) row after the host is
    // made, so saving this sync's link row fails on the unique constraint.
    vi.spyOn(h.mock.ctx.hosts, "create").mockImplementation(async (input) => {
      const host = await create(input);
      h.db.sqlite
        .prepare(
          "INSERT INTO p_coolify_servers (connection_id, server_uuid) VALUES (?, ?)",
        )
        .run(connectionId, "srv-web1");
      return host;
    });
    const results = await apply(h, connectionId, only("srv-web1"));
    expect(byUuid(results, "srv-web1")).toMatchObject({
      status: "failed",
      cause: "host-write-failed",
      hostId: null,
    });
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(0);
    expect(lockProvider(h).lockedHosts()).toEqual([]);
  });
});
