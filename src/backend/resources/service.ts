import { randomUUID } from "node:crypto";
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

/**
 * The cached value: the rows, the connection revision they came from and the
 * invalidate generation they were fetched in. A hit needs both to be current.
 */
interface CachedRows {
  revision: string;
  generation: string;
  rows: ResourceDto[];
}

const notFound = () =>
  new ConnectionError("not-found", "Coolify connection not found");

/**
 * A connection's applications, services (each followed by its Parts) and
 * databases as one list of stripped DTOs, read from Coolify's per-type lists
 * and never from the heavy `/resources`. Every call checks the actor's access
 * to the connection first, so another user's connection is a 404 even when
 * the cache holds its rows. The in-flight fetches are keyed by the
 * connection's revision and by a generation that `invalidate` advances, and
 * the cached rows carry both. A cache hit counts only when both are current,
 * so rows read before a changed address, token or TLS setting, or before an
 * invalidate, are never served, even when their write lands after the drop.
 * Generations are unique to each instance (`<epoch>:<n>`, the epoch a random
 * uuid), so after a restart no row an old instance wrote ever matches: the
 * cache starts cold, which costs one fetch.
 */
export function createResources(ctx: PluginContext, deps: ResourcesDeps) {
  const cache = createCache(ctx, deps.tables);
  const now = deps.now ?? Date.now;
  // One fetch per connection revision at a time; callers that miss together
  // share it, and a caller after a change never joins a fetch from before it.
  const inflight = new Map<string, Promise<ResourceList>>();
  // Advanced by invalidate(); a fetch commits only under the one it began in.
  const epoch = randomUUID();
  const generations = new Map<number, number>();
  const generationOf = (connectionId: number) =>
    `${epoch}:${generations.get(connectionId) ?? 0}`;

  /** The connection's current revision, or a 404. */
  async function reach(connectionId: number): Promise<string> {
    const revision = await deps.connections.revision(connectionId);
    if (!revision) throw notFound();
    return revision;
  }

  async function fetchList(
    connectionId: number,
    revision: string,
    generation: string,
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
    // started under and nothing invalidated it since. The rows carry both, so
    // a change or an invalidate that lands after this check (even one whose
    // drop finishes before this write does) never serves them.
    const current = await deps.connections.revision(connectionId);
    if (current === revision && generationOf(connectionId) === generation) {
      const value: CachedRows = { revision, generation, rows: list.rows };
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
      const value = hit?.value;
      if (
        hit &&
        value?.revision === revision &&
        value.generation === generationOf(connectionId) &&
        Array.isArray(value.rows)
      ) {
        return { rows: value.rows, fetchedAt: hit.fetchedAt };
      }
    }
    const generation = generationOf(connectionId);
    const key = `${connectionId}:${revision}:${generation}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const started = fetchList(connectionId, revision, generation).finally(
      () => {
        if (inflight.get(key) === started) inflight.delete(key);
      },
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
      generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
      for (const key of [...inflight.keys()]) {
        if (key.startsWith(`${connectionId}:`)) inflight.delete(key);
      }
      await cache.drop(connectionId, RESOURCES_CACHE_KIND);
    },
  };
}

export type Resources = ReturnType<typeof createResources>;
