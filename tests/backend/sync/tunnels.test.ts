import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHostCreateInput } from "@termix-ssh/plugin-sdk/backend";
import type { PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { startWithConnection } from "./fixtures.js";

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
