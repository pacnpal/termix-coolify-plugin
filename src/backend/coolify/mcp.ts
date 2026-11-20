import { CoolifyError, type CoolifyHttp } from "./http.js";

/** Coolify's own cap on a get_server_metrics window: 30 days. */
export const MAX_METRIC_MINUTES = 43_200;

export type MetricPoint = [number, number];

/** Server metrics as the plugin keeps them, from either source. */
export interface ServerMetricsData {
  /** Latest values by name, like cpu_percent; null when the server is offline. */
  current: Record<string, number> | null;
  /** [timestamp ms, value] pairs by name, oldest first. */
  series: Record<string, MetricPoint[]>;
  bucketSeconds: number;
}

export interface CoolifyMcp {
  /** Whether Coolify's MCP endpoint answers this token. */
  available(): Promise<boolean>;
  /** Calls one tool and returns the `data` of its JSON answer. */
  call<T>(tool: string, args: object): Promise<T>;
  serverMetrics(uuid: string, minutes: number): Promise<ServerMetricsData>;
}

/** A whole number of minutes from 1 to MAX_METRIC_MINUTES. */
export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60;
  return Math.min(MAX_METRIC_MINUTES, Math.max(1, Math.floor(minutes)));
}

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

function finite(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Only finite numbers, under names of letters, digits and underscores. */
export function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, inner] of Object.entries(obj(value))) {
    const n = finite(inner);
    if (n !== null && /^[a-z0-9_]{1,64}$/i.test(key)) out[key] = n;
  }
  return out;
}

/** Only [finite, finite] pairs, under the same names as numberMap. */
export function seriesMap(value: unknown): Record<string, MetricPoint[]> {
  const out: Record<string, MetricPoint[]> = {};
  for (const [key, inner] of Object.entries(obj(value))) {
    if (!/^[a-z0-9_]{1,64}$/i.test(key) || !Array.isArray(inner)) continue;
    const points: MetricPoint[] = [];
    for (const pair of inner) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [ts, v] = [finite(pair[0]), finite(pair[1])];
      if (ts !== null && v !== null) points.push([ts, v]);
    }
    out[key] = points;
  }
  return out;
}

/** The one JSON-RPC message in a JSON body or a server-sent events body. */
function rpcMessage(text: string): Raw | null {
  const candidates = [
    text,
    ...text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const message = obj(parsed);
      if ("result" in message || "error" in message) return message;
    } catch {
      // Not JSON: keep looking.
    }
  }
  return null;
}

/**
 * A minimal client for Coolify's own MCP endpoint (`<url>/mcp`, stateless
 * streamable HTTP), used where it saves SSH: get_server_metrics. Every call
 * goes through the connection's own request layer (`http.ts`): its headers,
 * transport check, budget and error mapping. Nothing Coolify sends back
 * becomes an error message.
 */
export function createCoolifyMcp(http: CoolifyHttp): CoolifyMcp {
  let nextId = 1;

  async function rpc(method: string, params: object): Promise<Raw> {
    const text = await http.request<string>("POST", "/mcp", {
      mcp: true,
      text: true,
      retry: false,
      body: { jsonrpc: "2.0", id: nextId++, method, params },
    });
    const message = rpcMessage(text);
    if (!message) throw new CoolifyError("not-coolify", 200);
    if (message.error) throw new CoolifyError("upstream", 200);
    return obj(message.result);
  }

  async function call<T>(tool: string, args: object): Promise<T> {
    const result = await rpc("tools/call", { name: tool, arguments: args });
    if (result.isError === true) throw new CoolifyError("upstream", 200);
    const first = obj(Array.isArray(result.content) ? result.content[0] : null);
    if (typeof first.text !== "string") {
      throw new CoolifyError("upstream", 200);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(first.text);
    } catch {
      throw new CoolifyError("upstream", 200);
    }
    const body = obj(parsed);
    return ("data" in body ? body.data : parsed) as T;
  }

  return {
    async available() {
      try {
        await rpc("tools/list", {});
        return true;
      } catch (err) {
        if (
          err instanceof CoolifyError &&
          (err.status === 404 || err.status === 403)
        ) {
          return false;
        }
        throw err;
      }
    },

    call,

    async serverMetrics(uuid, minutes) {
      const data = obj(
        await call<unknown>("get_server_metrics", {
          server_uuid: uuid,
          minutes: clampMinutes(minutes),
        }),
      );
      const current = data.current === null ? null : numberMap(data.current);
      return {
        current,
        series: seriesMap(data.series),
        bucketSeconds: finite(data.bucket_seconds) ?? 0,
      };
    },
  };
}
