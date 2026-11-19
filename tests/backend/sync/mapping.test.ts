import { describe, expect, it } from "vitest";
import { toServer } from "../../../src/backend/coolify/dto.js";
import {
  cleanAddress,
  folderName,
  planHost,
  TUNNEL_CAUSE,
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

  it("tunnelled server is refused with the tunnel cause and gets no ssh-terminal settings", () => {
    const plan = planHost(tunnelled, base);
    expect(plan).toEqual({ ok: false, cause: TUNNEL_CAUSE });
    expect(TUNNEL_CAUSE).toBe("needs-tunnel-support");
    expect(JSON.stringify(plan)).not.toContain("ssh-terminal");
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
