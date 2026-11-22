import type { CoolifyApi } from "../coolify/api.js";
import type { SecurityStatus, VulnerabilityDto } from "../coolify/dto.js";
import { ConnectionError } from "../connections/service.js";
import {
  VULNERABILITIES_TTL_MS,
  type VulnerabilityStatuses,
  type VulnerabilitySummary,
} from "../../shared/dashboard.js";

/** The summary without its connection, as the cache keeps it. */
export type VulnerabilityCounts = Omit<
  VulnerabilitySummary,
  "connectionId" | "fetchedAt"
> & { fetchedAt: number };

const STATUS_KEY: Record<SecurityStatus, keyof VulnerabilityStatuses> = {
  update_now: "updateNow",
  update_available: "updateAvailable",
  no_fix: "noFix",
  check_needed: "checkNeeded",
  ok: "ok",
  not_checked: "notChecked",
};

/** Statuses that mean the resource has known problems. */
const AFFECTED = new Set<SecurityStatus>([
  "update_now",
  "update_available",
  "no_fix",
]);

/** Counts by status and by severity. Nothing Coolify wrote is kept. */
export function summarize(
  rows: VulnerabilityDto[],
  fetchedAt: number,
): VulnerabilityCounts {
  const statuses: VulnerabilityStatuses = {
    updateNow: 0,
    updateAvailable: 0,
    noFix: 0,
    checkNeeded: 0,
    ok: 0,
    notChecked: 0,
  };
  const problems = { total: 0, critical: 0, high: 0, medium: 0, exploited: 0 };
  let affected = 0;
  for (const row of rows) {
    statuses[STATUS_KEY[row.status]] += 1;
    if (AFFECTED.has(row.status)) affected += 1;
    problems.total += row.problems;
    problems.critical += row.critical;
    problems.high += row.high;
    problems.medium += row.medium;
    problems.exploited += row.exploited;
  }
  return { resources: rows.length, affected, statuses, problems, fetchedAt };
}

interface Cached {
  revision: string;
  value: VulnerabilityCounts;
}

/**
 * Coolify's vulnerability list per connection, kept VULNERABILITIES_TTL_MS
 * as counts (in memory, so a restart starts cold). A hit needs the
 * connection's current revision, readers that miss together share one read,
 * and a read is kept only when the revision it started under is still
 * current when it ends. The revision is checked right before the request
 * too. Nothing invalidates it: no plugin action changes a scan result. The
 * caller checks access.
 */
export function createVulnerabilityCache(deps: {
  revision: (connectionId: number) => Promise<string | null>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = new Map<number, Cached>();
  const inflight = new Map<string, Promise<VulnerabilityCounts>>();

  async function fetchCounts(
    connectionId: number,
    api: CoolifyApi,
    revision: string,
  ): Promise<VulnerabilityCounts> {
    const rows = await api.vulnerabilities({
      beforeFetch: async () => {
        if ((await deps.revision(connectionId)) !== revision) {
          throw new ConnectionError(
            "target-changed",
            "The connection's address, token or Access settings changed. Try again.",
          );
        }
      },
    });
    const value = summarize(rows, now());
    if ((await deps.revision(connectionId)) === revision) {
      cache.set(connectionId, { revision, value });
    }
    return value;
  }

  return {
    /** The counts for `revision`, cached or read through `api`. */
    async read(
      connectionId: number,
      revision: string,
      api: CoolifyApi,
      opts: { refresh?: boolean } = {},
    ): Promise<VulnerabilityCounts> {
      const hit = cache.get(connectionId);
      if (!opts.refresh && hit?.revision === revision) {
        const age = now() - hit.value.fetchedAt;
        if (age >= 0 && age < VULNERABILITIES_TTL_MS) return hit.value;
      }
      const key = `${connectionId}:${revision}`;
      const pending = inflight.get(key);
      if (pending) return pending;
      const started = fetchCounts(connectionId, api, revision).finally(() => {
        if (inflight.get(key) === started) inflight.delete(key);
      });
      inflight.set(key, started);
      return started;
    },
  };
}
