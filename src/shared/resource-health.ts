// One reading of a Coolify status, shared by the backend (counts, signals)
// and the frontend (tiles, badges, filters), so both always agree.
//
// Coolify reports a resource's status as "state" or "state:health", like
// "running:healthy", "exited:unhealthy" or "starting".

export type ResourceHealth = "running" | "degraded" | "stopped" | "deploying";

export const RESOURCE_HEALTHS: readonly ResourceHealth[] = [
  "running",
  "degraded",
  "stopped",
  "deploying",
];

export interface ResourceCounts {
  running: number;
  degraded: number;
  stopped: number;
  deploying: number;
}

const DEGRADED = new Set(["exited", "degraded", "restarting", "dead"]);
const DEPLOYING = new Set([
  "starting",
  "deploying",
  "building",
  "queued",
  "in_progress",
]);

/**
 * Exited and unhealthy count as degraded. Running (healthy or unknown) is
 * running. Starting and build states are deploying. Anything else, like
 * "stopped", "paused" or a missing status, is stopped.
 */
export function resourceHealth(
  status: string | null | undefined,
): ResourceHealth {
  const [state = "", health = ""] = String(status ?? "")
    .trim()
    .toLowerCase()
    .split(":");
  if (DEPLOYING.has(state)) return "deploying";
  if (DEGRADED.has(state) || health === "unhealthy") return "degraded";
  if (state === "running") return "running";
  return "stopped";
}

/**
 * Counts by health. Service Parts (rows with a parentUuid) are left out: their
 * service's own status already covers them.
 */
export function countResources(
  rows: readonly { status: string; parentUuid: string | null }[],
): ResourceCounts {
  const counts: ResourceCounts = {
    running: 0,
    degraded: 0,
    stopped: 0,
    deploying: 0,
  };
  for (const row of rows) {
    if (row.parentUuid) continue;
    counts[resourceHealth(row.status)] += 1;
  }
  return counts;
}
