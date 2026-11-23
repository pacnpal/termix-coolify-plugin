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
 * How long before the last poll an unseen deployment's or run's end may be
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
}

/** What one poll read, already reduced to what diffing needs. */
export interface PollRead {
  resources: ResourceDto[];
  deployments: QueueRow[];
  servers: ServerStatus[];
  /** Null when backups and tasks weren't due this poll. */
  runs: PolledRun[] | null;
}

/** What the poller remembers of a connection between polls. */
export interface SeenState {
  /** When the poll that recorded this read Coolify, in epoch ms. */
  readAt: number;
  /** Deployment uuid to its status. */
  deployments: Map<string, string>;
  /** Top-level resource uuid to its last settled health (never deploying). */
  health: Map<string, ResourceHealth>;
  /** Server uuid to whether Coolify could reach it. */
  reachable: Map<string, boolean>;
  /** Backup and task runs, `<type>:<uuid>` to status; null before the first read. */
  runs: Map<string, string> | null;
  /** When backups and tasks were last read. */
  runsReadAt: number;
}

/** When `value` was, in epoch ms, or NaN. */
function timeOf(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

/** Whether an unseen thing that ended at `ended` ended after the last poll. */
function endedSince(ended: number, lastReadAt: number): boolean {
  return Number.isFinite(ended) && ended >= lastReadAt - CLOCK_SLACK_MS;
}

function diffDeployments(
  prev: SeenState | null,
  rows: QueueRow[],
  serverOf: (uuid: string) => string | null,
): { events: SourceEvent[]; seen: Map<string, string> } {
  const seen = new Map<string, string>();
  const events: SourceEvent[] = [];
  for (const row of rows) {
    seen.set(row.uuid, row.status);
    if (!prev || !isFinalDeployment(row.status)) continue;
    const before = prev.deployments.get(row.uuid);
    const ended = timeOf(row.finishedAt ?? row.updatedAt);
    const isNew =
      before === undefined
        ? endedSince(ended, prev.readAt)
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
 * service), by health: a deploy's passing states (starting, building) are
 * no change, so running, deploying, running is nothing. A change into
 * `restarting` is a container restart; any other is a status change.
 */
function diffStatuses(
  prev: SeenState | null,
  resources: ResourceDto[],
  at: number,
): { events: SourceEvent[]; seen: Map<string, ResourceHealth> } {
  const seen = new Map<string, ResourceHealth>();
  const events: SourceEvent[] = [];
  for (const r of resources) {
    if (r.parentUuid) continue;
    const health = resourceHealth(r.status);
    const before = prev?.health.get(r.uuid);
    if (health === "deploying") {
      if (before) seen.set(r.uuid, before);
      continue;
    }
    seen.set(r.uuid, health);
    if (!before || before === health) continue;
    const state = r.status.trim().toLowerCase().split(":")[0];
    events.push({
      kind: state === "restarting" ? "container-restarted" : "status-changed",
      source: "poll",
      resourceUuid: r.uuid,
      serverUuid: r.serverUuid,
      name: r.name,
      status: r.status,
      at,
      fields: { from: before, to: health },
    });
  }
  return { events, seen };
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

/** Backup and task runs that ended since the last read of them. */
function diffRuns(
  prev: SeenState | null,
  runs: PolledRun[],
): { events: SourceEvent[]; seen: Map<string, string> } {
  const seen = new Map<string, string>();
  const events: SourceEvent[] = [];
  const before = prev?.runs ?? null;
  for (const run of runs) {
    const key = `${run.type}:${run.uuid}`;
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
 */
export function diffPoll(
  prev: SeenState | null,
  read: PollRead,
  at: number,
): { events: SourceEvent[]; next: SeenState } {
  const servers = new Map(read.resources.map((r) => [r.uuid, r.serverUuid]));
  const deployments = diffDeployments(
    prev,
    read.deployments,
    (uuid) => servers.get(uuid) ?? null,
  );
  const statuses = diffStatuses(prev, read.resources, at);
  const reach = diffServers(prev, read.servers, at);
  const runs = read.runs ? diffRuns(prev, read.runs) : null;
  return {
    events: [
      ...deployments.events,
      ...statuses.events,
      ...reach.events,
      ...(runs?.events ?? []),
    ],
    next: {
      readAt: at,
      deployments: deployments.seen,
      health: statuses.seen,
      reachable: reach.seen,
      runs: runs ? runs.seen : (prev?.runs ?? null),
      runsReadAt: runs ? at : (prev?.runsReadAt ?? 0),
    },
  };
}
