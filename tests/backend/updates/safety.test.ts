import { afterEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_PROBE_COMMAND } from "@termix-ssh/plugin-sdk/host-commands";
import type { PluginHarness } from "../helpers/plugin.js";
import {
  WEB1_PATCHED,
  fakePackageManager,
  fakeSsh,
  startLinked,
} from "./fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const ALL = [
  "coolify.view",
  "coolify.operate",
  "coolify.configure",
  "coolify.administer",
];

async function start(options: Parameters<typeof startLinked>[0] = {}) {
  const started = await startLinked({ permissions: ALL, ...options });
  harness = started.harness;
  const base = `/connections/${started.connectionId}/servers`;
  return { ...started, h: started.harness, web1: `${base}/srv-web1` };
}

/** The owner points the connection at another token. */
function retarget(h: PluginHarness) {
  h.db.sqlite
    .prepare("UPDATE p_coolify_connections SET token_sealed = ?")
    .run("sealed:another-instance");
}

const WRITES = [
  ["updates/check", {}],
  ["updates/install", { confirm: true }],
  ["reboot", { confirmName: "web-1" }],
] as const;

const ran = (calls: { command: string }[]) =>
  calls.filter((c) => c.command !== PLATFORM_PROBE_COMMAND);

describe("server updates fail closed", () => {
  it("a target change before any SSH runs nothing", async () => {
    for (const [path, body] of WRITES) {
      const { h, web1, access } = await start();
      const ssh = fakeSsh(h);
      const allow = access.getMockImplementation()!;
      access.mockImplementation(async (...args) => {
        retarget(h);
        return allow(...args);
      });
      const res = await h.request("POST", `${web1}/${path}`, body);
      expect(res.status, path).toBe(409);
      expect(res.body.cause, path).toBe("target-changed");
      expect(ssh.calls, path).toEqual([]);
      await h.close();
      harness = null;
    }
  });

  it("a target change after the platform probe never runs the upgrade", async () => {
    const { h, web1 } = await start();
    const ssh = fakeSsh(h);
    const real = ssh.exec.getMockImplementation()!;
    ssh.exec.mockImplementation(async (...args) => {
      if (args[1] === PLATFORM_PROBE_COMMAND) retarget(h);
      return real(...args);
    });
    const res = await h.request("POST", `${web1}/updates/install`, {
      confirm: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(ran(ssh.calls)).toEqual([]);
  });

  it("a target change on the Package Manager path never invokes the upgrade", async () => {
    const { h, web1 } = await start({ plugins: ["package-manager"] });
    const invoke = fakePackageManager(h);
    // The fixture's own answer: this plugin and package-manager.
    const list = vi.mocked(h.mock.ctx.plugins.list).getMockImplementation()!;
    vi.mocked(h.mock.ctx.plugins.list).mockImplementation(async () => {
      const running = await list();
      retarget(h);
      return running;
    });
    const res = await h.request("POST", `${web1}/updates/install`, {
      confirm: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a target change while the server name is read never reboots", async () => {
    const { h, web1, fake } = await start();
    const ssh = fakeSsh(h);
    // Sync is done, so from here every read of web-1 is the reboot's own.
    fake.set("GET /servers/srv-web1", () => {
      retarget(h);
      return new Response(JSON.stringify(WEB1_PATCHED), {
        headers: { "content-type": "application/json" },
      });
    });
    const res = await h.request("POST", `${web1}/reboot`, {
      confirmName: "web-1",
    });
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(ssh.calls).toEqual([]);
  });

  it("a server the connection's Coolify doesn't have is 404 and nothing runs", async () => {
    const { h, web1, fake } = await start({ plugins: ["package-manager"] });
    const ssh = fakeSsh(h);
    const invoke = fakePackageManager(h);
    // The link row is still there, but Coolify no longer has the server.
    fake.set("GET /servers/srv-web1", { status: 404, json: { message: "x" } });
    for (const [path, body] of WRITES) {
      const res = await h.request("POST", `${web1}/${path}`, body);
      expect(res.status, path).toBe(404);
    }
    expect(ssh.calls).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a kept check from before a target change is not served", async () => {
    const { h, web1 } = await start();
    fakeSsh(h);
    const checked = await h.request("POST", `${web1}/updates/check`, {});
    expect(checked.status).toBe(200);
    expect((await h.request("GET", `${web1}/updates`)).body.via).toBe("ssh");
    retarget(h);
    const status = await h.request("GET", `${web1}/updates`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ fresh: null, via: null });
  });

  it("install and reboot drop the resource and server caches", async () => {
    for (const [path, body] of WRITES.slice(1)) {
      const { h, web1, connectionId } = await start();
      fakeSsh(h);
      const insert = h.db.sqlite.prepare(
        "INSERT INTO p_coolify_cache (connection_id, kind, json, fetched_at) VALUES (?, ?, ?, ?)",
      );
      for (const kind of ["resources", "servers"]) {
        insert.run(connectionId, kind, "{}", new Date().toISOString());
      }
      const res = await h.request("POST", `${web1}/${path}`, body);
      expect(res.status, path).toBe(200);
      const kinds = h.db.sqlite
        .prepare("SELECT kind FROM p_coolify_cache WHERE connection_id = ?")
        .all(connectionId) as { kind: string }[];
      expect(
        kinds.map((k) => k.kind),
        path,
      ).toEqual([]);
      await h.close();
      harness = null;
    }
  });

  it("a host key Termix hasn't trusted answers host-key with a fixed message", async () => {
    const { h, web1 } = await start();
    const err = Object.assign(
      new Error("HOST_KEY_UNVERIFIED: core text with details-from-core"),
      { code: "HOST_KEY_UNVERIFIED" },
    );
    vi.spyOn(h.mock.ctx.ssh, "exec").mockRejectedValue(err);
    const res = await h.request("POST", `${web1}/updates/check`, {});
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("host-key");
    expect(JSON.stringify(res.body)).not.toContain("details-from-core");
  });

  it("a server status fetch still running when install ends is not cached", async () => {
    const { h, web1, fake, hostId } = await start();
    fakeSsh(h);
    const listed = () =>
      fake.calls.filter((c) => c.method === "GET" && c.path === "/servers")
        .length;
    const answer = () =>
      new Response(JSON.stringify([WEB1_PATCHED]), {
        headers: { "content-type": "application/json" },
      });
    let reached = () => {};
    let release = () => {};
    const atFetch = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    // A slow Coolify: this /servers answer waits until released.
    fake.set("GET /servers", (async () => {
      reached();
      await released;
      return answer();
    }) as unknown as () => Response);
    const signal = () =>
      h.mock.ctx.operations.run("coolify.signal-updates", { hostId });

    const before = signal();
    await atFetch;
    const installed = await h.request("POST", `${web1}/updates/install`, {
      confirm: true,
    });
    expect(installed.status).toBe(200);
    fake.set("GET /servers", answer);
    release();
    await before;

    const calls = listed();
    await signal();
    expect(listed()).toBe(calls + 1);
  });

  it("a plugin list that can't be read refuses instead of falling back to SSH", async () => {
    const { h, web1 } = await start({ plugins: ["package-manager"] });
    const invoke = fakePackageManager(h);
    const ssh = fakeSsh(h);
    vi.mocked(h.mock.ctx.plugins.list).mockRejectedValue(new Error("down"));
    for (const [path, body] of WRITES.slice(0, 2)) {
      const res = await h.request("POST", `${web1}/${path}`, body);
      expect(res.status, path).toBe(409);
      expect(res.body.cause, path).toBe("companions-unknown");
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(ssh.calls).toEqual([]);
  });

  it("a check whose listing failed is an error, never up to date", async () => {
    const { h, web1 } = await start();
    const ssh = fakeSsh(h);
    const real = ssh.exec.getMockImplementation()!;
    ssh.exec.mockImplementation(async (...args) => {
      if (args[1].includes("apt list --upgradable")) {
        // apt list failed: nothing listed and no successful status for it.
        return {
          stdout: "__COOLIFY_LIST__\n__COOLIFY_REBOOT__\nREBOOT=no\n",
          stderr: "E: Could not open lock file",
          code: 0,
          truncated: false,
          timedOut: false,
        };
      }
      return real(...args);
    });
    const res = await h.request("POST", `${web1}/updates/check`, {});
    expect(res.status).toBe(502);
    expect(res.body.cause).toBe("check-failed");
    const status = await h.request("GET", `${web1}/updates`);
    expect(status.body).toMatchObject({ fresh: null, via: null });
  });

  it("a check still running when install ends is not kept", async () => {
    const { h, web1 } = await start();
    const ssh = fakeSsh(h);
    const real = ssh.exec.getMockImplementation()!;
    let reached = () => {};
    let release = () => {};
    const atCheck = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    ssh.exec.mockImplementation(async (...args) => {
      if (!held && args[1].includes("apt list --upgradable")) {
        held = true;
        reached();
        await released;
      }
      return real(...args);
    });
    const checking = h.request("POST", `${web1}/updates/check`, {});
    await atCheck;
    const installed = await h.request("POST", `${web1}/updates/install`, {
      confirm: true,
    });
    expect(installed.status).toBe(200);
    release();
    await checking;
    const status = await h.request("GET", `${web1}/updates`);
    expect(status.body).toMatchObject({ fresh: null, via: null });
  });
});
