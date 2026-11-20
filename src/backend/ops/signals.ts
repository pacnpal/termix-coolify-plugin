import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { SignalResult } from "@termix-ssh/plugin-sdk/operations";
import { createCache } from "../cache.js";
import type { ServerDto } from "../coolify/dto.js";
import type { Connections } from "../connections/service.js";
import type { Tables } from "../db.js";
import type { Resources } from "../resources/service.js";
import type { Sync } from "../sync/service.js";

/** Server statuses are cached this long, per connection. */
export const SERVERS_TTL_MS = 60_000;
export const SERVERS_CACHE_KIND = "servers";

/** What a server signal keeps of a server: no addresses, keys or users. */
interface ServerStatus {
  uuid: string;
  name: string;
  reachable: boolean;
  usable: boolean;
  security: number | null;
}

/** A cached server list and the connection revision it was read under. */
interface CachedServers {
  revision: string;
  rows: ServerStatus[];
}

function statusOf(s: ServerDto): ServerStatus {
  return {
    uuid: s.uuid,
    name: s.name,
    reachable: s.reachable,
    usable: s.usable,
    security: s.patch?.security ?? null,
  };
}

const unknown = (label: string): SignalResult => ({
  value: null,
  status: "unknown",
  label,
});

const signal = (result: SignalResult) => ({
  summary: result.label ?? String(result.value ?? result.status),
  data: result,
});

/**
 * The status-tile reads. Each is cheap: resource counts come from the
 * resources cache (20 seconds) and server statuses from a servers cache (a
 * minute), so many hosts on one connection cost one Coolify fetch. A host
 * that isn't linked, or whose connection the actor can't read, is unknown.
 */
export function registerSignalOperations(
  ctx: PluginContext,
  deps: {
    tables: Tables;
    connections: Connections;
    resources: Resources;
    sync: Sync;
    now?: () => number;
  },
): void {
  const { connections, resources, sync } = deps;
  const cache = createCache(ctx, deps.tables);
  const now = deps.now ?? Date.now;
  // One fetch per connection revision at a time; a caller after a target
  // change never joins a fetch that started before it.
  const inflight = new Map<string, Promise<ServerStatus[]>>();

  async function servers(connectionId: number): Promise<ServerStatus[]> {
    // revision() checks access before the cache, as in resources, and names
    // the target, so rows read from an old address or token are never served.
    const revision = await connections.revision(connectionId);
    if (!revision) throw new Error("No access to this connection");
    const hit = await cache.fresh<Partial<CachedServers>>(
      connectionId,
      SERVERS_CACHE_KIND,
      SERVERS_TTL_MS,
      now(),
    );
    const value = hit?.value;
    if (value?.revision === revision && Array.isArray(value.rows)) {
      return value.rows;
    }
    const key = `${connectionId}:${revision}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const started = (async () => {
      const list = (await (await connections.api(connectionId)).servers()).map(
        statusOf,
      );
      // Cached only while the connection still has the revision the fetch
      // started under. The row carries it too, so a change that lands after
      // this check still never serves it.
      if ((await connections.revision(connectionId)) === revision) {
        const row: CachedServers = { revision, rows: list };
        await cache.write(connectionId, SERVERS_CACHE_KIND, row, now());
      }
      return list;
    })().finally(() => {
      if (inflight.get(key) === started) inflight.delete(key);
    });
    inflight.set(key, started);
    return started;
  }

  async function serverOfHost(
    hostId: number | undefined,
  ): Promise<{ connectionId: number; server: ServerStatus | null } | null> {
    const link = hostId ? await sync.linkOfHost(hostId) : null;
    if (!link) return null;
    const list = await servers(link.connectionId);
    return {
      connectionId: link.connectionId,
      server: list.find((s) => s.uuid === link.serverUuid) ?? null,
    };
  }

  ctx.operations.register("coolify.signal-degraded", {
    run: async (_input, { hostId }) => {
      const link = hostId ? await sync.linkOfHost(hostId) : null;
      if (!link) return signal(unknown("Not linked to Coolify"));
      try {
        const counts = await resources.counts(
          link.connectionId,
          link.serverUuid,
        );
        return signal({
          value: counts.degraded,
          status: counts.degraded > 0 ? "warn" : "ok",
          label: `${counts.degraded} degraded`,
          link: {
            tab: "coolify",
            data: { section: "resources", connectionId: link.connectionId },
          },
        });
      } catch {
        return signal(unknown("Coolify could not be read"));
      }
    },
  });

  ctx.operations.register("coolify.signal-server", {
    run: async (_input, { hostId }) => {
      try {
        const found = await serverOfHost(hostId);
        if (!found) return signal(unknown("Not linked to Coolify"));
        const { server } = found;
        if (!server) {
          return signal({
            value: "gone",
            status: "warn",
            label: "Gone from Coolify",
          });
        }
        if (!server.reachable) {
          return signal({
            value: "unreachable",
            status: "fail",
            label: "Coolify can't reach this server",
          });
        }
        if (!server.usable) {
          return signal({
            value: "not usable",
            status: "warn",
            label: "Coolify reports this server as not usable",
          });
        }
        return signal({ value: "reachable", status: "ok", label: "Reachable" });
      } catch {
        return signal(unknown("Coolify could not be read"));
      }
    },
  });

  ctx.operations.register("coolify.signal-updates", {
    run: async (_input, { hostId }) => {
      try {
        const found = await serverOfHost(hostId);
        const security = found?.server?.security ?? null;
        if (security === null) {
          return signal(unknown("No update check from Coolify yet"));
        }
        return signal({
          value: security,
          status: security > 0 ? "warn" : "ok",
          label: `${security} security update${security === 1 ? "" : "s"}`,
        });
      } catch {
        return signal(unknown("Coolify could not be read"));
      }
    },
  });

  ctx.operations.register("coolify.signal-deploying", {
    run: async () => {
      const list = await connections.list();
      let total = 0;
      let read = 0;
      for (const c of list) {
        try {
          total += (await resources.counts(c.id)).deploying;
          read += 1;
        } catch {
          // One connection Coolify can't answer for doesn't hide the others.
        }
      }
      if (list.length > 0 && read === 0) {
        return signal(unknown("Coolify could not be read"));
      }
      return signal({
        value: total,
        status: "ok",
        label: `${total} deploying`,
        link: { tab: "coolify", data: { section: "resources" } },
      });
    },
  });
}
