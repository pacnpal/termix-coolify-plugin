import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHostCreateInput } from "@termix-ssh/plugin-sdk/backend";
import type { PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { server, startWithConnection, syncCoolify } from "./fixtures.js";

// Obviously fake Cloudflare Access service token. Tests scan for both values.
const FAKE_ACCESS = {
  id: "fake-access-client-id-tunnel-test.access",
  secret: "fake-access-client-secret-tunnel-test",
};

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

const BOTH = [
  { uuid: "srv-web1", include: true },
  { uuid: "srv-vps1", include: true },
];

async function preview(h: PluginHarness, id: number) {
  const res = await h.request("GET", `/connections/${id}/servers`);
  expect(res.status).toBe(200);
  return res.body as any[];
}

async function apply(h: PluginHarness, id: number, choices = BOTH) {
  const res = await h.request("POST", `/connections/${id}/sync`, { choices });
  expect(res.status).toBe(200);
  return res.body as any[];
}

function byUuid(rows: any[], uuid: string) {
  const found = rows.find((r) => (r.server?.uuid ?? r.uuid) === uuid);
  if (!found) throw new Error(`no row for ${uuid}`);
  return found;
}

function sshTerminalOf(input: PluginHostCreateInput) {
  return (input.pluginSettings as Record<string, any> | undefined)?.[
    "ssh-terminal"
  ];
}

describe("tunnelled servers through SSH Terminal", () => {
  it("without ssh-terminal the row is needs-ssh-terminal", async () => {
    const { harness: h, connectionId } = await start();
    expect(byUuid(await preview(h, connectionId), "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "needs-ssh-terminal",
      tunnel: true,
    });
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const results = await apply(h, connectionId);
    expect(byUuid(results, "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "needs-ssh-terminal",
      hostId: null,
    });
    expect(byUuid(results, "srv-web1").status).toBe("created");
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls)).not.toContain("ssh-terminal");

    // Installed but turned off is the same as missing.
    vi.spyOn(h.mock.ctx.plugins, "list").mockResolvedValue([
      {
        id: "ssh-terminal",
        version: "1.4.1",
        source: "bundled",
        state: "disabled",
      },
    ]);
    expect(byUuid(await preview(h, connectionId), "srv-vps1").cause).toBe(
      "needs-ssh-terminal",
    );
  });

  it("ssh-terminal 1.0.3 is ssh-terminal-too-old, 1.2.0 passes", async () => {
    const { harness: h, connectionId } = await start({ sshTerminal: "1.0.3" });
    expect(byUuid(await preview(h, connectionId), "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "ssh-terminal-too-old",
    });
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    expect(byUuid(await apply(h, connectionId), "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "ssh-terminal-too-old",
    });
    expect(create).toHaveBeenCalledTimes(1);

    vi.spyOn(h.mock.ctx.plugins, "list").mockResolvedValue([
      { id: "coolify", version: "1.0.0", source: "user", state: "active" },
      {
        id: "ssh-terminal",
        version: "1.2.0",
        source: "bundled",
        state: "active",
      },
    ]);
    expect(byUuid(await preview(h, connectionId), "srv-vps1")).toMatchObject({
      status: "new",
      tunnel: true,
    });
    const results = await apply(h, connectionId, [
      { uuid: "srv-vps1", include: true },
    ]);
    expect(byUuid(results, "srv-vps1").status).toBe("created");
    const input = create.mock.calls.at(-1)![0];
    expect(input.ip).toBe("ssh-vps1.example.test");
    expect(sshTerminalOf(input)).toEqual({
      cloudflareTunnelEnabled: true,
      cloudflareTunnelHostname: "ssh-vps1.example.test",
      cloudflareTunnelPort: 443,
      cloudflareTunnelClientId: "",
      cloudflareTunnelClientSecret: "",
    });
    expect(byUuid(await preview(h, connectionId), "srv-vps1").status).toBe(
      "linked",
    );
  });

  it("plugin list failure blocks tunnelled rows", async () => {
    const { harness: h, connectionId } = await start({ sshTerminal: "1.4.1" });
    vi.spyOn(h.mock.ctx.plugins, "list").mockRejectedValue(
      new Error("plugins:read refused"),
    );
    expect(byUuid(await preview(h, connectionId), "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "needs-ssh-terminal",
    });
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const results = await apply(h, connectionId);
    expect(byUuid(results, "srv-vps1")).toMatchObject({
      status: "blocked",
      cause: "needs-ssh-terminal",
    });
    // Plain servers don't need SSH Terminal and still sync.
    expect(byUuid(results, "srv-web1").status).toBe("created");
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls)).not.toContain("ssh-terminal");
  });

  it("Access secret never appears in preview, routes or operation output", async () => {
    const { harness: h, connectionId } = await start({
      sshTerminal: "1.2.0",
      cfAccess: FAKE_ACCESS,
    });
    const logs: unknown[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(h.mock.ctx.log, level).mockImplementation((...args) => {
        logs.push(args);
      });
    }
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const update = vi.spyOn(h.mock.ctx.hosts, "update");
    const runs = withRunHistory(h.mock);
    const id = String(connectionId);

    const responses = [
      await h.request("GET", "/connections"),
      await h.request("GET", `/connections/${id}`),
      await h.request("POST", `/connections/${id}/probe`),
      await h.request("GET", `/connections/${id}/servers`),
      await h.request("POST", `/connections/${id}/sync`, { choices: BOTH }),
      await h.request("GET", `/connections/${id}/servers`),
    ];
    const outcomes = [
      await runs.run("coolify.sync-preview", { connectionId: id }),
      await runs.run("coolify.sync-apply", { connectionId: id }),
    ];

    // The token reaches the host's SSH Terminal settings, and only there.
    expect(create).toHaveBeenCalled();
    const vps = create.mock.calls
      .map(([input]) => input)
      .find((input) => input.ip === "ssh-vps1.example.test");
    expect(sshTerminalOf(vps!)).toEqual({
      cloudflareTunnelEnabled: true,
      cloudflareTunnelHostname: "ssh-vps1.example.test",
      cloudflareTunnelPort: 443,
      cloudflareTunnelClientId: FAKE_ACCESS.id,
      cloudflareTunnelClientSecret: FAKE_ACCESS.secret,
    });
    expect(update).toHaveBeenCalled();
    // Plain hosts never get it.
    const web = create.mock.calls
      .map(([input]) => input)
      .find((input) => input.ip === "203.0.113.11");
    expect(JSON.stringify(web)).not.toContain(FAKE_ACCESS.secret);

    const seen = JSON.stringify([
      responses.map((r) => r.body),
      outcomes,
      runs.history,
      logs,
      h.mock.audits,
      await h.mock.ctx.hosts.listOwned(),
    ]);
    expect(seen).not.toContain(FAKE_ACCESS.secret);
    expect(seen).not.toContain(FAKE_ACCESS.id);
  });
});

// A second fake Access token, the one a mid-sync change stores.
const NEW_ACCESS = {
  id: "fake-access-client-id-new-target.access",
  secret: "fake-access-client-secret-new-target",
};
const NEW_BASE = "https://coolify-new.example.test";

/** A promise the test settles by hand, to hold a call in flight. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * The sync fake, answering the new address like the old one, with a gate
 * that holds the next server list read until the test opens it.
 */
function gatedCoolify() {
  const fake = syncCoolify();
  let gate: { reached: () => void; open: Promise<void> } | null = null;
  const fetch: typeof fake.fetch = async (url, init) => {
    const same = url.replace(NEW_BASE, "https://coolify.example.test");
    if (gate && /\/api\/v1\/servers(\?|$)/.test(same)) {
      const held = gate;
      gate = null;
      held.reached();
      await held.open;
    }
    return fake.fetch(same, init);
  };
  return {
    fake: { ...fake, fetch },
    /** Holds the next server list read; resolves once it is held. */
    holdServers() {
      const reached = deferred();
      const open = deferred();
      gate = { reached: () => reached.resolve(), open: open.promise };
      return { reached: reached.promise, open: () => open.resolve() };
    },
  };
}

describe("a sync works on one snapshot of the connection's target", () => {
  it("a target changed while the sync reads servers ends it with target-changed and writes nothing", async () => {
    const gated = gatedCoolify();
    const { harness: h, connectionId } = await start({
      fake: gated.fake,
      sshTerminal: "1.2.0",
      cfAccess: FAKE_ACCESS,
    });
    const create = vi.spyOn(h.mock.ctx.hosts, "create");
    const update = vi.spyOn(h.mock.ctx.hosts, "update");
    const id = String(connectionId);

    const held = gated.holdServers();
    const syncing = h.request("POST", `/connections/${id}/sync`, {
      choices: BOTH,
    });
    await held.reached;
    // Connection updates take their own lock, not the sync queue.
    const changed = await h.request("PATCH", `/connections/${id}`, {
      baseUrl: NEW_BASE,
      cfAccessId: NEW_ACCESS.id,
      cfAccessSecret: NEW_ACCESS.secret,
    });
    expect(changed.status).toBe(200);
    held.open();

    const res = await syncing;
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const hosts = JSON.stringify(await h.mock.ctx.hosts.listOwned());
    expect(hosts).not.toContain(NEW_ACCESS.secret);
    expect(hosts).not.toContain(NEW_ACCESS.id);
    expect(JSON.stringify(res.body)).not.toContain(NEW_ACCESS.secret);
  });

  it("a tunnelled host gets the snapshot's token, even if the token changes mid-sync", async () => {
    const { harness: h, connectionId } = await start({
      sshTerminal: "1.2.0",
      cfAccess: FAKE_ACCESS,
    });
    const id = String(connectionId);
    const hosts = h.mock.ctx.hosts;
    const original = hosts.create.bind(hosts);
    const firstWrite = deferred();
    const resume = deferred();
    let writes = 0;
    const create = vi
      .spyOn(hosts, "create")
      .mockImplementation(async (input) => {
        if (++writes === 1) {
          firstWrite.resolve();
          await resume.promise;
        }
        return original(input);
      });

    const syncing = h.request("POST", `/connections/${id}/sync`, {
      choices: BOTH,
    });
    // The first host write is under way, so the target check has passed.
    await firstWrite.promise;
    const changed = await h.request("PATCH", `/connections/${id}`, {
      cfAccessId: NEW_ACCESS.id,
      cfAccessSecret: NEW_ACCESS.secret,
    });
    expect(changed.status).toBe(200);
    resume.resolve();

    const res = await syncing;
    expect(res.status).toBe(200);
    expect(byUuid(res.body, "srv-vps1").status).toBe("created");
    const vps = create.mock.calls
      .map(([input]) => input)
      .find((input) => input.ip === "ssh-vps1.example.test");
    expect(sshTerminalOf(vps!)).toMatchObject({
      cloudflareTunnelClientId: FAKE_ACCESS.id,
      cloudflareTunnelClientSecret: FAKE_ACCESS.secret,
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain(NEW_ACCESS.secret);
  });
});

describe("a re-sync turns off tunnel settings that no longer apply", () => {
  const VPS_ONLY = [{ uuid: "srv-vps1", include: true }];

  /** Syncs the tunnelled server once, with the Access token, and returns its host id. */
  async function syncTunnelled() {
    const started = await start({
      sshTerminal: "1.2.0",
      cfAccess: FAKE_ACCESS,
    });
    const first = await apply(started.harness, started.connectionId, VPS_ONLY);
    const hostId = byUuid(first, "srv-vps1").hostId as number;
    expect(hostId).toBeGreaterThan(0);
    return { ...started, hostId };
  }

  function lastUpdate(
    update: { mock: { calls: unknown[][] } },
    hostId: number,
  ) {
    const call = update.mock.calls.filter(([id]) => id === hostId).at(-1);
    if (!call) throw new Error(`no update of host ${hostId}`);
    return call[1] as PluginHostCreateInput;
  }

  it("a removed Access token is written as empty on the tunnelled host", async () => {
    const { harness: h, connectionId, hostId } = await syncTunnelled();
    const cleared = await h.request("PATCH", `/connections/${connectionId}`, {
      cfAccessId: null,
      cfAccessSecret: null,
    });
    expect(cleared.status).toBe(200);
    const update = vi.spyOn(h.mock.ctx.hosts, "update");

    const results = await apply(h, connectionId, VPS_ONLY);
    expect(byUuid(results, "srv-vps1").status).toBe("updated");
    expect(sshTerminalOf(lastUpdate(update, hostId))).toEqual({
      cloudflareTunnelEnabled: true,
      cloudflareTunnelHostname: "ssh-vps1.example.test",
      cloudflareTunnelPort: 443,
      cloudflareTunnelClientId: "",
      cloudflareTunnelClientSecret: "",
    });
  });

  it("a server that is no longer tunnelled has its tunnel turned off and cleared", async () => {
    const { harness: h, fake, connectionId, hostId } = await syncTunnelled();
    fake.set("GET /servers", {
      json: [server("srv-vps1", "vps1", "203.0.113.40")],
    });
    const update = vi.spyOn(h.mock.ctx.hosts, "update");

    const results = await apply(h, connectionId, VPS_ONLY);
    expect(byUuid(results, "srv-vps1").status).toBe("updated");
    const input = lastUpdate(update, hostId);
    expect(input.ip).toBe("203.0.113.40");
    expect(sshTerminalOf(input)).toEqual({
      cloudflareTunnelEnabled: false,
      cloudflareTunnelHostname: "",
      cloudflareTunnelClientId: "",
      cloudflareTunnelClientSecret: "",
    });
    // Only the tunnel keys and the plugin's own link settings are written.
    expect(Object.keys(input.pluginSettings ?? {}).sort()).toEqual([
      "coolify",
      "ssh-terminal",
    ]);
    expect(input.pluginSettings?.coolify).toEqual({
      coolifyConnectionId: String(connectionId),
      coolifyServerUuid: "srv-vps1",
    });
    expect(input.pluginEnable).toEqual({ coolify: true });
    expect(JSON.stringify(input)).not.toContain(FAKE_ACCESS.secret);
  });
});
