import { randomUUID } from "node:crypto";
import type { CoolifyApi } from "../coolify/api.js";
import type { DeploymentDto, ResourceDto } from "../coolify/dto.js";
import { CoolifyError } from "../coolify/http.js";
import { ConnectionError } from "../connections/service.js";
import { redact } from "../redact.js";
import { isFinalDeployment } from "../../shared/deployment-status.js";

/** The queue and recent history are cached this long, like resources. */
export const QUEUE_TTL_MS = 10_000;
/** History is read for this many applications, the most recently deployed. */
export const HISTORY_APPS = 10;
/** Rows read from each of those applications' history. */
export const HISTORY_PER_APP = 5;
/** Recent rows kept, newest first. */
export const RECENT_MAX = 25;
/** History pages read at the same time. */
const HISTORY_CONCURRENCY = 4;

/** A deployment of one of the connection's own applications, with its name. */
export interface QueueRow extends DeploymentDto {
  resourceUuid: string;
  resourceName: string;
}

/**
 * The connection-wide view of deployments: what Coolify has queued or running
 * now (oldest first, as Coolify orders it) and the recent ended ones (newest
 * first). Only deployments of the connection's own applications are in it.
 */
export interface DeploymentQueue {
  running: QueueRow[];
  recent: QueueRow[];
  /** When it was read from Coolify, in epoch milliseconds. */
  fetchedAt: number;
}

/** The queue as routes and operations answer it: times as ISO strings. */
export function queueBody(queue: DeploymentQueue) {
  return { ...queue, fetchedAt: new Date(queue.fetchedAt).toISOString() };
}

/** Whether a query or input flag asks to skip the cache. */
export function refreshFlag(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

interface Cached {
  revision: string;
  generation: string;
  value: DeploymentQueue;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/** Most recently deployed first; never deployed last, by name. */
function byLastDeploy(a: ResourceDto, b: ResourceDto): number {
  const ta = a.lastDeployAt ? Date.parse(a.lastDeployAt) : Number.NaN;
  const tb = b.lastDeployAt ? Date.parse(b.lastDeployAt) : Number.NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  if (Number.isFinite(ta) !== Number.isFinite(tb)) {
    return Number.isFinite(ta) ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function newestFirst(a: QueueRow, b: QueueRow): number {
  return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
}

/**
 * The cached connection-wide queue. One read per connection revision and
 * invalidate generation at a time: callers that miss together share it, and
 * a hit counts only while both are current, so rows read before a changed
 * address or token, or before a cancel or deploy, are never served. The
 * caller checks access before and after (deployments/service.ts `queue`).
 */
export function createQueueCache(deps: {
  revision: (connectionId: number) => Promise<string | null>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = new Map<number, Cached>();
  const inflight = new Map<string, Promise<DeploymentQueue>>();
  const epoch = randomUUID();
  const generations = new Map<number, number>();
  const generationOf = (id: number) => `${epoch}:${generations.get(id) ?? 0}`;

  async function fetchQueue(
    connectionId: number,
    api: CoolifyApi,
    applications: ResourceDto[],
    revision: string,
    generation: string,
    currentRevision: () => Promise<string | null>,
  ): Promise<DeploymentQueue> {
    // Checked right before each request: the connection still points at
    // the target the read began on.
    const guard = async () => {
      if ((await currentRevision()) !== revision) {
        throw new ConnectionError(
          "target-changed",
          "The connection's address, token or Access settings changed. Try again.",
        );
      }
    };
    const apps = new Map(applications.map((a) => [a.uuid, a]));
    const own = (row: DeploymentDto): QueueRow | null => {
      const app = row.resourceUuid ? apps.get(row.resourceUuid) : undefined;
      if (!app) return null;
      return {
        ...(redact(row) as DeploymentDto),
        resourceUuid: app.uuid,
        resourceName: app.name,
      };
    };
    const running = (await api.runningDeployments({ beforeFetch: guard }))
      .map(own)
      .filter((r): r is QueueRow => r !== null);
    const picked = [...applications].sort(byLastDeploy).slice(0, HISTORY_APPS);
    const pages = await mapLimit(picked, HISTORY_CONCURRENCY, async (app) => {
      try {
        return (
          await api.deploymentPage(app.uuid, {
            skip: 0,
            take: HISTORY_PER_APP,
            beforeFetch: guard,
          })
        ).rows;
      } catch (err) {
        // An application Coolify no longer has: no history, not a failure.
        if (err instanceof CoolifyError && err.cause === "not-found") return [];
        throw err;
      }
    });
    const live = new Set(running.map((r) => r.uuid));
    const seen = new Set<string>();
    const recent = pages
      .flat()
      .map(own)
      .filter((r): r is QueueRow => {
        if (!r || live.has(r.uuid) || seen.has(r.uuid)) return false;
        seen.add(r.uuid);
        return isFinalDeployment(r.status);
      })
      .sort(newestFirst)
      .slice(0, RECENT_MAX);
    const value = { running, recent, fetchedAt: now() };
    if (
      (await currentRevision()) === revision &&
      generationOf(connectionId) === generation
    ) {
      cache.set(connectionId, { revision, generation, value });
    }
    return value;
  }

  return {
    /**
     * The queue for `revision`, from the cache while it is fresh, else read
     * through `api` (shared with any read already running for it).
     */
    async read(
      connectionId: number,
      revision: string,
      source: {
        api: CoolifyApi;
        applications: ResourceDto[];
        /**
         * The connection's revision now, for a reader with no actor (the
         * poller, through its unattended snapshot); the actor's otherwise.
         */
        revision?: () => Promise<string | null>;
      },
      opts: { refresh?: boolean } = {},
    ): Promise<DeploymentQueue> {
      const generation = generationOf(connectionId);
      const hit = cache.get(connectionId);
      if (
        !opts.refresh &&
        hit &&
        hit.revision === revision &&
        hit.generation === generation
      ) {
        const age = now() - hit.value.fetchedAt;
        if (age >= 0 && age < QUEUE_TTL_MS) return hit.value;
      }
      const key = `${connectionId}:${revision}:${generation}`;
      const pending = inflight.get(key);
      if (pending) return pending;
      const started = fetchQueue(
        connectionId,
        source.api,
        source.applications,
        revision,
        generation,
        source.revision ?? (() => deps.revision(connectionId)),
      ).finally(() => {
        if (inflight.get(key) === started) inflight.delete(key);
      });
      inflight.set(key, started);
      return started;
    },

    /** Drops the cached queue, after a cancel or a deploy. */
    invalidate(connectionId: number): void {
      generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
      cache.delete(connectionId);
      for (const key of [...inflight.keys()]) {
        if (key.startsWith(`${connectionId}:`)) inflight.delete(key);
      }
    },
  };
}
