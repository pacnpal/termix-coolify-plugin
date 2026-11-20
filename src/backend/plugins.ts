import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * Every other plugin this one works with, by feature: Docker and SSH
 * Terminal for host sync, Package Manager for server updates, and the
 * companion features. The one place their ids are spelled.
 */
export const COMPANION_PLUGINS = {
  docker: "docker",
  sshTerminal: "ssh-terminal",
  files: "file-manager",
  tunnels: "tunnels",
  reverseProxy: "reverse-proxy",
  dns: "dns",
  uptime: "uptime",
  logSearch: "log-search",
  packageManager: "package-manager",
  securityCenter: "security-center",
  hostMetrics: "host-metrics",
  databases: "databases",
  backups: "backups",
} as const;

/** Active plugins by id, with their version. */
export type ActivePlugins = ReadonlyMap<string, string | null>;

/**
 * The one read of ctx.plugins.list() that sync, server updates and the
 * companion features share: the plugins whose state is active. Null when the
 * list can't be read, which each caller must treat as unknown, never as
 * "not running".
 */
export async function activePlugins(
  ctx: PluginContext,
): Promise<ActivePlugins | null> {
  try {
    const list = await ctx.plugins.list();
    return new Map(
      list
        .filter((p) => p.state === "active")
        .map((p) => [p.id, p.version ?? null]),
    );
  } catch {
    return null;
  }
}
