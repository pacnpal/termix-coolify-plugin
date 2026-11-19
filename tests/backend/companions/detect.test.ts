import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  COMPANION_PLUGINS,
  companions,
} from "../../../src/backend/companions/detect.js";
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
  it("maps each companion to whether its plugin is active, cached for 60 seconds", async () => {
    vi.useFakeTimers();
    const ctx = ctxWith(async () => installed(["dns", "backups"]));
    const first = await companions(ctx);
    expect(first.dns).toBe(true);
    expect(first.backups).toBe(true);
    expect(first.uptime).toBe(false);
    expect(Object.keys(first).sort()).toEqual(
      [
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
    await companions(ctx);
    expect(ctx.plugins.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await companions(ctx);
    expect(ctx.plugins.list).toHaveBeenCalledTimes(2);
  });

  it("reads every companion as missing when the plugin list can't be read", async () => {
    const ctx = ctxWith(async () => {
      throw new Error("no plugins:read");
    });
    const map = await companions(ctx);
    expect(Object.values(map).every((v) => v === false)).toBe(true);
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
    expect([...invokes].sort()).toEqual([
      "backups.failed",
      "log-search.search",
      "uptime.pause",
      "uptime.resume",
    ]);
    for (const id of invokes) {
      expect(id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
      expect(id).not.toContain("*");
    }
  });

  it("requires the companions' services as optional, and pins their plugin ranges", () => {
    const requires = (manifest.requires ?? []) as {
      service: string;
      versionRange: string;
      optional?: boolean;
    }[];
    const services = Object.fromEntries(requires.map((r) => [r.service, r]));
    for (const service of [
      "dns.records",
      "uptime.access",
      "security-center.access",
      "databases.logins",
    ]) {
      expect(services[service], service).toBeDefined();
      expect(services[service].optional, service).toBe(true);
    }
    const deps = manifest.optionalDependencies ?? {};
    for (const plugin of [
      "dns",
      "uptime",
      "log-search",
      "security-center",
      "host-metrics",
      "databases",
      "backups",
    ]) {
      // A tilde range: patch releases of the tested version only.
      expect(deps[plugin], plugin).toMatch(/^~\d+\.\d+\.\d+$/);
    }
  });
});
