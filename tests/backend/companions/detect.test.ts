import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  COMPANION_PLUGINS,
  companions,
} from "../../../src/backend/companions/detect.js";
import { activePlugins } from "../../../src/backend/plugins.js";
import { manifest } from "../helpers/plugin.js";
import { installed } from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

function ctxWith(list: () => Promise<unknown>) {
  return { plugins: { list: vi.fn(list) } } as unknown as PluginContext & {
    plugins: { list: ReturnType<typeof vi.fn> };
  };
}

describe("companions(ctx)", () => {
  it("maps each companion, with sync's and updates' own, to whether its plugin is active", async () => {
    const ctx = ctxWith(async () => installed(["dns", "backups", "docker"]));
    const first = await companions(ctx);
    expect(first.dns).toBe(true);
    expect(first.backups).toBe(true);
    expect(first.docker).toBe(true);
    expect(first.uptime).toBe(false);
    expect(first.sshTerminal).toBe(false);
    expect(Object.keys(first).sort()).toEqual(
      [
        "docker",
        "sshTerminal",
        "files",
        "tunnels",
        "reverseProxy",
        "dns",
        "uptime",
        "logSearch",
        "packageManager",
        "securityCenter",
        "hostMetrics",
        "databases",
        "backups",
      ].sort(),
    );
    // Read fresh each time, as sync and updates read it: a plugin turned
    // off is seen at once.
    await companions(ctx);
    expect(ctx.plugins.list).toHaveBeenCalledTimes(2);
  });

  it("is companions-unknown, never all missing, when the plugin list can't be read", async () => {
    const ctx = ctxWith(async () => {
      throw new Error("no plugins:read");
    });
    await expect(companions(ctx)).rejects.toMatchObject({
      code: "companions-unknown",
      status: 409,
    });
  });

  it("reads the list through the one shared reader, which answers null when unreadable", async () => {
    const ok = ctxWith(async () => installed(["ssh-terminal"]));
    const active = await activePlugins(ok);
    expect(active?.get("ssh-terminal")).toBe("1.0.0");
    expect(active?.has("dns")).toBe(false);
    const broken = ctxWith(async () => {
      throw new Error("no plugins:read");
    });
    expect(await activePlugins(broken)).toBeNull();
  });

  it("names a plugin the manifest lists as an optional dependency for every companion", () => {
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    for (const plugin of Object.values(COMPANION_PLUGINS)) {
      expect(optional, plugin).toContain(plugin);
    }
  });
});

describe("manifest", () => {
  it("manifest operations.invokes has only exact ids", () => {
    const invokes = manifest.contributes?.operations?.invokes ?? [];
    // Every id the adapters and server updates invoke, spelled as the
    // companions' references spell them, and nothing else.
    expect([...invokes].sort()).toEqual(
      [
        "backups.failed",
        "databases.list-connections",
        "dns.delete-record",
        "dns.list-zones",
        "dns.upsert-record",
        "log-search.search",
        "package-manager.list-updates",
        "package-manager.upgrade-all",
        "security-center.critical-vulns",
        "security-center.status",
        "uptime.monitors",
        "uptime.pause",
        "uptime.resume",
      ].sort(),
    );
    for (const id of invokes) {
      expect(id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
      expect(id).not.toContain("*");
    }
  });

  it("uses no other plugin's service and pins each companion to its referenced version", () => {
    // Every companion call is a documented action; the references list no
    // service methods to call.
    expect(manifest.requires ?? []).toEqual([]);
    const deps = manifest.optionalDependencies ?? {};
    expect({
      dns: deps.dns,
      uptime: deps.uptime,
      "log-search": deps["log-search"],
      "security-center": deps["security-center"],
      "host-metrics": deps["host-metrics"],
      databases: deps.databases,
      backups: deps.backups,
    }).toEqual({
      dns: "~1.1.0",
      uptime: "~1.0.1",
      "log-search": "~1.1.0",
      "security-center": "~1.1.0",
      "host-metrics": "~1.4.1",
      databases: "~1.3.0",
      backups: "~1.1.0",
    });
  });
});
