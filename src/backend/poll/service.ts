import { randomUUID } from "node:crypto";
import { and, inArray, isNotNull } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { CoolifyApi } from "../coolify/api.js";
import type { ResourceDto, RunDto } from "../coolify/dto.js";
import { CoolifyError } from "../coolify/http.js";
import {
  ConnectionError,
  type Connections,
  type PollTarget,
} from "../connections/service.js";
import { dbClient, type Tables } from "../db.js";
import { mapLimit } from "../deployments/queue.js";
import type { Deployments } from "../deployments/service.js";
import type { Events } from "../events/service.js";
import type { ServerStatuses } from "../ops/signals.js";
import type { Resources } from "../resources/service.js";
import {
  diffPoll,
  type PollRead,
  type PolledRun,
  type RunsRead,
  type SeenState,
} from "./diff.js";

/** The poll's id, listed in the manifest's sandbox.schedules. */
export const POLL_ID = "coolify-poll";
/** How often the poll runs; a connection polls at most this often. */
export const POLL_MS = 60_000;
const POLL_JITTER_MS = 10_000;
/** Backups and scheduled tasks are read at most this often. */
export const SLOW_POLL_MS = 5 * 60_000;
/** Waits after 1, 2, 3 and 4 or more failed polls in a row. */
export const POLL_BACKOFF_MS = [1, 2, 5, 15].map((m) => m * 60_000);
/** The reason given to ctx.schedule.keepAwake while a connection polls. */
export const POLL_AWAKE_REASON = "coolify polling";
/** Applications and services whose scheduled tasks one poll reads. */
const TASK_RESOURCES_MAX = 50;
/** Scheduled tasks whose runs one poll reads. */
const TASKS_MAX = 50;
/** Coolify requests one poll makes at the same time. */
const CONCURRENCY = 4;

export interface PollerDeps {
  tables: Tables;
  connections: Connections;
  resources: Resources;
  deployments: Deployments;
  servers: ServerStatuses;
  events: Pick<Events, "ingest">;
  /** The clock, in epoch milliseconds; tests pass a fake one. */
  now?: () => number;
}

/** When a connection may poll next, and why its last poll failed. */
interface Timing {
  failures: number;
  nextAt: number;
  /** The last failure's cause (a CoolifyCause), or null. */
  error: string | null;
}

/** What the poller remembers, and the revision and generation it is for. */
interface Remembered extends SeenState {
  revision: string;
  generation: string;
}

type Snapshot = NonNullable<
  Awaited<ReturnType<Connections["unattendedSnapshot"]>>
>;

const targetChanged = () =>
  new ConnectionError(
    "target-changed",
    "The connection's address, token or Access settings changed.",
  );

/** The cause id a failed poll shows on the connection. */
function causeOf(err: unknown): string {
  return err instanceof CoolifyError ? err.cause : "upstream";
}

/** Whether Coolify refused the read for the token's scope or abilities. */
function refused(err: unknown): boolean {
  return err instanceof CoolifyError && err.cause === "forbidden-ability";
}

/**
 * A read the token's scope may legitimately be refused: null when it is
 * (that part counts as unread this poll, unchanged), its answer otherwise.
 * Every other error fails the poll.
 */
async function unlessRefused<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (refused(err)) return null;
    throw err;
  }
}

/**
 * One resource's backup, task or task-run list: empty when the resource
 * is gone (not-found), null when the token is refused it, the list
 * otherwise. Every other error fails the poll.
 */
async function resourceList<T>(read: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof CoolifyError && err.cause === "not-found") return [];
    if (refused(err)) return null;
    throw err;
  }
}

/**
 * The poller (design: "Alerts and live events" → Polling). Every minute or
 * more, it reads each polling connection's resources, deployment queue and
 * server statuses (and its backups and scheduled tasks every five minutes)
 * through the connection's own unattended snapshot and token, diffs them
 * against what it saw last, and hands each change to the event pipeline
 * with the revision it read under. It only reads Coolify.
 *
 * What it saw is kept in memory per connection with the revision and a
 * per-instance generation (`<epoch>:<n>`), like the caches: a repoint, a
 * pause or a restart makes the next poll a baseline, which records what is
 * there and emits nothing. Each poll checks the revision before each
 * request and once more before it diffs; a change drops the whole read.
 */
export function createPoller(ctx: PluginContext, deps: PollerDeps) {
  const { connections } = deps;
  const now = deps.now ?? (() => Date.now());
  const epoch = randomUUID();
  const generations = new Map<number, number>();
  const generationOf = (id: number) => `${epoch}:${generations.get(id) ?? 0}`;
  const seen = new Map<number, Remembered>();
  const timing = new Map<number, Timing>();
  let awake: boolean | null = null;
  // keepAwake reads run one after another, so the last one asked (with the
  // newest list) is the one that sticks.
  let awakeChain: Promise<unknown> = Promise.resolve();
  let running: Promise<void> | null = null;

  /** Drops what was seen: the connection's next poll is a baseline. */
  function forget(id: number): void {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    seen.delete(id);
  }

  async function intervalMs(): Promise<number> {
    const seconds = Number(await ctx.settings.get("minPollSeconds"));
    return Number.isFinite(seconds)
      ? Math.max(POLL_MS, seconds * 1000)
      : POLL_MS;
  }

  /** The team keys whose webhook has delivered at least once (#91 sets it). */
  async function delivered(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const t = deps.tables.webhooks;
    const db = await dbClient(ctx);
    const rows = (await db
      .select({ instanceKey: t.instanceKey })
      .from(t)
      .where(
        and(inArray(t.instanceKey, keys), isNotNull(t.lastReceivedAt)),
      )) as { instanceKey: string }[];
    return new Set(rows.map((r) => r.instanceKey));
  }

  /**
   * The connections that poll now. A connection polls by default; once its
   * team's webhook has delivered, it polls only with pollEnabled. Never while
   * the admin turned polling off, and never for an owner without
   * coolify.view: the poll would use a token its owner couldn't use.
   */
  async function polling(): Promise<PollTarget[]> {
    if ((await ctx.settings.get("allowPolling")) === false) return [];
    const targets = await connections.pollTargets();
    const keys = [
      ...new Set(
        targets.map((t) => t.instanceKey).filter((k): k is string => !!k),
      ),
    ];
    const webhooked = await delivered(keys);
    const out: PollTarget[] = [];
    for (const t of targets) {
      if (t.instanceKey && webhooked.has(t.instanceKey) && !t.pollEnabled) {
        continue;
      }
      if (await ctx.rbac.hasFor(t.userId, "view")) out.push(t);
    }
    return out;
  }

  /** keepAwake follows whether any connection polls. */
  function syncAwake(): Promise<PollTarget[]> {
    const read = async () => {
      const active = await polling();
      const on = active.length > 0;
      if (awake !== on) {
        ctx.schedule.keepAwake?.(POLL_AWAKE_REASON, on);
        awake = on;
      }
      return active;
    };
    const run = awakeChain.then(read, read);
    awakeChain = run.catch(() => undefined);
    return run;
  }

  /** The connection still points where `revision` says, and nothing reset it. */
  async function holds(
    id: number,
    revision: string,
    generation: string,
  ): Promise<boolean> {
    if (generationOf(id) !== generation) return false;
    return (await connections.unattendedSnapshot(id))?.revision === revision;
  }

  /**
   * Backup runs of each database, and runs of each scheduled task. A
   * resource the token is refused any of these for is in `refused`: what
   * was seen of its runs stays, and nothing about them is sent.
   */
  async function readRuns(
    api: CoolifyApi,
    resources: ResourceDto[],
    guard: () => Promise<void>,
  ): Promise<RunsRead> {
    const opts = { beforeFetch: guard };
    const refusedFor = new Set<string>();
    const listOf = async <T>(owner: ResourceDto, read: () => Promise<T[]>) => {
      const found = await resourceList(read);
      if (found === null) refusedFor.add(owner.uuid);
      return found ?? [];
    };
    const kindOf = (r: ResourceDto) => r.kind as "application" | "service";
    const databases = resources.filter((r) => r.kind === "database");
    const backups = await mapLimit(databases, CONCURRENCY, async (db) =>
      (await listOf(db, () => api.backupRuns(db.uuid, opts))).map(
        (run): PolledRun => ({
          ...run,
          type: "backup",
          resource: db,
          task: null,
          taskUuid: null,
        }),
      ),
    );
    const owners = resources
      .filter((r) => r.kind === "application" || r.kind === "service")
      .slice(0, TASK_RESOURCES_MAX);
    const tasks = (
      await mapLimit(owners, CONCURRENCY, async (owner) =>
        (
          await listOf(owner, () =>
            api.scheduledTasks(kindOf(owner), owner.uuid, opts),
          )
        )
          .filter((task) => task.enabled && task.uuid)
          .map((task) => ({ owner, task })),
      )
    )
      .flat()
      .slice(0, TASKS_MAX);
    const taskRuns = await mapLimit(
      tasks,
      CONCURRENCY,
      async ({ owner, task }) =>
        (
          await listOf<RunDto>(owner, () =>
            api.taskRuns(kindOf(owner), owner.uuid, task.uuid, opts),
          )
        ).map((run): PolledRun => ({
          ...run,
          type: "task",
          resource: owner,
          task: task.name || null,
          taskUuid: task.uuid,
        })),
    );
    return {
      runs: [...backups.flat(), ...taskRuns.flat()].filter((r) => r.uuid),
      refused: refusedFor,
    };
  }

  /** Everything one poll reads, each request checking the revision first. */
  async function read(
    id: number,
    snap: Snapshot,
    generation: string,
    withRuns: boolean,
  ): Promise<PollRead> {
    const guard = async () => {
      if (!(await holds(id, snap.revision, generation))) throw targetChanged();
    };
    const resources = (await deps.resources.readUnattended(id, snap)).rows;
    await guard();
    // The queue and its history: a refusal leaves deployments unread.
    const queue = await unlessRefused(() =>
      deps.deployments.queueUnattended(id, snap, resources),
    );
    await guard();
    // A scoped token is always refused /servers (the probe found it so):
    // not asked. An unscoped one refused counts as unread too.
    const servers = snap.scoped
      ? null
      : await unlessRefused(() => deps.servers.listUnattended(id, snap));
    await guard();
    const runs = withRuns
      ? await readRuns(await snap.api(), resources, guard)
      : null;
    return {
      resources,
      deployments: queue ? [...queue.running, ...queue.recent] : null,
      servers,
      runs,
    };
  }

  function failed(id: number, at: number, err: unknown): void {
    const failures = (timing.get(id)?.failures ?? 0) + 1;
    const wait =
      POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length) - 1];
    timing.set(id, { failures, nextAt: at + wait, error: causeOf(err) });
    // Only the error's name: a message could carry something from Coolify.
    ctx.log.warn(
      `coolify poll failed for connection ${id}: ${(err as Error)?.name ?? "error"}`,
    );
  }

  /**
   * One connection's poll. Step order: its backoff, the unattended
   * snapshot, the owner's coolify.view, the reads (the revision checked
   * before each request), the last revision check, the diff, one ingest
   * per change (each with the read's revision), the revision once more, and
   * only then what it saw is kept. A target change anywhere keeps nothing.
   */
  async function pollOne(id: number, at: number, every: number): Promise<void> {
    const due = timing.get(id);
    if (due && at < due.nextAt) return;
    const snap = await connections.unattendedSnapshot(id);
    if (!snap) {
      forget(id);
      timing.delete(id);
      return;
    }
    if (!(await ctx.rbac.hasFor(snap.userId, "view"))) {
      forget(id);
      return;
    }
    const generation = generationOf(id);
    const kept = seen.get(id);
    const prev =
      kept && kept.revision === snap.revision && kept.generation === generation
        ? kept
        : null;
    const withRuns = !prev?.runs || at - prev.runsReadAt >= SLOW_POLL_MS;
    try {
      const polled = await read(id, snap, generation, withRuns);
      if (!(await holds(id, snap.revision, generation))) throw targetChanged();
      const { events, next } = diffPoll(prev, polled, at);
      for (const event of events) {
        const result = await deps.events.ingest(id, event, {
          revision: snap.revision,
        });
        if (result.outcome === "dropped" && result.reason !== "invalid") {
          // The connection moved, went or lost its owner's access meanwhile.
          forget(id);
          return;
        }
      }
      if (!(await holds(id, snap.revision, generation))) throw targetChanged();
      seen.set(id, { ...next, revision: snap.revision, generation });
      // A tick may come a little early (jitter): it still counts.
      timing.set(id, {
        failures: 0,
        nextAt: at + every - POLL_JITTER_MS,
        error: null,
      });
    } catch (err) {
      if (err instanceof ConnectionError && err.code === "target-changed") {
        // Not Coolify failing: the next poll starts again from a baseline.
        forget(id);
        return;
      }
      // The wait counts from the failure, however long the poll took.
      failed(id, now(), err);
    }
  }

  async function tickNow(): Promise<void> {
    const active = await syncAwake();
    const ids = new Set(active.map((t) => t.id));
    // A connection that stopped polling starts from a baseline when it
    // polls again, and shows no old error.
    for (const id of [...seen.keys()]) if (!ids.has(id)) forget(id);
    for (const id of [...timing.keys()]) if (!ids.has(id)) timing.delete(id);
    const at = now();
    const every = await intervalMs();
    for (const target of active) await pollOne(target.id, at, every);
  }

  /** The scheduled job: one poll of every polling connection. Never throws. */
  async function tick(): Promise<void> {
    if (running) return running;
    running = tickNow()
      .catch((err) => {
        ctx.log.warn(`coolify poll failed: ${(err as Error)?.name ?? "error"}`);
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    tick,
    syncAwake,

    /** The cause of the connection's last failed poll, or null. */
    lastError(id: number): string | null {
      return timing.get(id)?.error ?? null;
    },

    /**
     * A connection was created or removed, or its poll setting changed:
     * its next poll is a baseline, and keepAwake is read again.
     */
    async changed(id: number): Promise<void> {
      forget(id);
      timing.delete(id);
      await syncAwake();
    },

    /** Starts the job and tells core whether anything polls. */
    async start(): Promise<void> {
      ctx.schedule.every(POLL_MS, tick, {
        id: POLL_ID,
        jitterMs: POLL_JITTER_MS,
      });
      await syncAwake();
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;
