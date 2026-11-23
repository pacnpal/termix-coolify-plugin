import { afterEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_PROBE_COMMAND } from "@termix-ssh/plugin-sdk/host-commands";
import type { PluginHarness } from "../helpers/plugin.js";
import { fakePackageManager, fakeSsh, startLinked } from "./fixtures.js";
import { failCacheWrites } from "../helpers/cache.js";

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
  const started = await startLinked(options);
  harness = started.harness;
  const base = `/connections/${started.connectionId}/servers`;
  return { ...started, h: started.harness, web1: `${base}/srv-web1` };
}

describe("server updates", () => {
  it("maps Coolify's patch_check_result into the updates answer", async () => {
    const { h, web1, hostId } = await start();
    const res = await h.request("GET", `${web1}/updates`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      server: { uuid: "srv-web1", name: "web-1" },
      hostId,
      fresh: null,
      via: null,
      coolify: {
        updates: 3,
        security: 1,
        rebootRequired: true,
        checkedAt: "2026-11-18T10:00:00.000000Z",
        error: null,
      },
    });
    expect(res.body.coolify.items).toEqual([
      {
        package: "docker-ce",
        newVersion: "5:27.0.1",
        currentVersion: "5:26.1.0",
        security: false,
        risk: "docker",
      },
      {
        package: "openssl",
        newVersion: "3.0.2-0ubuntu1.18",
        currentVersion: "3.0.2-0ubuntu1.17",
        security: true,
        risk: null,
      },
      {
        package: "linux-image-generic",
        newVersion: "5.15.0.130",
        currentVersion: "5.15.0.125",
        security: false,
        risk: "kernel",
      },
    ]);
  });

  it("uses package-manager operations when installed", async () => {
    const { h, web1, hostId } = await start({ plugins: ["package-manager"] });
    const invoke = fakePackageManager(h);
    const ssh = fakeSsh(h);

    const checked = await h.request("POST", `${web1}/updates/check`, {});
    expect(checked.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      "package-manager.list-updates",
      expect.objectContaining({ hostId }),
    );
    expect(checked.body.via).toBe("package-manager");
    expect(checked.body.fresh).toMatchObject({ updates: 3, security: 1 });

    const installed = await h.request("POST", `${web1}/updates/install`, {
      confirm: true,
    });
    expect(installed.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      "package-manager.upgrade-all",
      expect.objectContaining({ hostId }),
    );
    expect(installed.body).toMatchObject({
      via: "package-manager",
      changed: true,
    });
    expect(ssh.calls).toEqual([]);
  });

  it("answers the check when keeping it in the cache fails", async () => {
    const { h, web1 } = await start();
    fakeSsh(h);
    const refused = failCacheWrites(h.mock.ctx);
    const checked = await h.request("POST", `${web1}/updates/check`, {});
    expect(checked.status).toBe(200);
    expect(checked.body.fresh).toMatchObject({ updates: 5, security: 1 });
    expect(refused()).toBe(1);
  });

  it("falls back to ssh on the Linked host", async () => {
    const { h, web1, hostId } = await start();
    const invoke = vi.spyOn(h.mock.ctx.operations, "invoke");
    const ssh = fakeSsh(h);

    const checked = await h.request("POST", `${web1}/updates/check`, {});
    expect(checked.status).toBe(200);
    expect(checked.body.via).toBe("ssh");
    expect(checked.body.fresh).toMatchObject({
      updates: 5,
      security: 1,
      rebootRequired: true,
    });
    expect(ssh.calls.map((c) => c.host)).toEqual([hostId, hostId]);
    expect(ssh.calls[0].command).toBe(PLATFORM_PROBE_COMMAND);

    // The fresh result is kept and shown next to Coolify's own record.
    const status = await h.request("GET", `${web1}/updates`);
    expect(status.body.via).toBe("ssh");
    expect(status.body.fresh.updates).toBe(5);
    expect(status.body.coolify.updates).toBe(3);

    const installed = await h.request("POST", `${web1}/updates/install`, {
      confirm: true,
    });
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ via: "ssh", changed: true });
    expect(ssh.calls.at(-1)!.command).toContain(
      "DEBIAN_FRONTEND=noninteractive apt-get -y upgrade",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("redacts the upgrade's output on both paths, as logs are", async () => {
    const leaky = [
      "Setting up app (1.0) ...",
      "hook received fake-token-sync-test",
      "DB_PASSWORD=fake-upgrade-pass",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "FAKEUPGRADEKEYBODY",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    for (const plugins of [[], ["package-manager"]]) {
      const { h, web1 } = await start({ plugins });
      const invoke = fakePackageManager(h);
      const realInvoke = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (actionId, options) =>
        actionId === "package-manager.upgrade-all"
          ? {
              runId: "run-upgrade",
              status: "success",
              summary: "Upgraded all packages",
              changed: true,
              data: { output: leaky },
            }
          : realInvoke(actionId, options),
      );
      const ssh = fakeSsh(h);
      const realExec = ssh.exec.getMockImplementation()!;
      ssh.exec.mockImplementation(async (host, command, execOptions) =>
        command.includes("apt-get -y upgrade")
          ? {
              stdout: leaky,
              stderr: "",
              code: 0,
              truncated: false,
              timedOut: false,
            }
          : realExec(host, command, execOptions),
      );
      const installed = await h.request("POST", `${web1}/updates/install`, {
        confirm: true,
      });
      expect(installed.status).toBe(200);
      const output = (installed.body as { output: string }).output;
      expect(output).toContain("Setting up app (1.0) ...");
      for (const leak of [
        "fake-token-sync-test",
        "fake-upgrade-pass",
        "FAKEUPGRADEKEYBODY",
      ]) {
        expect(output, `${plugins.join()} ${leak}`).not.toContain(leak);
      }
      await harness?.close();
      harness = null;
    }
  });

  it("ssh fallback runs fixed commands only", async () => {
    const { h, web1 } = await start({ permissions: ALL });
    const ssh = fakeSsh(h);
    await h.request("POST", `${web1}/updates/check`, {});
    await h.request("POST", `${web1}/updates/install`, { confirm: true });
    await h.request("POST", `${web1}/reboot`, { confirmName: "web-1" });
    const again = fakeSsh(h);
    await h.request("POST", `${web1}/updates/check`, {});
    await h.request("POST", `${web1}/updates/install`, { confirm: true });
    await h.request("POST", `${web1}/reboot`, { confirmName: "web-1" });
    expect(ssh.calls.length).toBeGreaterThanOrEqual(5);
    expect(again.calls.map((c) => c.command)).toEqual(
      ssh.calls.map((c) => c.command),
    );
    for (const { command } of ssh.calls) {
      expect(command).not.toContain("web-1");
      expect(command).not.toContain("srv-web1");
      expect(command).not.toContain("203.0.113.11");
    }
  });

  it("asks for passwordless sudo when the login is not root and sudo needs a password", async () => {
    const { h, web1 } = await start();
    fakeSsh(h, { sudoRefused: true });
    const res = await h.request("POST", `${web1}/updates/install`, {
      confirm: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("needs-sudo");
  });

  it("install without confirm 400", async () => {
    const { h, web1 } = await start({ plugins: ["package-manager"] });
    const invoke = fakePackageManager(h);
    const ssh = fakeSsh(h);
    for (const body of [{}, { confirm: false }, { confirm: "true" }]) {
      const res = await h.request("POST", `${web1}/updates/install`, body);
      expect(res.status).toBe(400);
      expect(res.body.cause).toBe("confirm-required");
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(ssh.calls).toEqual([]);
  });

  it("reboot needs exact name", async () => {
    const { h, web1, hostId } = await start({ permissions: ALL });
    const ssh = fakeSsh(h);
    for (const confirmName of ["web-2", "WEB-1", " web-1", "", undefined]) {
      const res = await h.request("POST", `${web1}/reboot`, { confirmName });
      expect(res.status).toBe(400);
      expect(res.body.cause).toBe("name-mismatch");
    }
    expect(ssh.calls).toEqual([]);

    const res = await h.request("POST", `${web1}/reboot`, {
      confirmName: "web-1",
    });
    expect(res.status).toBe(200);
    expect(res.body.via).toBe("ssh");
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0].host).toBe(hostId);
    expect(ssh.calls[0].command).toContain("systemctl reboot");
  });

  it("reboot without coolify.administer 403", async () => {
    const { h, web1 } = await start({
      permissions: ["coolify.view", "coolify.operate", "coolify.configure"],
    });
    const ssh = fakeSsh(h);
    const res = await h.request("POST", `${web1}/reboot`, {
      confirmName: "web-1",
    });
    expect(res.status).toBe(403);
    expect(ssh.calls).toEqual([]);
  });

  it("check and install need coolify.operate", async () => {
    const { h, web1 } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const ssh = fakeSsh(h);
    expect((await h.request("POST", `${web1}/updates/check`, {})).status).toBe(
      403,
    );
    expect(
      (
        await h.request("POST", `${web1}/updates/install`, {
          confirm: true,
        })
      ).status,
    ).toBe(403);
    expect((await h.request("GET", `${web1}/updates`)).status).toBe(200);
    expect(ssh.calls).toEqual([]);
  });

  it("docker-risk updates flagged", async () => {
    const { h, web1 } = await start();
    fakeSsh(h);
    const ssh = await h.request("POST", `${web1}/updates/check`, {});
    const risk = Object.fromEntries(
      ssh.body.fresh.items.map((i: any) => [i.package, i.risk]),
    );
    expect(risk).toEqual({
      "docker-ce": "docker",
      "containerd.io": "docker",
      openssl: null,
      "linux-image-generic": "kernel",
      curl: null,
    });
    const security = ssh.body.fresh.items
      .filter((i: any) => i.security)
      .map((i: any) => i.package);
    expect(security).toEqual(["openssl"]);
  });

  it("docker-risk updates flagged on the Package Manager path too", async () => {
    const { h, web1 } = await start({ plugins: ["package-manager"] });
    fakePackageManager(h);
    const res = await h.request("POST", `${web1}/updates/check`, {});
    expect(
      res.body.fresh.items.find((i: any) => i.package === "docker-ce").risk,
    ).toBe("docker");
    expect(
      res.body.fresh.items.find((i: any) => i.package === "openssl").security,
    ).toBe(true);
  });

  it("a server with no Linked host answers 409 not-linked", async () => {
    const { h, connectionId } = await start({ permissions: ALL });
    const ssh = fakeSsh(h);
    const web2 = `/connections/${connectionId}/servers/srv-web2`;
    for (const [path, body] of [
      [`${web2}/updates/check`, {}],
      [`${web2}/updates/install`, { confirm: true }],
      [`${web2}/reboot`, { confirmName: "web-2" }],
    ] as const) {
      const res = await h.request("POST", path, body);
      expect(res.status, path).toBe(409);
      expect(res.body.cause, path).toBe("not-linked");
    }
    // Coolify's own record still reads without a Linked host.
    const status = await h.request("GET", `${web2}/updates`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ hostId: null, via: null });
    expect(ssh.calls).toEqual([]);
  });

  it("refuses when the actor can't open the Linked host, and fails closed", async () => {
    const { h, web1, access } = await start();
    const ssh = fakeSsh(h);

    access.mockResolvedValue({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    let res = await h.request("POST", `${web1}/updates/check`, {});
    expect(res.status).toBe(403);
    expect(res.body.cause).toBe("host-forbidden");

    // Connect is enough to check, but installing needs edit.
    access.mockResolvedValue({
      hasAccess: true,
      isOwner: false,
      isShared: true,
      permissionLevel: "connect",
    });
    res = await h.request("POST", `${web1}/updates/check`, {});
    expect(res.status).toBe(200);
    const before = ssh.calls.length;
    res = await h.request("POST", `${web1}/updates/install`, { confirm: true });
    expect(res.status).toBe(403);
    expect(res.body.cause).toBe("host-forbidden");

    // Access that can't be read refuses.
    access.mockRejectedValue(new Error("core unavailable"));
    res = await h.request("POST", `${web1}/updates/check`, {});
    expect(res.status).toBe(403);
    expect(res.body.cause).toBe("host-forbidden");
    expect(ssh.calls.length).toBe(before);
  });

  it("another user's connection is 404", async () => {
    const { h, web1 } = await start();
    const ssh = fakeSsh(h);
    for (const [method, path, body] of [
      ["GET", `${web1}/updates`, undefined],
      ["POST", `${web1}/updates/check`, {}],
      ["POST", `${web1}/updates/install`, { confirm: true }],
      ["POST", `${web1}/reboot`, { confirmName: "web-1" }],
    ] as const) {
      const res = await h.request(method, path, body, "user-2");
      expect(res.status, path).toBe(404);
    }
    expect(ssh.calls).toEqual([]);
  });
});
