import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ContainerError } from "../containers/service.js";
import type { Metrics } from "../metrics/service.js";
import type { ServerHealthService } from "../resources/server-health.js";
import type { Sync } from "../sync/service.js";

const NOT_LINKED = {
  summary: "Not a Linked host: no Coolify server",
  data: { linked: false },
};

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * The reads behind a Linked host's dashboard row and host metrics, for every
 * surface: resource counts and deployments (the shared caches, as the host
 * dot reads them) and the container CPU and memory summary (docker stats over
 * SSH, coolify.operate and an operate grant, at most once per 30 seconds).
 * Any other host answers linked: false and reaches nothing.
 */
export function registerHostSlotOperations(
  ctx: PluginContext,
  deps: {
    serverHealth: ServerHealthService;
    metrics: Pick<Metrics, "hostStats">;
    sync: Pick<Sync, "linkOfHost">;
  },
): void {
  const { serverHealth, metrics, sync } = deps;

  ctx.operations.register("coolify.host-summary", {
    run: async (_input, { hostId }) => {
      const link = hostId ? await sync.linkOfHost(hostId) : null;
      if (!hostId || !link) return NOT_LINKED;
      // The host id is the caller's: their own connect access, before Coolify.
      const access = await ctx.hosts.checkAccess(hostId, "connect");
      if (!access?.hasAccess) {
        throw new ContainerError(
          "no-host-access",
          "You can't open this server's Linked host.",
        );
      }
      const health = await serverHealth.read(link.connectionId);
      const uuid = link.serverUuid;
      const server = health.servers?.find((s) => s.uuid === uuid) ?? null;
      const counts = health.counts
        ? (health.counts[uuid] ?? {
            running: 0,
            degraded: 0,
            stopped: 0,
            deploying: 0,
          })
        : null;
      const deploying = health.deploying ? (health.deploying[uuid] ?? 0) : null;
      return {
        summary:
          counts && deploying !== null
            ? `${counts.running} running, ${counts.degraded} degraded, ${counts.stopped} stopped, ${deploying} deploying`
            : "Coolify's resources could not be read",
        data: {
          linked: true,
          connectionId: link.connectionId,
          serverUuid: uuid,
          server: server
            ? { reachable: server.reachable, usable: server.usable }
            : null,
          counts,
          deploying,
        },
      };
    },
  });

  ctx.operations.register("coolify.host-metrics", {
    run: async (_input, { hostId }) => {
      const link = hostId ? await sync.linkOfHost(hostId) : null;
      if (!link) return NOT_LINKED;
      const uuid = link.serverUuid;
      // The same checks as the route: operate, a grant, connect access.
      const { servers, errors } = await metrics.hostStats(link.connectionId, [
        uuid,
      ]);
      const stats = servers[uuid];
      if (!stats) {
        throw new Error(
          `Container stats could not be read (${errors[uuid] ?? "ssh-failed"})`,
        );
      }
      return {
        summary: `${stats.containers} container${stats.containers === 1 ? "" : "s"}: CPU ${stats.cpuPercent}%, memory ${megabytes(stats.memoryBytes)}`,
        data: {
          linked: true,
          connectionId: link.connectionId,
          serverUuid: uuid,
          stats,
        },
      };
    },
  });
}
