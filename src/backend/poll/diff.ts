import type { ResourceDto, RunDto } from "../coolify/dto.js";
import type { QueueRow } from "../deployments/queue.js";
import type { SourceEvent } from "../events/service.js";
import type { ServerStatus } from "../ops/signals.js";
import {
  isFinalDeployment,
  isSuccessfulDeployment,
} from "../../shared/deployment-status.js";
import {
  resourceHealth,
  type ResourceHealth,
} from "../../shared/resource-health.js";

/**
 * How long before the last read an unseen deployment's or run's end may be
 * and still count as new. Coolify's clock and Termix's can differ; a
 * deployment that ended earlier than this, never seen, is older history (an
 * application that just entered the recent window), not a change.
 */
export const CLOCK_SLACK_MS = 5 * 60_000;

/** A backup or scheduled task run, with what it belongs to. */
export interface PolledRun extends RunDto {
  type: "backup" | "task";
  resource: ResourceDto;
  /** The scheduled task's name, for task runs. */
  task: string | null;
  /** The scheduled task's uuid, for task runs: the run's dedupe identity. */
  taskUuid: string | null;
}

/** The backup and task runs one poll read. */
export interface RunsRead {
  runs: PolledRun[];
  /**
   * Resources whose runs the token was refused: what was seen of them stays
   * as it was, and nothing about them is sent.
   */
  refused: Set<string>;
}

/**
 * What one poll read, already reduced to what diffing needs. A part that is
 * null was not read this poll (refused by the token's scope, or not due):
 * what was seen of it stays as it was, and it sends nothing.
 */
export interface PollRead {
  resources: ResourceDto[];
  deployments: QueueRow[] | null;
  servers: ServerStatus[] | null;
  runs: RunsRead | null;
}

/** What the poller remembers of a connection between polls. */
export interface SeenState {
  /** When the poll that recorded this read Coolify, in epoch ms. */
  readAt: number;
  /** Deployment uuid to its status. */
  deployments: Map<string, string>;
  /** When the deployments were last read (0: never). */
  deploymentsReadAt: number;
  /** Top-level resource uuid to its last settled health (never deploying). */
  health: Map<string, ResourceHealth>;
  /** Top-level resource uuid to Coolify's status word as last read. */
  statuses: Map<string, string>;
  /** Server uuid to whether Coolify could reach it. */
  reachable: Map<string, boolean>;
  /**
   * Backup and task runs, `<type>:<resource uuid>:<run uuid>` to status;
   * null before the first read.
   */
  runs: Map<string, string> | null;
  /** When backups and tasks were last read. */
  runsReadAt: number;
}

/** When `value` was, in epoch ms, or NaN. */
function timeOf(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

/** Whether an unseen thing that ended at `ended` ended after the last read. */
function endedSince(ended: number, lastReadAt: number): boolean {
  return Number.isFinite(ended) && ended >= lastReadAt - CLOCK_SLACK_MS;
}

/** The state part of a status word: "restarting" of "restarting:unhealthy". */
function stateOf(status: string): string {
  return status.trim().toLowerCase().split(":")[0] ?? "";
}

function diffDeployments(
  prev: SeenState | null,
  rows: QueueRow[],
  serverOf: (uuid: string) => string | null,
): { events: SourceEvent[]; seen: Map<string, string> } {
  const seen = new Map<string, string>();
  const events: SourceEvent[] = [];
  const lastRead = prev?.deploymentsReadAt ?? 0;
  for (const row of rows) {
    seen.set(row.uuid, row.status);
    // A baseline, or deployments never read before: nothing is news.
    if (!prev || !lastRead || !isFinalDeployment(row.status)) continue;
    const before = prev.deployments.get(row.uuid);
    const ended = timeOf(row.finishedAt ?? row.updatedAt);
    const isNew =
      before === undefined
        ? endedSince(ended, lastRead)
        : !isFinalDeployment(before);
    if (!isNew) continue;
    events.push({
      kind: isSuccessfulDeployment(row.status)
        ? "deployment-finished"
        : "deployment-failed",
      source: "poll",
      resourceUuid: row.resourceUuid,
      serverUuid: serverOf(row.resourceUuid),
      deploymentUuid: row.uuid,
      name: row.resourceName,
      status: row.status,
      at: Number.isFinite(ended) ? ended : null,
    });
  }
  return { events, seen };
}

/**
 * Status changes of top-level resources (Parts are covered by their
 * service). Entering `restarting` is a container restart, read from
 * Coolify's own word, so `running:unhealthy` to `restarting` counts though
 * both are degraded. Any other change compares health: a deploy's passing
 * states (starting, building) are no change, so running, deploying,
 * running is nothing.
 */
function diffStatuses(
  prev: SeenState | null,
  resources: ResourceDto[],
  at: number,
): {
  events: SourceEvent[];
  health: Map<string, ResourceHealth>;
  statuses: Map<string, string>;
} {
  const health = new Map<string, ResourceHealth>();
  const statuses = new Map<string, string>();
  const events: SourceEvent[] = [];
  for (const r of resources) {
    if (r.parentUuid) continue;
    statuses.set(r.uuid, r.status);
    const now = resourceHealth(r.status);
    const before = prev?.health.get(r.uuid);
    const beforeStatus = prev?.statuses.get(r.uuid);
    if (now === "deploying") {
      if (before) health.set(r.uuid, before);
      continue;
    }
    health.set(r.uuid, now);
    const event = {
      source: "poll" as const,
      resourceUuid: r.uuid,
      serverUuid: r.serverUuid,
      name: r.name,
      status: r.status,
      at,
    };
    const restarted =
      stateOf(r.status) === "restarting" &&
      beforeStatus !== undefined &&
      stateOf(beforeStatus) !== "restarting";
    if (restarted) {
      events.push({ ...event, kind: "container-restarted" });
    } else if (before && before !== now) {
      events.push({
        ...event,
        kind: "status-changed",
        fields: { from: before, to: now },
      });
    }
  }
  return { events, health, statuses };
}

/** A server Coolify could reach and now can't. */
function diffServers(
  prev: SeenState | null,
  servers: ServerStatus[],
  at: number,
): { events: SourceEvent[]; seen: Map<string, boolean> } {
  const seen = new Map<string, boolean>();
  const events: SourceEvent[] = [];
  for (const s of servers) {
    seen.set(s.uuid, s.reachable);
    if (prev?.reachable.get(s.uuid) === true && !s.reachable) {
      events.push({
        kind: "server-unreachable",
        source: "poll",
        serverUuid: s.uuid,
        name: s.name,
        status: "unreachable",
        at,
      });
    }
  }
  return { events, seen };
}

const RUN_DONE: Record<string, "succeeded" | "failed"> = {
  success: "succeeded",
  failed: "failed",
};

const runKey = (type: string, resourceUuid: string, uuid: string) =>
  `${type}:${resourceUuid}:${uuid}`;

/** Backup and task runs that ended since the last read of them. */
function diffRuns(
  prev: SeenState | null,
  read: RunsRead,
): { events: SourceEvent[]; seen: Map<string, string> } {
  const seen = new Map<string, string>();
  const events: SourceEvent[] = [];
  const before = prev?.runs ?? null;
  // A resource whose runs were refused keeps what was seen of them.
  for (const [key, status] of before ?? []) {
    if (read.refused.has(key.split(":")[1] ?? "")) seen.set(key, status);
  }
  for (const run of read.runs) {
    const key = runKey(run.type, run.resource.uuid, run.uuid);
    seen.set(key, run.status);
    const done = RUN_DONE[run.status];
    if (!before || !done) continue;
    const was = before.get(key);
    const ended = timeOf(run.at);
    const isNew =
      was === undefined
        ? endedSince(ended, prev!.runsReadAt)
        : RUN_DONE[was] === undefined;
    if (!isNew) continue;
    events.push({
      kind: `${run.type}-${done}`,
      source: "poll",
      resourceUuid: run.resource.uuid,
      serverUuid: run.resource.serverUuid,
      taskUuid: run.taskUuid,
      name: run.resource.name,
      status: run.status,
      at: Number.isFinite(ended) ? ended : null,
      fields: run.task ? { task: run.task } : null,
    });
  }
  return { events, seen };
}

/**
 * The events between what the poller last saw (`prev`, null for a
 * baseline) and what this poll read at `at`, and what to remember next. A
 * baseline records everything and emits nothing, so a first poll (after a
 * start, a repoint or a pause) never floods the log with what already was.
 * A part this poll didn't read keeps what was seen of it and sends nothing.
 */
export function diffPoll(
  prev: SeenState | null,
  read: PollRead,
  at: number,
): { events: SourceEvent[]; next: SeenState } {
  const servers = new Map(read.resources.map((r) => [r.uuid, r.serverUuid]));
  const deployments = read.deployments
    ? diffDeployments(
        prev,
        read.deployments,
        (uuid) => servers.get(uuid) ?? null,
      )
    : null;
  const statuses = diffStatuses(prev, read.resources, at);
  const reach = read.servers ? diffServers(prev, read.servers, at) : null;
  const runs = read.runs ? diffRuns(prev, read.runs) : null;
  return {
    events: [
      ...(deployments?.events ?? []),
      ...statuses.events,
      ...(reach?.events ?? []),
      ...(runs?.events ?? []),
    ],
    next: {
      readAt: at,
      deployments: deployments?.seen ?? prev?.deployments ?? new Map(),
      deploymentsReadAt: deployments ? at : (prev?.deploymentsReadAt ?? 0),
      health: statuses.health,
      statuses: statuses.statuses,
      reachable: reach?.seen ?? prev?.reachable ?? new Map(),
      runs: runs ? runs.seen : (prev?.runs ?? null),
      runsReadAt: runs ? at : (prev?.runsReadAt ?? 0),
    },
  };
}
