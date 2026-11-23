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
/**
 * An application's history page is read again after this long even with no
 * sign of news: the backstop for a deployment that starts and ends between
 * two reads. Kept well inside the poller's CLOCK_SLACK_MS (5 minutes), so such
 * a deployment still counts as news when a poll finds it.
 */
export const HISTORY_REFRESH_MS = 3 * 60_000;

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
  /**
   * When the oldest history page in `recent` was read from Coolify (a page
   * can be reused for up to HISTORY_REFRESH_MS). The poller's watermark for
   * "ended since the last read", so a reused page never eats into its
   * CLOCK_SLACK_MS. Not answered to callers.
   */
  historyReadAt: number;
}

/** The queue as routes and operations answer it: times as ISO strings. */
export function queueBody(queue: DeploymentQueue) {
  const { historyReadAt: _historyReadAt, ...answer } = queue;
  return { ...answer, fetchedAt: new Date(queue.fetchedAt).toISOString() };
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

/**
 * The history pages last read for one connection's applications, so a read
 * asks Coolify again only for applications with news. Only for one revision.
 */
interface Histories {
  revision: string;
  pages: Map<string, { rows: DeploymentDto[]; readAt: number }>;
  /**
   * The deployments queued or running at the last read, each to its
   * application: one that has left the queue since is news for its page.
   */
  running: Map<string, string>;
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
  const histories = new Map<number, Histories>();

  /**
   * Advances the connection's generation and drops its cached queue, its
   * kept pages and its running reads: a read started before can still answer
   * its own callers, but no longer writes the cache or the pages. After a
   * deploy, cancel or rollback (invalidate), and before a fresh baseline read.
   */
  function supersede(connectionId: number): void {
    generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
    cache.delete(connectionId);
    histories.delete(connectionId);
    for (const key of [...inflight.keys()]) {
      if (key.startsWith(`${connectionId}:`)) inflight.delete(key);
    }
  }

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
    // Each application's page is read again only when it may hold news: a
    // deployment that was running at the last read has ended, the page was
    // never read, or it is older than HISTORY_REFRESH_MS. Every other page is
    // the one read before, so a steady connection costs one request a read.
    const prior = histories.get(connectionId);
    const known = prior?.revision === revision ? prior : null;
    const runningNow = new Map(running.map((r) => [r.uuid, r.resourceUuid]));
    // Applications with a deployment that was queued or running at the last
    // read and isn't now: it ended (or was cancelled), whatever else of that
    // application is still queued.
    const ended = new Set(
      [...(known?.running ?? [])]
        .filter(([deployment]) => !runningNow.has(deployment))
        .map(([, app]) => app),
    );
    const readAt = now();
    const fresh = (uuid: string, page: { readAt: number }) => {
      if (ended.has(uuid)) return false;
      const age = readAt - page.readAt;
      return age >= 0 && age < HISTORY_REFRESH_MS;
    };
    const pages = await mapLimit(picked, HISTORY_CONCURRENCY, async (app) => {
      const kept = known?.pages.get(app.uuid);
      if (kept && fresh(app.uuid, kept)) return { uuid: app.uuid, ...kept };
      try {
        const rows = (
          await api.deploymentPage(app.uuid, {
            skip: 0,
            take: HISTORY_PER_APP,
            beforeFetch: guard,
          })
        ).rows;
        return { uuid: app.uuid, rows, readAt };
      } catch (err) {
        // An application Coolify no longer has: no history, not a failure.
        if (err instanceof CoolifyError && err.cause === "not-found") {
          return { uuid: app.uuid, rows: [], readAt };
        }
        throw err;
      }
    });
    const live = new Set(running.map((r) => r.uuid));
    const seen = new Set<string>();
    const recent = pages
      .flatMap((page) => page.rows)
      .map(own)
      .filter((r): r is QueueRow => {
        if (!r || live.has(r.uuid) || seen.has(r.uuid)) return false;
        seen.add(r.uuid);
        return isFinalDeployment(r.status);
      })
      .sort(newestFirst)
      .slice(0, RECENT_MAX);
    const fetchedAt = now();
    const value = {
      running,
      recent,
      fetchedAt,
      historyReadAt: Math.min(fetchedAt, ...pages.map((p) => p.readAt)),
    };
    if (
      (await currentRevision()) === revision &&
      generationOf(connectionId) === generation
    ) {
      cache.set(connectionId, { revision, generation, value });
      histories.set(connectionId, {
        revision,
        pages: new Map(
          pages.map((p) => [p.uuid, { rows: p.rows, readAt: p.readAt }]),
        ),
        running: runningNow,
      });
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
      opts: {
        refresh?: boolean;
        /**
         * Every history page read now, none reused: the poller's baseline,
         * which must not take in pages from before polling stopped. It
         * supersedes every read already running, as an invalidate does, so
         * none of them can write the cache or the pages after it.
         */
        freshHistory?: boolean;
      } = {},
    ): Promise<DeploymentQueue> {
      const fresh = opts.freshHistory === true;
      if (fresh) supersede(connectionId);
      const generation = generationOf(connectionId);
      const hit = cache.get(connectionId);
      if (
        !opts.refresh &&
        !fresh &&
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
    invalidate: supersede,
  };
}
