import type {
  PluginContext,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { CompanionError, missing } from "./detect.js";

// Calls into the companion plugins. Each one asks for the service or action
// at the time of the call (a companion can stop at any time), sends only plain
// values the feature needs (never a token, key or password), and picks the
// fields it returns by name, the way the Coolify DTOs do.
//
// The service and action shapes follow the design's "Companion plugins"
// section. Answers are read loosely, since those plugins are not released yet.

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

/** The first list among `keys` of an answer, or the answer when it is one. */
function listOf(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const raw = obj(value);
  for (const key of keys) {
    if (Array.isArray(raw[key])) return raw[key] as unknown[];
  }
  return [];
}

function first(raw: Raw, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

/**
 * Another plugin's service, or companion-missing when it isn't offered or
 * lacks `method`. A missing provider reads as an empty handle.
 */
async function service(
  ctx: PluginContext,
  name: string,
  method: string,
  plugin: string,
): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  let handle: unknown;
  try {
    handle = await ctx.services.get<object>(name);
  } catch {
    throw missing(plugin);
  }
  const usable =
    !!handle &&
    (typeof handle === "object" || typeof handle === "function") &&
    method in (handle as object);
  if (!usable) throw missing(plugin);
  return handle as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

/** Runs a companion call; any failure of its own is companion-failed. */
async function attempt<T>(plugin: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof CompanionError) throw err;
    throw new CompanionError("companion-failed", plugin);
  }
}

const FAILED_STATUS = /fail|error|denied|reject|cancel/i;

/** Runs another plugin's action, listed in the manifest's operations.invokes. */
async function invoke(
  ctx: PluginContext,
  actionId: string,
  plugin: string,
  options: { hostId?: number; input?: Record<string, unknown> },
): Promise<unknown> {
  const outcome: PluginOperationOutcome = await attempt(plugin, () =>
    ctx.operations.invoke(actionId, options),
  );
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

// --- DNS ---------------------------------------------------------------

export type DnsType = "A" | "AAAA" | "CNAME";

export interface DnsRecordInput {
  fqdn: string;
  type: DnsType;
  content: string;
}

/** Creates a record through dns.records; answers the DNS plugin's handle. */
export async function dnsCreate(
  ctx: PluginContext,
  input: DnsRecordInput,
): Promise<unknown> {
  const dns = await service(ctx, "dns.records", "setRecord", "dns");
  if (!("findZone" in dns)) throw missing("dns");
  const zone = obj(await attempt("dns", () => dns.findZone(input.fqdn)));
  const zoneId = str(first(zone, ["id", "zoneId"]));
  if (!zoneId) throw new CompanionError("no-dns-zone", "dns");
  const handle = await attempt("dns", () =>
    dns.setRecord({
      zone: zoneId,
      name: input.fqdn,
      type: input.type,
      content: input.content,
    }),
  );
  if (handle === undefined || handle === null) {
    throw new CompanionError("companion-failed", "dns");
  }
  return handle;
}

/** Removes a record by the handle the DNS plugin gave when it was made. */
export async function dnsRemove(
  ctx: PluginContext,
  handle: unknown,
): Promise<void> {
  const dns = await service(ctx, "dns.records", "deleteRecord", "dns");
  await attempt("dns", () => dns.deleteRecord(handle));
}

// --- Uptime ------------------------------------------------------------

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
  if (["down", "offline", "failing", "unhealthy"].includes(text)) {
    return "down";
  }
  if (["paused", "maintenance"].includes(text)) return "paused";
  if (text === "pending") return "pending";
  return "unknown";
}

/** Every monitor uptime.access.summary() reports. */
export async function uptimeMonitors(ctx: PluginContext): Promise<Monitor[]> {
  const uptime = await service(ctx, "uptime.access", "summary", "uptime");
  const answer = await attempt("uptime", () => uptime.summary());
  return listOf(answer, ["monitors", "items", "rows"]).flatMap((entry) => {
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
  });
}

/** Pauses or resumes one monitor through the uptime.pause/resume actions. */
export async function uptimeSetPaused(
  ctx: PluginContext,
  monitorId: string,
  paused: boolean,
): Promise<void> {
  await invoke(ctx, paused ? "uptime.pause" : "uptime.resume", "uptime", {
    input: { monitorId },
  });
}

// --- Log Search --------------------------------------------------------

export interface LogLine {
  time: string | null;
  host: string | null;
  container: string | null;
  message: string;
}

const MAX_LINES = 200;
const MAX_LINE = 2000;

/** Runs log-search.search over Docker logs for one query. */
export async function logSearch(
  ctx: PluginContext,
  query: string,
): Promise<LogLine[]> {
  const data = await invoke(ctx, "log-search.search", "log-search", {
    input: { source: "docker", query },
  });
  return listOf(data, ["results", "lines", "rows", "hits"])
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

// --- Security Center ---------------------------------------------------

export interface SecuritySummary {
  score: number | null;
  critical: number | null;
  checkedAt: string | null;
}

/** security-center.access.check(hostId): the score and critical findings. */
export async function securityCheck(
  ctx: PluginContext,
  hostId: number,
): Promise<SecuritySummary> {
  const security = await service(
    ctx,
    "security-center.access",
    "check",
    "security-center",
  );
  const raw = obj(
    await attempt("security-center", () => security.check(hostId)),
  );
  return {
    score: num(raw.score),
    critical: num(
      first(raw, ["critical", "criticalVulnerabilities"]) ??
        obj(raw.vulnerabilities).critical,
    ),
    checkedAt: str(first(raw, ["checkedAt", "scannedAt", "at"])),
  };
}

// --- Databases ---------------------------------------------------------

/** A saved login, without its password or any other secret. */
export interface SavedLogin {
  id: string | number;
  hostId: number | null;
  name: string | null;
  engine: string | null;
  database: string | null;
  username: string | null;
}

/** The saved logins databases.logins.list() reports for one host. */
export async function databaseLogins(
  ctx: PluginContext,
  hostId: number,
): Promise<SavedLogin[]> {
  const logins = await service(ctx, "databases.logins", "list", "databases");
  const answer = await attempt("databases", () => logins.list({ hostId }));
  return listOf(answer, ["logins", "items", "rows"]).flatMap((entry) => {
    const raw = obj(entry);
    const id =
      typeof raw.id === "number" && Number.isFinite(raw.id)
        ? raw.id
        : str(raw.id);
    if (id === null) return [];
    const login: SavedLogin = {
      id,
      hostId: num(raw.hostId),
      name: str(raw.name),
      engine: str(first(raw, ["engine", "type"])),
      database: str(first(raw, ["database", "databaseName"])),
      username: str(first(raw, ["username", "user"])),
    };
    // Only this host's logins, whatever the plugin answered.
    return login.hostId === hostId ? [login] : [];
  });
}

// --- Backups -----------------------------------------------------------

export interface FailedBackup {
  id: string;
  name: string;
  failedAt: string | null;
}

/** Failed Termix backup jobs for one host, from the backups.failed action. */
export async function backupsFailed(
  ctx: PluginContext,
  hostId: number,
): Promise<FailedBackup[]> {
  const data = await invoke(ctx, "backups.failed", "backups", { hostId });
  return listOf(data, ["jobs", "failed", "rows", "items"]).flatMap((entry) => {
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
  });
}
