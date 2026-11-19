import { describe, expect, it } from "vitest";
import { toServer } from "../../../src/backend/coolify/dto.js";
import {
  cleanAddress,
  folderName,
  planHost,
  SSH_TERMINAL_KEYS,
  type PlanContext,
} from "../../../src/backend/sync/mapping.js";

const plain = toServer({
  uuid: "srv-web-uuid",
  name: "web-1",
  ip: "203.0.113.10",
  port: 2222,
  user: "deploy",
  private_key_id: 3,
  settings: { is_reachable: true, is_usable: true },
});

const coolifyHost = toServer({
  uuid: "srv-localhost-uuid",
  name: "localhost",
  ip: "host.docker.internal",
  port: 22,
  user: "root",
  private_key_id: 1,
  is_coolify_host: true,
});

const tunnelled = toServer({
  uuid: "srv-vps1-uuid",
  name: "vps1",
  ip: "ssh-vps1.example.test",
  port: 22,
  user: "root",
  private_key_id: 3,
  settings: { is_cloudflare_tunnel: true },
});

const base: PlanContext = {
  connectionId: 4,
  connectionName: "Prod",
  baseUrl: "https://coolify.example.test",
  override: null,
  credentialId: 9,
  folder: "Coolify",
  dockerRunning: false,
  sshTerminal: { running: true, version: "1.2.0" },
  cfAccess: null,
};

// Obviously fake Access service token values.
const FAKE_ACCESS = {
  id: "fake-access-id.access",
  secret: "fake-access-secret-mapping-test",
};

describe("planHost", () => {
  it("plain server uses ip, port and user", () => {
    const plan = planHost(plain, base);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.input).toMatchObject({
      name: "web-1",
      ip: "203.0.113.10",
      port: 2222,
      username: "deploy",
      authType: "credential",
      credentialId: 9,
      overrideCredentialUsername: true,
      folder: "Coolify",
      statusCheckEnabled: true,
    });
  });

  it("tags and our host settings are set", () => {
    const plan = planHost(plain, base);
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.input.tags).toEqual(["coolify"]);
    expect(plan.input.pluginSettings).toEqual({
      coolify: {
        coolifyConnectionId: "4",
        coolifyServerUuid: "srv-web-uuid",
      },
      "ssh-terminal": {
        cloudflareTunnelEnabled: false,
        cloudflareTunnelHostname: "",
        cloudflareTunnelClientId: "",
        cloudflareTunnelClientSecret: "",
      },
    });
    expect(plan.input.pluginEnable).toEqual({ coolify: true });
    expect(plan.input.notes).toContain(
      "https://coolify.example.test/server/srv-web-uuid",
    );
  });

  it("docker plugin running sets pluginEnable.docker", () => {
    const plan = planHost(plain, { ...base, dockerRunning: true });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.input.pluginEnable).toEqual({ coolify: true, docker: true });
  });

  it("coolify host without override is refused with needs-address", () => {
    expect(planHost(coolifyHost, base)).toEqual({
      ok: false,
      cause: "needs-address",
    });
    const loopback = toServer({ uuid: "l", name: "l", ip: "127.0.0.5" });
    expect(planHost(loopback, base)).toEqual({
      ok: false,
      cause: "needs-address",
    });
  });

  it("coolify host with override uses it", () => {
    const plan = planHost(coolifyHost, { ...base, override: "10.0.0.2" });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.input.ip).toBe("10.0.0.2");
    expect(plan.input.port).toBe(22);
  });

  it("an override applies to any server", () => {
    const plan = planHost(plain, { ...base, override: "web-1.lan" });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.input.ip).toBe("web-1.lan");
  });

  it("tunnelled server writes ssh-terminal settings and tunnel host as address", () => {
    const plan = planHost(tunnelled, base);
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.cause}`);
    expect(plan.input.ip).toBe("ssh-vps1.example.test");
    expect(plan.input.port).toBe(22);
    expect(plan.input.username).toBe("root");
    expect(plan.input.pluginSettings).toEqual({
      coolify: {
        coolifyConnectionId: "4",
        coolifyServerUuid: "srv-vps1-uuid",
      },
      "ssh-terminal": {
        cloudflareTunnelEnabled: true,
        cloudflareTunnelHostname: "ssh-vps1.example.test",
        cloudflareTunnelPort: 443,
        cloudflareTunnelClientId: "",
        cloudflareTunnelClientSecret: "",
      },
    });
  });

  it("tunnel with Access token writes the token settings", () => {
    const plan = planHost(tunnelled, { ...base, cfAccess: FAKE_ACCESS });
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.cause}`);
    expect(plan.input.pluginSettings?.["ssh-terminal"]).toEqual({
      cloudflareTunnelEnabled: true,
      cloudflareTunnelHostname: "ssh-vps1.example.test",
      cloudflareTunnelPort: 443,
      cloudflareTunnelClientId: FAKE_ACCESS.id,
      cloudflareTunnelClientSecret: FAKE_ACCESS.secret,
    });
  });

  it("a plain server gets SSH Terminal's tunnel turned off, never the Access token", () => {
    const plan = planHost(plain, { ...base, cfAccess: FAKE_ACCESS });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.input.pluginSettings?.["ssh-terminal"]).toEqual({
      cloudflareTunnelEnabled: false,
      cloudflareTunnelHostname: "",
      cloudflareTunnelClientId: "",
      cloudflareTunnelClientSecret: "",
    });
    expect(JSON.stringify(plan)).not.toContain(FAKE_ACCESS.secret);
    expect(JSON.stringify(plan)).not.toContain(FAKE_ACCESS.id);

    // Without SSH Terminal running there is nothing of its to write.
    const without = planHost(plain, {
      ...base,
      sshTerminal: { running: false, version: null },
    });
    expect(JSON.stringify(without)).not.toContain("ssh-terminal");
  });

  it("refuses a tunnelled server without a running SSH Terminal 1.2.0 or newer", () => {
    const off = { running: false, version: "1.4.1" };
    expect(planHost(tunnelled, { ...base, sshTerminal: off })).toEqual({
      ok: false,
      cause: "needs-ssh-terminal",
    });
    for (const version of ["1.0.3", "1.1.9", "0.9.0", "1.2.0-beta.1", null]) {
      expect(
        planHost(tunnelled, {
          ...base,
          sshTerminal: { running: true, version },
        }),
        String(version),
      ).toEqual({ ok: false, cause: "ssh-terminal-too-old" });
    }
    for (const version of ["1.2.0", "1.2.1", "1.10.0", "2.0.0", "v1.4.1"]) {
      expect(
        planHost(tunnelled, {
          ...base,
          sshTerminal: { running: true, version },
        }).ok,
        version,
      ).toBe(true);
    }
    // A plain server needs no SSH Terminal.
    expect(planHost(plain, { ...base, sshTerminal: off }).ok).toBe(true);
  });
});

describe("SSH_TERMINAL_KEYS", () => {
  it("SSH_TERMINAL_KEYS names", () => {
    expect(SSH_TERMINAL_KEYS).toEqual({
      enabled: "cloudflareTunnelEnabled",
      hostname: "cloudflareTunnelHostname",
      port: "cloudflareTunnelPort",
      clientId: "cloudflareTunnelClientId",
      clientSecret: "cloudflareTunnelClientSecret",
    });
  });
});

describe("cleanAddress", () => {
  it("accepts host names and addresses, clears on empty, refuses the rest", () => {
    expect(cleanAddress(" 10.0.0.2 ")).toBe("10.0.0.2");
    expect(cleanAddress("coolify.lan")).toBe("coolify.lan");
    expect(cleanAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(cleanAddress("")).toBeNull();
    expect(cleanAddress(null)).toBeNull();
    expect(cleanAddress(undefined)).toBeUndefined();
    expect(() => cleanAddress("a b")).toThrow();
    expect(() => cleanAddress("host.docker.internal")).toThrow();
    expect(() => cleanAddress("x".repeat(300))).toThrow();
    expect(() => cleanAddress(5)).toThrow();
  });
});

describe("folderName", () => {
  it("is Coolify for one connection and names the connection when there are several", () => {
    expect(folderName("Prod", 1)).toBe("Coolify");
    expect(folderName("Prod", 2)).toBe("Coolify / Prod");
  });
});
