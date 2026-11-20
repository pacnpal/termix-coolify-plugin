import type {
  PluginContext,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { CompanionError } from "./detect.js";

// Calls into the companion plugins. Every call is one of their documented
// actions (docs.termix.site/plugins/<id>/reference), by the id and input names
// the reference gives, run with ctx.operations.invoke and listed in the
// manifest's operations.invokes. The references list no service methods, so
// no service is called. Each call sends only plain values the feature needs
// (never a token, key or password).
//
// The references don't describe what the actions answer. Answers are read in
// the operations convention (`{ rows }` for lists, `{ value, status, label }`
// for host status reads) and fields are picked by name; an answer with
// nothing usable is companion-failed.

/**
 * What the adapters reach companions through: only ctx.operations.invoke,
 * and `before`, run right before every call. The companions service's
 * `before` checks the connection's snapshot, so its refusal (a
 * ConnectionError) comes through as it is, not as companion-failed.
 */
export interface CompanionCaller {
  operations: Pick<PluginContext["operations"], "invoke">;
  before?: () => Promise<void>;
}

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * The first list among `keys` of an answer, or the answer when it is one.
 * An answer with no list it recognizes is companion-failed: "couldn't read"
 * is never reported as "none". An explicit empty list is empty.
 */
function listOf(value: unknown, keys: string[], plugin: string): unknown[] {
  if (Array.isArray(value)) return value;
  const raw = obj(value);
  for (const key of keys) {
    if (Array.isArray(raw[key])) return raw[key] as unknown[];
  }
  throw new CompanionError("companion-failed", plugin);
}

function first(raw: Raw, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

const FAILED_STATUS = /fail|error|denied|reject|cancel/i;

/**
 * Runs a companion's action. A throw, an error, a run waiting for approval or
 * a failed status is companion-failed; the companion's own message is never
 * passed on.
 */
async function invoke(
  ctx: CompanionCaller,
  actionId: string,
  plugin: string,
  options: { hostId?: number; input?: Record<string, unknown> },
  extra: { confirmed?: boolean } = {},
): Promise<unknown> {
  await ctx.before?.();
  let outcome: PluginOperationOutcome;
  try {
    outcome = await ctx.operations.invoke(actionId, { ...options, ...extra });
  } catch {
    throw new CompanionError("companion-failed", plugin);
  }
  if (
    !outcome ||
    outcome.error ||
    outcome.errorCode ||
    outcome.approvalId ||
    FAILED_STATUS.test(String(outcome.status ?? ""))
  ) {
    throw new CompanionError("companion-failed", plugin);
  }
  return outcome.data;
}

// --- DNS (dns.list-zones, dns.upsert-record, dns.delete-record) ---------

export type DnsType = "A" | "AAAA" | "CNAME";

/** The inputs dns.upsert-record and dns.delete-record share; kept to remove the record. */
export interface DnsRecordKey {
  zone: string;
  type: DnsType;
  name: string;
  content: string;
}

/**
 * The zone a name belongs to, from dns.list-zones: the zone whose name is
 * the longest suffix of `fqdn`. Answers its id (or its name, when the list
 * gives no id), or no-dns-zone.
 */
async function zoneFor(ctx: CompanionCaller, fqdn: string): Promise<string> {
  const data = await invoke(ctx, "dns.list-zones", "dns", {});
  let best: { value: string; length: number } | null = null;
  for (const entry of listOf(data, ["rows", "zones", "items"], "dns")) {
    const raw = obj(entry);
    const name = str(first(raw, ["name", "zone", "domain"]))
      ?.toLowerCase()
      .replace(/\.$/, "");
    if (!name || (fqdn !== name && !fqdn.endsWith(`.${name}`))) continue;
    const value = str(raw.id) ?? name;
    if (!best || name.length > best.length) {
      best = { value, length: name.length };
    }
  }
  if (!best) throw new CompanionError("no-dns-zone", "dns");
  return best.value;
}

/** What setting and removing a record take: its zone, type, name and content. */
export async function dnsKey(
  ctx: CompanionCaller,
  input: { fqdn: string; type: DnsType; content: string },
): Promise<DnsRecordKey> {
  return {
    zone: await zoneFor(ctx, input.fqdn),
    type: input.type,
    name: input.fqdn,
    content: input.content,
  };
}

/** Sets a record with dns.upsert-record. */
export async function dnsUpsert(
  ctx: CompanionCaller,
  key: DnsRecordKey,
): Promise<void> {
  await invoke(ctx, "dns.upsert-record", "dns", { input: { ...key } });
}

/**
 * Deletes a record made here with dns.delete-record. The action is
 * destructive; the person asked for this removal.
 */
export async function dnsRemove(
  ctx: CompanionCaller,
  key: DnsRecordKey,
): Promise<void> {
  await invoke(
    ctx,
    "dns.delete-record",
    "dns",
    {
      input: {
        zone: key.zone,
        type: key.type,
        name: key.name,
        content: key.content,
      },
    },
    { confirmed: true },
  );
}

// --- Uptime (uptime.monitors, uptime.pause, uptime.resume) --------------

export type MonitorStatus = "up" | "down" | "paused" | "pending" | "unknown";

export interface Monitor {
  id: string;
  name: string;
  url: string;
  status: MonitorStatus;
}

function monitorStatus(value: unknown): MonitorStatus {
  const text = String(value ?? "").toLowerCase();
  if (["up", "ok", "online", "healthy"].includes(text)) return "up";
  if (["down", "offline", "failing", "unhealthy", "fail"].includes(text)) {
    return "down";
  }
  if (["paused", "maintenance"].includes(text)) return "paused";
  if (text === "pending") return "pending";
  return "unknown";
}

/** Every monitor uptime.monitors lists. */
export async function uptimeMonitors(ctx: CompanionCaller): Promise<Monitor[]> {
  const data = await invoke(ctx, "uptime.monitors", "uptime", {});
  return listOf(data, ["rows", "monitors", "items"], "uptime").flatMap(
    (entry) => {
      const raw = obj(entry);
      const id = str(raw.id);
      const url = str(first(raw, ["url", "target", "address"]));
      if (!id || !url) return [];
      return [
        {
          id,
          name: str(raw.name) ?? url,
          url,
          status: monitorStatus(first(raw, ["status", "state"])),
        },
      ];
    },
  );
}

/** Pauses or resumes one monitor; both actions take `monitor`. */
export async function uptimeSetPaused(
  ctx: CompanionCaller,
  monitor: string,
  paused: boolean,
): Promise<void> {
  await invoke(ctx, paused ? "uptime.pause" : "uptime.resume", "uptime", {
    input: { monitor },
  });
}

// --- Log Search (log-search.search) ------------------------------------

export interface LogLine {
  time: string | null;
  host: string | null;
  container: string | null;
  message: string;
}

const MAX_LINES = 200;
const MAX_LINE = 2000;

/** log-search.search over Docker logs, with `query`, `source` and `limit`. */
export async function logSearch(
  ctx: CompanionCaller,
  query: string,
): Promise<LogLine[]> {
  const data = await invoke(ctx, "log-search.search", "log-search", {
    input: { source: "docker", query, limit: MAX_LINES },
  });
  return listOf(data, ["results", "rows", "lines", "hits"], "log-search")
    .slice(0, MAX_LINES)
    .flatMap((entry) => {
      const raw = obj(entry);
      const message = str(first(raw, ["message", "line", "text"]));
      if (message === null) return [];
      return [
        {
          time: str(first(raw, ["time", "timestamp", "ts"])),
          host: str(first(raw, ["host", "hostName"])),
          container: str(first(raw, ["container", "containerName"])),
          message: message.slice(0, MAX_LINE),
        },
      ];
    });
}

// --- Security Center (security-center.status, .critical-vulns) ----------

export interface SecuritySummary {
  score: number | null;
  critical: number | null;
}

/** A host status read's number: its `value`, or a named field. */
function valueOf(data: unknown, keys: string[]): number | null {
  const raw = obj(data);
  return num(raw.value) ?? num(first(raw, keys));
}

/** The Linked host's security score and critical vulnerability count. */
export async function securityCheck(
  ctx: CompanionCaller,
  hostId: number,
): Promise<SecuritySummary> {
  const status = await invoke(
    ctx,
    "security-center.status",
    "security-center",
    {
      hostId,
    },
  );
  const critical = await invoke(
    ctx,
    "security-center.critical-vulns",
    "security-center",
    { hostId },
  );
  return {
    score: valueOf(status, ["score"]),
    critical:
      valueOf(critical, ["critical", "count"]) ??
      (Array.isArray(obj(critical).rows)
        ? (obj(critical).rows as unknown[]).length
        : null),
  };
}

// --- Databases (databases.list-connections) ----------------------------

/** A saved login, without its password or any other secret. */
export interface SavedLogin {
  id: string | number;
  name: string | null;
  engine: string | null;
  database: string | null;
  username: string | null;
}

/** The saved logins databases.list-connections lists for one host. */
export async function databaseLogins(
  ctx: CompanionCaller,
  hostId: number,
): Promise<SavedLogin[]> {
  const data = await invoke(ctx, "databases.list-connections", "databases", {
    hostId,
  });
  return listOf(
    data,
    ["rows", "logins", "connections", "items"],
    "databases",
  ).flatMap((entry) => {
    const raw = obj(entry);
    const id =
      typeof raw.id === "number" && Number.isFinite(raw.id)
        ? raw.id
        : str(raw.id);
    // A row for another host is not this host's, whatever was answered.
    const other = num(raw.hostId);
    if (id === null || (other !== null && other !== hostId)) return [];
    return [
      {
        id,
        name: str(raw.name),
        engine: str(first(raw, ["engine", "type"])),
        database: str(first(raw, ["database", "databaseName"])),
        username: str(first(raw, ["username", "user"])),
      },
    ];
  });
}

// --- Backups (backups.failed) ------------------------------------------

export interface FailedBackup {
  id: string;
  name: string;
  failedAt: string | null;
}

/** Failed Termix backup jobs for one host, from backups.failed. */
export async function backupsFailed(
  ctx: CompanionCaller,
  hostId: number,
): Promise<FailedBackup[]> {
  const data = await invoke(ctx, "backups.failed", "backups", { hostId });
  return listOf(data, ["rows", "jobs", "failed", "items"], "backups").flatMap(
    (entry) => {
      const raw = obj(entry);
      const id = str(raw.id);
      const other = num(raw.hostId);
      if (!id || (other !== null && other !== hostId)) return [];
      return [
        {
          id,
          name: str(first(raw, ["name", "title"])) ?? id,
          failedAt: str(first(raw, ["failedAt", "lastFailureAt", "at"])),
        },
      ];
    },
  );
}
