import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createCache } from "../cache.js";
import type { ResourceDto } from "../coolify/dto.js";
import { ConnectionError, type Connections } from "../connections/service.js";
import type { Tables } from "../db.js";
import {
  countResources,
  type ResourceCounts,
} from "../../shared/resource-health.js";

/** Statuses are cached this long (the design's "Errors and limits"). */
export const RESOURCE_TTL_MS = 20_000;

/** The cache kind holding a connection's merged resource list. */
export const RESOURCES_CACHE_KIND = "resources";

export interface ResourcesDeps {
  tables: Tables;
  connections: Connections;
  /** The clock, for tests. */
  now?: () => number;
}

export interface ResourceList {
  rows: ResourceDto[];
  fetchedAt: number;
}

const notFound = () =>
  new ConnectionError("not-found", "Coolify connection not found");

/**
 * A connection's applications, services (each followed by its Parts) and
 * databases as one list of stripped DTOs, read from Coolify's per-type lists
 * and never from the heavy `/resources`. Every call checks the actor's access
 * to the connection first, so another user's connection is a 404 even when
 * the cache holds its rows.
 */
export function createResources(ctx: PluginContext, deps: ResourcesDeps) {
  const cache = createCache(ctx, deps.tables);
  const now = deps.now ?? Date.now;
  // One fetch per connection at a time; callers that miss together share it.
  const inflight = new Map<number, Promise<ResourceList>>();

  async function reach(connectionId: number): Promise<void> {
    if (!(await deps.connections.access(connectionId))) throw notFound();
  }

  async function fetchList(connectionId: number): Promise<ResourceList> {
    const api = await deps.connections.api(connectionId);
    const [applications, services, databases] = await Promise.all([
      api.applications(),
      api.services(),
      api.databases(),
    ]);
    const list = {
      rows: [...applications, ...services, ...databases],
      fetchedAt: now(),
    };
    await cache.write(
      connectionId,
      RESOURCES_CACHE_KIND,
      list.rows,
      list.fetchedAt,
    );
    return list;
  }

  async function load(
    connectionId: number,
    opts: { refresh?: boolean } = {},
  ): Promise<ResourceList> {
    await reach(connectionId);
    if (!opts.refresh) {
      const hit = await cache.fresh<ResourceDto[]>(
        connectionId,
        RESOURCES_CACHE_KIND,
        RESOURCE_TTL_MS,
        now(),
      );
      if (hit && Array.isArray(hit.value)) {
        return { rows: hit.value, fetchedAt: hit.fetchedAt };
      }
    }
    const pending = inflight.get(connectionId);
    if (pending) return pending;
    const started = fetchList(connectionId).finally(() =>
      inflight.delete(connectionId),
    );
    inflight.set(connectionId, started);
    return started;
  }

  return {
    /** The list with the time it was fetched, for "updated" labels. */
    load,

    async list(
      connectionId: number,
      opts: { refresh?: boolean } = {},
    ): Promise<ResourceDto[]> {
      return (await load(connectionId, opts)).rows;
    },

    /** A resource or a Part by uuid, from the same cached list, or null. */
    async get(
      connectionId: number,
      uuid: string,
      opts: { refresh?: boolean } = {},
    ): Promise<ResourceDto | null> {
      const { rows } = await load(connectionId, opts);
      return rows.find((r) => r.uuid === uuid) ?? null;
    },

    async byServer(
      connectionId: number,
      serverUuid: string,
    ): Promise<ResourceDto[]> {
      return (await load(connectionId)).rows.filter(
        (r) => r.serverUuid === serverUuid,
      );
    },

    /** Running, degraded, stopped and deploying, Parts left out. */
    async counts(
      connectionId: number,
      serverUuid?: string,
    ): Promise<ResourceCounts> {
      const rows = (await load(connectionId)).rows;
      return countResources(
        serverUuid ? rows.filter((r) => r.serverUuid === serverUuid) : rows,
      );
    },

    /** Drops the cached list, after a change like a deploy or a stop. */
    async invalidate(connectionId: number): Promise<void> {
      await cache.drop(connectionId, RESOURCES_CACHE_KIND);
    },
  };
}

export type Resources = ReturnType<typeof createResources>;
