import { ConnectionError, type Connections } from "../connections/service.js";
import type { Deployments } from "../deployments/service.js";
import type { ServerStatuses } from "../ops/signals.js";
import {
  countResources,
  resourceHealth,
  type ResourceCounts,
} from "../../shared/resource-health.js";
import type { Resources } from "./service.js";

/** What a Linked host row may show of each server: no address, key or user. */
export interface ServerHealth {
  /** Null when the token can't read servers (a scoped token). */
  servers: { uuid: string; reachable: boolean; usable: boolean }[] | null;
  /** Degraded resources by server uuid; null when resources can't be read. */
  degraded: Record<string, number> | null;
  /** Resource counts by server uuid (countResources); null as `degraded`. */
  counts: Record<string, ResourceCounts> | null;
  /**
   * Resources being deployed by server uuid: those with a deployment in
   * Coolify's queue (queued or in progress) or a deploying status. Null as
   * `degraded`; a queue that can't be read leaves only the statuses.
   */
  deploying: Record<string, number> | null;
}

export interface ServerHealthDeps {
  connections: Pick<Connections, "revision">;
  resources: Pick<Resources, "load">;
  servers: Pick<ServerStatuses, "list">;
  deployments: Pick<Deployments, "queue">;
}

/**
 * Each server's reachability, resource counts and deployments, for Linked
 * host rows (the dot, the counts and the deploying badge). Every part comes
 * from a shared cache (servers a minute, resources 20 seconds, the queue 10
 * seconds), so all the host rows of a connection cost one call here and at
 * most one Coolify read per list. The connection's revision is read before
 * and after, so an answer never mixes two targets: a change while it reads
 * ends with target-changed.
 */
export function createServerHealth(deps: ServerHealthDeps) {
  return {
    async read(connectionId: number): Promise<ServerHealth> {
      // Checks the actor's access; the reads below check it again.
      const before = await deps.connections.revision(connectionId);
      const [list, servers, queue] = await Promise.allSettled([
        deps.resources.load(connectionId),
        deps.servers.list(connectionId),
        deps.deployments.queue(connectionId),
      ]);
      if (list.status === "rejected" && servers.status === "rejected") {
        throw list.reason;
      }
      if (
        before === null ||
        (await deps.connections.revision(connectionId)) !== before
      ) {
        throw new ConnectionError(
          "target-changed",
          "The connection's address, token or Access settings changed. Try again.",
        );
      }
      const health: ServerHealth = {
        servers:
          servers.status === "fulfilled"
            ? servers.value.map((s) => ({
                uuid: s.uuid,
                reachable: s.reachable,
                usable: s.usable,
              }))
            : null,
        degraded: null,
        counts: null,
        deploying: null,
      };
      if (list.status === "rejected") return health;
      const queued = new Set(
        queue.status === "fulfilled"
          ? queue.value.running.map((r) => r.resourceUuid)
          : [],
      );
      const byServer = new Map<string, typeof list.value.rows>();
      for (const row of list.value.rows) {
        if (!row.serverUuid) continue;
        const rows = byServer.get(row.serverUuid) ?? [];
        rows.push(row);
        byServer.set(row.serverUuid, rows);
      }
      const entries = [...byServer];
      health.counts = Object.fromEntries(
        entries.map(([uuid, rows]) => [uuid, countResources(rows)]),
      );
      health.degraded = Object.fromEntries(
        entries.map(([uuid]) => [uuid, health.counts![uuid]!.degraded]),
      );
      // Parts are left out, as countResources does: their service covers them.
      health.deploying = Object.fromEntries(
        entries.map(([uuid, rows]) => [
          uuid,
          rows.filter(
            (r) =>
              !r.parentUuid &&
              (queued.has(r.uuid) || resourceHealth(r.status) === "deploying"),
          ).length,
        ]),
      );
      return health;
    },
  };
}

export type ServerHealthService = ReturnType<typeof createServerHealth>;
