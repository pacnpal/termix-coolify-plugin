import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto, ServerDto } from "../coolify/dto.js";
import { createCoolifyApi, type CoolifyApi } from "../coolify/api.js";
import { CoolifyError, type CoolifyHttp } from "../coolify/http.js";
import {
  clampMinutes,
  createCoolifyMcp,
  numberMap,
  type MetricPoint,
} from "../coolify/mcp.js";
import { pathParamProblem } from "../coolify/path.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import type { Containers } from "../containers/service.js";
import { isHostKeyError, sshRunner, type SshRunner } from "../ssh.js";
import type { Sync } from "../sync/service.js";
import {
  containerHistoryPath,
  dockerNeedsSudo,
  SentinelError,
  sentinelGet,
  serverHistoryPath,
  SUMMARY_PATH,
  trafficPath,
  MAX_TRAFFIC_LIMIT,
  TRAFFIC_DIMENSIONS,
  TRAFFIC_RANGES,
  TRAFFIC_VIEWS,
  type HistoryWindow,
  type TrafficDimension,
  type TrafficQuery,
  type TrafficRange,
  type TrafficView,
} from "./sentinel.js";

export type MetricsErrorCode =
  | "invalid-input"
  | "forbidden"
  | "confirm-required"
  | "not-found"
  | "not-linked"
  | "no-host-access"
  | "metrics-off"
  | "traffic-off"
  | "host-key"
  | "ssh-failed"
  | "sentinel-failed";

const STATUS: Record<MetricsErrorCode, 400 | 403 | 404 | 409 | 502> = {
  "invalid-input": 400,
  forbidden: 403,
  "confirm-required": 400,
  "not-found": 404,
  "not-linked": 409,
  "no-host-access": 403,
  "metrics-off": 409,
  "traffic-off": 409,
  "host-key": 409,
  "ssh-failed": 502,
  "sentinel-failed": 502,
};

/** A refusal on the way to a metric. `extra` holds no secret. */
export class MetricsError extends Error {
  readonly code: MetricsErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 502;
  readonly extra: Record<string, unknown>;

  constructor(
    code: MetricsErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MetricsError";
    this.code = code;
    this.status = STATUS[code];
    this.extra = extra;
  }
}

const DEFAULT_MINUTES = 60;

/** Access levels that may read over SSH, as lifecycle's authorize allows. */
const OPERATE_ACCESS: ReadonlySet<AccessLevel> = new Set([
  "owner",
  "operate",
  "configure",
]);

/** A uuid that can't be one path segment reads as missing. */
function badUuid(uuid: string): boolean {
  return pathParamProblem("uuid", uuid) !== null;
}

function invalid(message: string): MetricsError {
  return new MetricsError("invalid-input", message);
}

/** `minutes` from a query or an operation input: 1 or more, capped at 43,200. */
export function readMinutes(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MINUTES;
  }
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,9}$/.test(text)) {
    throw invalid("minutes must be a whole number from 1");
  }
  const n = Number(text);
  if (n < 1) throw invalid("minutes must be a whole number from 1");
  return clampMinutes(n);
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | undefined,
  name: string,
): T | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  throw invalid(`${name} must be one of ${allowed.join(", ")}`);
}

/** A traffic request from a query or an operation input. */
export function readTrafficQuery(raw: Record<string, unknown>): TrafficQuery {
  const view = pick<TrafficView>(raw.view, TRAFFIC_VIEWS, "overview", "view")!;
  const range = pick<TrafficRange>(raw.range, TRAFFIC_RANGES, "24h", "range")!;
  const query: TrafficQuery = { view, range };
  if (view === "breakdown") {
    const dim = pick<TrafficDimension>(
      raw.dim,
      TRAFFIC_DIMENSIONS,
      undefined,
      "dim",
    );
    if (!dim) throw invalid("dim is required for a breakdown");
    query.dim = dim;
  }
  if (view === "paths" || view === "breakdown") {
    const limit = raw.limit;
    if (limit !== undefined && limit !== null && limit !== "") {
      const text = typeof limit === "number" ? String(limit) : limit;
      const n =
        typeof text === "string" && /^\d{1,9}$/.test(text) ? Number(text) : 0;
      if (n < 1) throw invalid("limit must be a whole number from 1");
      query.limit = Math.min(n, MAX_TRAFFIC_LIMIT);
    }
  }
  return query;
}

/** The window and bucket for `minutes` of history up to `now`. */
export function historyWindow(minutes: number, now: number): HistoryWindow {
  const bucketMs =
    minutes <= 60
      ? 60_000
      : minutes <= 1440
        ? 300_000
        : minutes <= 10_080
          ? 1_800_000
          : 7_200_000;
  return {
    from: new Date(now - minutes * 60_000),
    to: new Date(now),
    bucketMs,
  };
}

function timeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value === "") return null;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOf(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Sentinel history rows to [ts, value] pairs, skipping anything unreadable. */
export function toPoints(rows: unknown, field: string): MetricPoint[] {
  if (!Array.isArray(rows)) return [];
  const points: MetricPoint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const ts = timeOf(r.time);
    const v = numberOf(r[field]);
    if (ts !== null && v !== null) points.push([ts, v]);
  }
  return points;
}

/** Sentinel's /api/summary as the same names Coolify's MCP uses. */
function summaryCurrent(summary: unknown): Record<string, number> | null {
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, any>;
  const disks: unknown[] = Array.isArray(s.disk) ? s.disk : [];
  const root = disks.find(
    (d) =>
      d && typeof d === "object" && (d as { mount?: unknown }).mount === "/",
  ) as Record<string, unknown> | undefined;
  return numberMap({
    cpu_percent: s.cpu?.percent,
    memory_used_bytes: s.memory?.used,
    memory_total_bytes: s.memory?.total,
    disk_used_percent: root?.usedPercent,
    load1: s.load?.load1,
    network_rx_bytes_per_sec: s.network?.rxBytesPerSec,
    network_tx_bytes_per_sec: s.network?.txBytesPerSec,
  });
}

const IP_KEY = /^(ip|ips|client_ip|client_ips|remote_addr|top_ips)$/i;

/** Drops every field that names client IPs, at any depth. */
export function withoutIps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIps);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!IP_KEY.test(key)) out[key] = withoutIps(inner);
    }
    return out;
  }
  return value;
}

export interface ResourceMetrics {
  source: "sentinel";
  minutes: number;
  cpu: MetricPoint[];
  /** Memory used, in bytes. */
  memory: MetricPoint[];
}

export interface ServerMetrics {
  source: "mcp" | "sentinel";
  minutes: number;
  current: Record<string, number> | null;
  series: Record<string, MetricPoint[]>;
}

export interface TrafficAnswer {
  view: TrafficView;
  dim?: TrafficDimension;
  range: TrafficRange;
  /** True unless Coolify's traffic_ip_mode is "full". */
  ipsHidden: boolean;
  data: unknown;
}

type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

export interface MetricsDeps {
  connections: Connections;
  /**
   * The containers service's checks: `target` is lifecycle's authorize (and
   * a Part's parent), then the actor's host access and the snapshot check.
   */
  containers: Pick<
    Containers,
    "target" | "assertHostAccess" | "assertSnapshotHolds"
  >;
  sync: Pick<Sync, "linkedHostFor">;
  run?: SshRunner;
  now?: () => number;
}

/** One read of the connection, and the check to run before each step. */
interface Read {
  connectionId: number;
  snap: Snapshot;
  /** Throws target-changed (or not-found) once the snapshot no longer holds. */
  holds: () => Promise<void>;
  /**
   * The snapshot's request layer and API with `holds` as every request's
   * beforeFetch: it runs after the request budget's wait, right before the
   * fetch, so a change while a request queues sends nothing.
   */
  http: CoolifyHttp;
  api: CoolifyApi;
}

/** `http` with `check` run right before each fetch (after any budget wait). */
function guarded(http: CoolifyHttp, check: () => Promise<void>): CoolifyHttp {
  return {
    request: (method, path, opts = {}) =>
      http.request(method, path, {
        ...opts,
        beforeFetch: async () => {
          await opts.beforeFetch?.();
          await check();
        },
      }),
  };
}

/**
 * Metrics and traffic. Server metrics come from Coolify's MCP when it is on
 * (an API read: coolify.view and access to the connection), else from
 * Sentinel over SSH. Every SSH read passes lifecycle's authorize (or, for a
 * server, coolify.operate and an operate grant) and the actor's own connect
 * access to the Linked host. Each request reads the connection once
 * (`connections.snapshot`) and checks it still holds before every Coolify
 * call and every SSH command.
 */
export function createMetrics(ctx: PluginContext, deps: MetricsDeps) {
  const run = deps.run ?? sshRunner(ctx);
  const now = deps.now ?? Date.now;

  async function begin(connectionId: number): Promise<Read> {
    const snap = await deps.connections.snapshot(connectionId);
    const holds = () => deps.containers.assertSnapshotHolds(connectionId, snap);
    const http = guarded(snap.http, holds);
    return { connectionId, snap, holds, http, api: createCoolifyApi(http) };
  }

  /** coolify.configure and the owner or a configure grant. */
  async function canConfigure(read: Read): Promise<boolean> {
    const access = read.snap.view.access;
    if (access !== "owner" && access !== "configure") return false;
    return (await ctx.rbac.has("configure")) === true;
  }

  async function serverOf(read: Read, serverUuid: string): Promise<ServerDto> {
    return read.api.server(serverUuid);
  }

  async function requireMetrics(read: Read, server: ServerDto): Promise<void> {
    if (server.metricsEnabled) return;
    throw new MetricsError(
      "metrics-off",
      "Metrics are off for this server in Coolify.",
      { canEnable: await canConfigure(read) },
    );
  }

  /** The Linked host of a server, the actor's connect access, and sudo. */
  async function sshTarget(
    read: Read,
    serverUuid: string | null,
  ): Promise<{ hostId: number; sudo: boolean }> {
    const hostId = serverUuid
      ? await deps.sync.linkedHostFor(read.connectionId, serverUuid)
      : null;
    if (!serverUuid || !hostId) {
      throw new MetricsError(
        "not-linked",
        "Link this server first: sync it from Coolify to make it a Linked host.",
      );
    }
    await deps.containers.assertHostAccess(hostId);
    const sudo = await overSsh(read, hostId, () =>
      dockerNeedsSudo(run, hostId),
    );
    if (sudo === null) {
      throw new MetricsError(
        "ssh-failed",
        "The Linked host's user could not be read.",
      );
    }
    return { hostId, sudo };
  }

  /** One SSH step: the snapshot check first, then fixed errors only. */
  async function overSsh<T>(
    read: Read,
    hostId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    await read.holds();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MetricsError) throw err;
      if (err instanceof SentinelError) {
        throw new MetricsError(
          err.code === "bad-path" ? "invalid-input" : "sentinel-failed",
          err.message,
        );
      }
      if (isHostKeyError(err)) {
        throw new MetricsError(
          "host-key",
          "Open a server terminal once to trust this host's key.",
          { hostId },
        );
      }
      throw new MetricsError(
        "ssh-failed",
        "The Linked host could not run docker over SSH.",
      );
    }
  }

  function sentinel(
    read: Read,
    target: { hostId: number; sudo: boolean },
    path: string,
  ): Promise<unknown> {
    return overSsh(read, target.hostId, () =>
      sentinelGet<unknown>(run, target.hostId, path, { sudo: target.sudo }),
    );
  }

  /** A resource by lifecycle's authorize: operate, a grant, its own list. */
  async function resourceOf(read: Read, uuid: string): Promise<ResourceDto> {
    if (badUuid(uuid)) {
      throw new MetricsError("not-found", "Coolify resource not found");
    }
    const { res } = await deps.containers.target(
      read.connectionId,
      uuid,
      undefined,
    );
    return res;
  }

  /** Sentinel on a server's host: coolify.operate and an operate grant. */
  async function sentinelServerMetrics(
    read: Read,
    serverUuid: string,
    minutes: number,
  ): Promise<ServerMetrics> {
    if (
      (await ctx.rbac.has("operate")) !== true ||
      !OPERATE_ACCESS.has(read.snap.view.access)
    ) {
      throw new MetricsError(
        "forbidden",
        "Reading metrics over SSH needs coolify.operate and operate access to this connection.",
      );
    }
    const target = await sshTarget(read, serverUuid);
    const window = historyWindow(minutes, now());
    const summary = await sentinel(read, target, SUMMARY_PATH);
    const cpu = await sentinel(read, target, serverHistoryPath("cpu", window));
    const memory = await sentinel(
      read,
      target,
      serverHistoryPath("memory", window),
    );
    return {
      source: "sentinel",
      minutes,
      current: summaryCurrent(summary),
      series: {
        cpu_percent: toPoints(cpu, "percent"),
        memory_used_bytes: toPoints(memory, "used"),
      },
    };
  }

  return {
    async serverMetrics(
      connectionId: number,
      serverUuid: string,
      query: { minutes?: unknown } = {},
    ): Promise<ServerMetrics> {
      const minutes = readMinutes(query.minutes);
      if (badUuid(serverUuid)) {
        throw new MetricsError("not-found", "Coolify server not found");
      }
      // Any access to the connection, and a server its token sees.
      const read = await begin(connectionId);
      await requireMetrics(read, await serverOf(read, serverUuid));
      // Coolify's MCP first (off by default): any refusal falls to Sentinel.
      try {
        const data = await createCoolifyMcp(read.http).serverMetrics(
          serverUuid,
          minutes,
        );
        return {
          source: "mcp",
          minutes,
          current: data.current,
          series: data.series,
        };
      } catch (err) {
        if (!(err instanceof CoolifyError)) throw err;
      }
      return sentinelServerMetrics(read, serverUuid, minutes);
    },

    async resourceMetrics(
      connectionId: number,
      uuid: string,
      query: { minutes?: unknown } = {},
    ): Promise<ResourceMetrics> {
      const minutes = readMinutes(query.minutes);
      const read = await begin(connectionId);
      const res = await resourceOf(read, uuid);
      if (res.serverUuid) {
        await requireMetrics(read, await serverOf(read, res.serverUuid));
      }
      const target = await sshTarget(read, res.serverUuid);
      const window = historyWindow(minutes, now());
      const cpu = await sentinel(
        read,
        target,
        containerHistoryPath(uuid, "cpu", window),
      );
      const memory = await sentinel(
        read,
        target,
        containerHistoryPath(uuid, "memory", window),
      );
      return {
        source: "sentinel",
        minutes,
        cpu: toPoints(cpu, "percent"),
        memory: toPoints(memory, "used"),
      };
    },

    async resourceTraffic(
      connectionId: number,
      uuid: string,
      raw: Record<string, unknown> = {},
    ): Promise<TrafficAnswer> {
      const query = readTrafficQuery(raw);
      const read = await begin(connectionId);
      const res = await resourceOf(read, uuid);
      if (res.kind !== "application") {
        throw invalid("Traffic analytics covers applications.");
      }
      if (
        res.serverUuid &&
        !(await serverOf(read, res.serverUuid)).trafficEnabled
      ) {
        throw new MetricsError(
          "traffic-off",
          "Traffic analytics is off for this server in Coolify.",
        );
      }
      const target = await sshTarget(read, res.serverUuid);
      // Fail closed: IPs need Coolify keeping them in full and configure
      // access; an unreadable IP mode hides them.
      let ipsHidden = true;
      if (res.serverUuid && (await canConfigure(read))) {
        try {
          const settings = await read.api.sentinelSettings(res.serverUuid);
          ipsHidden = settings.trafficIpMode !== "full";
        } catch (err) {
          if (err instanceof ConnectionError) throw err;
          ipsHidden = true;
        }
      }
      const answer: TrafficAnswer = {
        view: query.view,
        range: query.range,
        ipsHidden,
        data: [],
      };
      if (query.dim) answer.dim = query.dim;
      if (ipsHidden && query.dim === "ip") return answer;
      const data = await sentinel(
        read,
        target,
        trafficPath(uuid, query, new Date(now())),
      );
      answer.data = ipsHidden ? withoutIps(data) : data;
      return answer;
    },

    /**
     * Turns metrics on in the server's Sentinel settings. Needs
     * coolify.configure, the owner or a configure grant, and confirm: true.
     */
    async enableMetrics(
      connectionId: number,
      serverUuid: string,
      body: { confirm?: unknown } = {},
    ): Promise<{ enabled: true }> {
      if (badUuid(serverUuid)) {
        throw new MetricsError("not-found", "Coolify server not found");
      }
      const read = await begin(connectionId);
      if (!(await canConfigure(read))) {
        throw new MetricsError(
          "forbidden",
          "Turning metrics on needs coolify.configure and configure access to this connection.",
        );
      }
      if (body.confirm !== true) {
        throw new MetricsError(
          "confirm-required",
          "Turning metrics on needs confirm: true",
        );
      }
      // The server must be one this token sees, before anything changes.
      await serverOf(read, serverUuid);
      await read.api.patchSentinel(serverUuid, {
        is_metrics_enabled: true,
      });
      return { enabled: true };
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
