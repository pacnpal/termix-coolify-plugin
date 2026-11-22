import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto } from "../coolify/dto.js";
import { toRouteError } from "../coolify/http.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import { mapLimit, type QueueRow } from "../deployments/queue.js";
import type { Deployments } from "../deployments/service.js";
import type { ServerStatuses } from "../ops/signals.js";
import type { Resources } from "../resources/service.js";
import { isFailedDeployment } from "../../shared/deployment-status.js";
import { resourceHealth } from "../../shared/resource-health.js";

/** A failed deployment counts for this long after it ended. */
export const RECENT_FAILURE_MS = 24 * 60 * 60_000;
/** Connections read at the same time. */
const CONNECTION_CONCURRENCY = 4;

/** A degraded resource, as the panel lists it. Never a Part. */
export interface AttentionResource {
  uuid: string;
  name: string;
  kind: ResourceDto["kind"];
  status: string;
  serverName: string | null;
  projectName: string | null;
  environmentName: string | null;
}

/** A Coolify server Coolify can't reach: no address, key or user. */
export interface AttentionServer {
  uuid: string;
  name: string;
}

/** What needs a look on one connection the actor can view. */
export interface AttentionConnection {
  id: number;
  name: string;
  access: AccessLevel;
  scoped: boolean;
  /** Queued and running deployments, oldest first. */
  running: QueueRow[];
  /** Recent failures that are still their application's latest outcome. */
  failed: QueueRow[];
  degraded: AttentionResource[];
  unreachable: AttentionServer[];
  /** Why a part could not be read; the parts that were read are kept. */
  error: { error: string; cause: string } | null;
}

export interface Attention {
  connections: AttentionConnection[];
  counts: {
    running: number;
    failed: number;
    degraded: number;
    unreachable: number;
  };
  /** The rail badge: running deployments plus recent failures. */
  badge: number;
  /** When it was put together, in epoch milliseconds. */
  fetchedAt: number;
}

/** The answer as routes and operations send it: times as ISO strings. */
export function attentionBody(attention: Attention) {
  return {
    ...attention,
    fetchedAt: new Date(attention.fetchedAt).toISOString(),
  };
}

/** A failure's fixed words: nothing Coolify echoed reaches the caller. */
function failureOf(err: unknown): { error: string; cause: string } {
  if (err instanceof ConnectionError) {
    return { error: err.message, cause: err.code };
  }
  return toRouteError(err).body;
}

/** When a deployment ended, or its last change when Coolify sent no end. */
function endedAt(row: QueueRow): number {
  return Date.parse(row.finishedAt ?? row.updatedAt ?? row.createdAt) || 0;
}

/**
 * Failures that are still their application's latest ended deployment (per
 * pull request, so a preview's failure isn't hidden by the main one) and
 * ended within RECENT_FAILURE_MS. `recent` is newest first.
 */
export function recentFailures(recent: QueueRow[], now: number): QueueRow[] {
  const latest = new Set<string>();
  const out: QueueRow[] = [];
  for (const row of recent) {
    const key = `${row.resourceUuid}\n${row.pullRequestId}`;
    if (latest.has(key)) continue;
    latest.add(key);
    const age = now - endedAt(row);
    if (isFailedDeployment(row.status) && age >= 0 && age < RECENT_FAILURE_MS) {
      out.push(row);
    }
  }
  return out;
}

function degradedOf(rows: ResourceDto[]): AttentionResource[] {
  return rows
    .filter((r) => !r.parentUuid && resourceHealth(r.status) === "degraded")
    .map((r) => ({
      uuid: r.uuid,
      name: r.name,
      kind: r.kind,
      status: r.status,
      serverName: r.serverName,
      projectName: r.projectName,
      environmentName: r.environmentName,
    }));
}

/**
 * Deployments in progress and attention items across every connection the
 * actor can view, for the sidebar panel, the rail badge and
 * coolify.attention. It makes no Coolify request of its own: each part comes
 * from a cache the tab already reads through (the deployment queue, 10
 * seconds; resources, 20 seconds; server statuses, a minute), so the panel,
 * the badge and the tab together cost one read per connection. Each of
 * those checks the actor's access first; a connection the actor lost access
 * to meanwhile is left out of the answer.
 */
export function createAttention(
  ctx: PluginContext,
  deps: {
    connections: Connections;
    resources: Resources;
    deployments: Deployments;
    servers: ServerStatuses;
    now?: () => number;
  },
) {
  const { connections, resources, deployments, servers } = deps;
  const now = deps.now ?? Date.now;

  async function one(
    view: Awaited<ReturnType<Connections["list"]>>[number],
    opts: { refresh?: boolean; signal?: AbortSignal },
  ): Promise<AttentionConnection | null> {
    opts.signal?.throwIfAborted();
    const [queue, rows, statuses] = await Promise.allSettled([
      deployments.queue(view.id, {
        refresh: opts.refresh,
        signal: opts.signal,
      }),
      resources.list(view.id, { refresh: opts.refresh }),
      servers.list(view.id),
    ]);
    opts.signal?.throwIfAborted();
    // Still the actor's to view once every part is in.
    if (!(await connections.access(view.id))) return null;
    const failed = [queue, rows, statuses].find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    return {
      id: view.id,
      name: view.name,
      access: view.access,
      scoped: view.scoped,
      running: queue.status === "fulfilled" ? queue.value.running : [],
      failed:
        queue.status === "fulfilled"
          ? recentFailures(queue.value.recent, now())
          : [],
      degraded: rows.status === "fulfilled" ? degradedOf(rows.value) : [],
      unreachable:
        statuses.status === "fulfilled"
          ? statuses.value
              .filter((s) => !s.reachable)
              .map((s) => ({ uuid: s.uuid, name: s.name }))
          : [],
      error: failed ? failureOf(failed.reason) : null,
    };
  }

  return {
    async read(
      opts: { refresh?: boolean; signal?: AbortSignal } = {},
    ): Promise<Attention> {
      if (!(await ctx.rbac.has("view"))) {
        throw new ConnectionError(
          "forbidden",
          "Coolify attention items need the View Coolify permission",
        );
      }
      const list = await connections.list();
      const read = await mapLimit(list, CONNECTION_CONCURRENCY, (view) =>
        one(view, opts),
      );
      const shown = read.filter((c): c is AttentionConnection => c !== null);
      const sum = (pick: (c: AttentionConnection) => unknown[]) =>
        shown.reduce((n, c) => n + pick(c).length, 0);
      const counts = {
        running: sum((c) => c.running),
        failed: sum((c) => c.failed),
        degraded: sum((c) => c.degraded),
        unreachable: sum((c) => c.unreachable),
      };
      return {
        connections: shown,
        counts,
        badge: counts.running + counts.failed,
        fetchedAt: now(),
      };
    },
  };
}

export type AttentionService = ReturnType<typeof createAttention>;
