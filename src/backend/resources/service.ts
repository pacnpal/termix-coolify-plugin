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

/** The cached value: the rows and the connection revision they came from. */
interface CachedRows {
  revision: string;
  rows: ResourceDto[];
}

const notFound = () =>
  new ConnectionError("not-found", "Coolify connection not found");

/**
 * A connection's applications, services (each followed by its Parts) and
 * databases as one list of stripped DTOs, read from Coolify's per-type lists
 * and never from the heavy `/resources`. Every call checks the actor's access
 * to the connection first, so another user's connection is a 404 even when
 * the cache holds its rows. The cache and the in-flight fetches are keyed by
 * the connection's revision, so a changed address, token or TLS setting never
 * serves rows read with the old one.
 */
export function createResources(ctx: PluginContext, deps: ResourcesDeps) {
  const cache = createCache(ctx, deps.tables);
  const now = deps.now ?? Date.now;
  // One fetch per connection revision at a time; callers that miss together
  // share it, and a caller after a change never joins a fetch from before it.
  const inflight = new Map<string, Promise<ResourceList>>();

  /** The connection's current revision, or a 404. */
  async function reach(connectionId: number): Promise<string> {
    const revision = await deps.connections.revision(connectionId);
    if (!revision) throw notFound();
    return revision;
  }

  async function fetchList(
    connectionId: number,
    revision: string,
  ): Promise<ResourceList> {
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
    // Cached only while the connection still has the revision the fetch
    // started under. The rows carry it too, so a change that lands after
    // this check still never serves them.
    const current = await deps.connections.revision(connectionId);
    if (current === revision) {
      const value: CachedRows = { revision, rows: list.rows };
      await cache.write(
        connectionId,
        RESOURCES_CACHE_KIND,
        value,
        list.fetchedAt,
      );
    }
    return list;
  }

  async function load(
    connectionId: number,
    opts: { refresh?: boolean } = {},
  ): Promise<ResourceList> {
    const revision = await reach(connectionId);
    if (!opts.refresh) {
      const hit = await cache.fresh<Partial<CachedRows>>(
        connectionId,
        RESOURCES_CACHE_KIND,
        RESOURCE_TTL_MS,
        now(),
      );
      if (hit?.value?.revision === revision && Array.isArray(hit.value.rows)) {
        return { rows: hit.value.rows, fetchedAt: hit.fetchedAt };
      }
    }
    const key = `${connectionId}:${revision}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const started = fetchList(connectionId, revision).finally(() =>
      inflight.delete(key),
    );
    inflight.set(key, started);
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
