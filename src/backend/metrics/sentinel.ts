import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";
import { dockerPrefix } from "../containers/commands.js";
import type { SshRunner } from "../ssh.js";

/**
 * Every Sentinel path the plugin may ask for: under /api/, and only
 * characters that can't break out of the URL or the quoted shell word. The
 * colon is there for Sentinel's ISO timestamps (from=2026-11-19T10:00:00Z).
 */
const SENTINEL_PATH = /^\/api\/[A-Za-z0-9_/.\-?=&:]+$/;

/**
 * A uuid as one path segment: letters and digits only. Coolify's uuids are
 * like that, and nothing else may reach a Sentinel path.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9]{1,64}$/;

export const TRAFFIC_VIEWS = [
  "overview",
  "paths",
  "series",
  "breakdown",
] as const;
export type TrafficView = (typeof TRAFFIC_VIEWS)[number];

/** The breakdown dimensions Sentinel serves (its own list). */
export const TRAFFIC_DIMENSIONS = [
  "status",
  "method",
  "country",
  "city",
  "referer",
  "browser",
  "os",
  "device",
  "protocol",
  "scheme",
  "tls",
  "cache",
  "bot",
  "agent",
  "ip",
  "useragent",
] as const;
export type TrafficDimension = (typeof TRAFFIC_DIMENSIONS)[number];

export const TRAFFIC_RANGES = ["24h", "7d", "30d"] as const;
export type TrafficRange = (typeof TRAFFIC_RANGES)[number];

const RANGE_MS: Record<TrafficRange, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

export type SentinelErrorCode = "bad-path" | "sentinel-failed";

/** A refused path, or Sentinel not answering. Never carries its output. */
export class SentinelError extends Error {
  readonly code: SentinelErrorCode;

  constructor(code: SentinelErrorCode, message: string) {
    super(message);
    this.name = "SentinelError";
    this.code = code;
  }
}

export function isSentinelPath(path: string): boolean {
  return SENTINEL_PATH.test(path) && !path.includes("..");
}

export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value);
}

function segment(value: string): string {
  if (!isSafeSegment(value)) {
    throw new SentinelError("bad-path", "Not a Coolify uuid");
  }
  return value;
}

/** Sentinel's timestamp format: ISO 8601 UTC to the second. */
export function isoSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface HistoryWindow {
  from: Date;
  to: Date;
  bucketMs: number;
}

function historyQuery(window: HistoryWindow): string {
  const bucket = Math.max(1, Math.floor(window.bucketMs));
  return `from=${isoSecond(window.from)}&to=${isoSecond(window.to)}&bucket_ms=${bucket}`;
}

/** A container's CPU or memory history, the paths Coolify's own client uses. */
export function containerHistoryPath(
  uuid: string,
  metric: "cpu" | "memory",
  window: HistoryWindow,
): string {
  return `/api/container/${segment(uuid)}/${metric}/history?${historyQuery(window)}`;
}

/** The server's own CPU or memory history. */
export function serverHistoryPath(
  metric: "cpu" | "memory",
  window: HistoryWindow,
): string {
  return `/api/${metric}/history?${historyQuery(window)}`;
}

export const SUMMARY_PATH = "/api/summary";

export interface TrafficQuery {
  view: TrafficView;
  dim?: TrafficDimension;
  range: TrafficRange;
  /** Rows for paths and breakdowns, 1 to 1000. */
  limit?: number;
}

/** One resource's traffic, from Sentinel's resource scope. */
export function trafficPath(
  uuid: string,
  query: TrafficQuery,
  now: Date,
): string {
  const base = `/api/resource/${segment(uuid)}/traffic`;
  if (!(TRAFFIC_RANGES as readonly string[]).includes(query.range)) {
    throw new SentinelError("bad-path", "Unknown range");
  }
  if (query.view === "series") return `${base}/series?range=${query.range}`;
  const window = `from=${isoSecond(new Date(now.getTime() - RANGE_MS[query.range]))}&to=${isoSecond(now)}`;
  const limit =
    query.limit === undefined
      ? ""
      : `&limit=${Math.min(1000, Math.max(1, Math.floor(query.limit)))}`;
  if (query.view === "overview") return `${base}/overview?${window}`;
  if (query.view === "paths") return `${base}/paths?${window}${limit}`;
  if (query.view === "breakdown") {
    const dim = query.dim;
    if (!dim || !(TRAFFIC_DIMENSIONS as readonly string[]).includes(dim)) {
      throw new SentinelError("bad-path", "Unknown breakdown dimension");
    }
    return `${base}/breakdown/${dim}?${window}${limit}`;
  }
  throw new SentinelError("bad-path", "Unknown traffic view");
}

/**
 * Inside the Sentinel container: its own TOKEN goes to curl on stdin, so it
 * never leaves the server or shows in a process list. The URL is "$1".
 */
const CURL_SCRIPT =
  'printf "Authorization: Bearer %s\\n" "$TOKEN" | curl -s --max-time 10 -H @- "$1"';

/**
 * The SSH command for one Sentinel read. The whole URL is one single-quoted
 * argument, so `&` and `?` never reach a shell.
 */
export function sentinelCommand(path: string, opts: { sudo: boolean }): string {
  if (!isSentinelPath(path)) {
    throw new SentinelError("bad-path", "Not an allowed Sentinel path");
  }
  const url = `http://localhost:8888${path}`;
  return `${dockerPrefix(opts.sudo)} exec coolify-sentinel sh -c ${shellQuote(CURL_SCRIPT)} sh ${shellQuote(url)}`;
}

/**
 * Reads one Sentinel path on a Linked host, the way Coolify does, as JSON.
 * Errors carry fixed texts only: Sentinel's output could hold anything.
 */
export async function sentinelGet<T>(
  run: SshRunner,
  hostId: number,
  path: string,
  opts: { sudo?: boolean } = {},
): Promise<T> {
  const command = sentinelCommand(path, { sudo: opts.sudo === true });
  const result = await run(hostId, command, { timeoutMs: 20_000 });
  const unavailable = () =>
    new SentinelError(
      "sentinel-failed",
      "Sentinel on this server did not answer. Check that metrics are on in Coolify.",
    );
  if (result.code !== 0 || result.truncated) throw unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw unavailable();
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "error" in parsed
  ) {
    throw unavailable();
  }
  return parsed as T;
}
