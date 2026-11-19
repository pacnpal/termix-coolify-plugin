import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import { countResources, type ResourceCounts } from "../shared/resource-health";

export interface Abilities {
  read: boolean;
  sensitive: boolean;
  keys: boolean;
  root: boolean;
  mcp: boolean;
}

export interface ProbeStep {
  id: string;
  ok: boolean;
  cause?: string;
}

/** A connection as the backend returns it. It never carries a token. */
export interface Connection {
  id: number;
  name: string;
  baseUrl: string;
  teamName: string | null;
  version: string | null;
  scoped: boolean;
  abilities: Abilities;
  lastError: string | null;
  autoSync: boolean;
  access: "owner" | "view" | "operate" | "configure";
  allowPrivate: boolean;
  caCert: string | null;
  cfAccess: boolean;
  lastCheckedAt: string | null;
  steps: ProbeStep[];
}

export interface ConnectionInput {
  name: string;
  baseUrl: string;
  token: string;
  cfAccessId?: string;
  cfAccessSecret?: string;
  allowPrivate?: boolean;
  caCert?: string | null;
}

export type ConnectionPatch = Partial<ConnectionInput> & {
  autoSync?: boolean;
};

export interface ProbeAnswer {
  connection: Connection;
  probe: {
    ok: boolean;
    version: string | null;
    scoped: boolean;
    steps: ProbeStep[];
  };
}

/** A Coolify server as host sync shows it. Never carries a key. */
export interface SyncServer {
  uuid: string;
  name: string;
  ip: string;
  port: number;
  user: string;
  isTunnel: boolean;
  isCoolifyHost: boolean;
  reachable: boolean;
  usable: boolean;
}

/** One server and the Termix host it is or would become. */
export interface SyncRow {
  server: SyncServer;
  hostId: number | null;
  status: "new" | "linked" | "gone" | "blocked";
  /** needs-address, needs-credential or needs-tunnel-support. */
  cause?: string;
  mode: "coolify" | "termix";
  addressOverride: string | null;
  suggestedAddress: string | null;
  credentialId: number | null;
  tunnel: boolean;
}

export interface SyncChoice {
  uuid: string;
  include: boolean;
  addressOverride?: string | null;
  credentialId?: number | null;
}

export interface SyncResult {
  uuid: string;
  name: string;
  status: "created" | "updated" | "blocked" | "skipped" | "gone" | "failed";
  hostId: number | null;
  cause?: string;
}

export type ResourceKind =
  | "application"
  | "service"
  | "database"
  | "service-application"
  | "service-database";

/** A resource or service Part as the backend returns it, without secrets. */
export interface Resource {
  uuid: string;
  id: number | null;
  name: string;
  kind: ResourceKind;
  /** Coolify's own status, like "running:healthy". */
  status: string;
  serverUuid: string | null;
  serverName: string | null;
  projectName: string | null;
  environmentName: string | null;
  fqdns: string[];
  /** Set on a service Part: its service's uuid. */
  parentUuid: string | null;
  engine: string | null;
  lastDeployAt: string | null;
}

export interface ResourceList {
  rows: Resource[];
  counts: ResourceCounts;
  fetchedAt: string | null;
}

/** What the coolify-shell tab asks for. */
export interface ShellRequest {
  part?: string;
  container?: string;
  console: "shell" | "db";
}

/** One container of a resource, offered when several match. */
export interface ContainerChoice {
  name: string;
  running: boolean;
  part: string | null;
}

/** The command a terminal runs on the Linked host. It holds no password. */
export interface ShellAnswer {
  hostId: number;
  title: string;
  container: string;
  command: string;
  fingerprints: string[];
  note?: "no-console";
}

export type ShellResult =
  | ({ kind: "command" } & ShellAnswer)
  | { kind: "choices"; choices: ContainerChoice[] };

function choicesOf(data: unknown): ContainerChoice[] | null {
  const list = (data as { choices?: unknown } | null)?.choices;
  return Array.isArray(list) ? (list as ContainerChoice[]) : null;
}

/** What a failed call answers: a plain message and a cause the UI translates. */
export interface ApiFailure {
  error: string;
  cause: string;
}

/** Reads `{ error, cause }` from a failed call, or null. */
export function failureOf(err: unknown): ApiFailure | null {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === "object" && "cause" in data) {
    const { error, cause } = data as Record<string, unknown>;
    return { error: String(error ?? ""), cause: String(cause ?? "") };
  }
  return null;
}

/** [timestamp ms, value], oldest first. */
export type MetricPoint = [number, number];

/** A resource container's history from Sentinel. Memory is used bytes. */
export interface ResourceMetrics {
  minutes: number;
  cpu: MetricPoint[];
  memory: MetricPoint[];
}

/** A server's metrics, from Coolify's MCP or Sentinel over SSH. */
export interface ServerMetrics {
  source: "mcp" | "sentinel";
  minutes: number;
  current: Record<string, number> | null;
  series: Record<string, MetricPoint[]>;
}

export type TrafficView = "overview" | "paths" | "series" | "breakdown";
export type TrafficRange = "24h" | "7d" | "30d";

/** One traffic read. `data` is Sentinel's, with IPs left out when hidden. */
export interface TrafficAnswer {
  view: TrafficView;
  dim?: string;
  ipsHidden: boolean;
  data: unknown;
}

/** One live docker stats reading from the /stats socket. */
export interface LiveStats {
  container: string;
  cpu: number;
  memPct: number;
  memBytes: number;
  netRx: number;
  netTx: number;
}

function points(value: unknown): MetricPoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (p): p is MetricPoint =>
      Array.isArray(p) &&
      typeof p[0] === "number" &&
      typeof p[1] === "number" &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1]),
  );
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === "number" && Number.isFinite(inner)) out[key] = inner;
    }
  }
  return out;
}

/** The `canEnable` of a metrics-off answer, or null for any other failure. */
export function metricsOffOf(err: unknown): { canEnable: boolean } | null {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    { cause?: unknown; canEnable?: unknown } | undefined;
  return data?.cause === "metrics-off"
    ? { canEnable: data.canEnable === true }
    : null;
}

/** Typed calls to this plugin's own routes, one per route. */
export function createApi(api: PluginApiClient) {
  return {
    async listConnections(): Promise<Connection[]> {
      return (await api.get<Connection[]>("/connections")).data;
    },
    async getConnection(id: number): Promise<Connection> {
      return (await api.get<Connection>(`/connections/${id}`)).data;
    },
    async createConnection(input: ConnectionInput): Promise<Connection> {
      return (await api.post<Connection>("/connections", input)).data;
    },
    async updateConnection(
      id: number,
      patch: ConnectionPatch,
    ): Promise<Connection> {
      return (await api.patch<Connection>(`/connections/${id}`, patch)).data;
    },
    async deleteConnection(id: number): Promise<void> {
      await api.delete(`/connections/${id}`);
    },
    async probeConnection(id: number): Promise<ProbeAnswer> {
      return (await api.post<ProbeAnswer>(`/connections/${id}/probe`)).data;
    },
    async syncPreview(id: number): Promise<SyncRow[]> {
      const rows = (await api.get<SyncRow[]>(`/connections/${id}/servers`))
        .data;
      return Array.isArray(rows) ? rows : [];
    },
    async syncApply(id: number, choices: SyncChoice[]): Promise<SyncResult[]> {
      const results = (
        await api.post<SyncResult[]>(`/connections/${id}/sync`, { choices })
      ).data;
      return Array.isArray(results) ? results : [];
    },
    async unlinkServer(
      id: number,
      uuid: string,
      removeHost: boolean,
    ): Promise<{ hostId: number; removed: boolean }> {
      return (
        await api.post<{ hostId: number; removed: boolean }>(
          `/connections/${id}/servers/${encodeURIComponent(uuid)}/unlink`,
          { removeHost },
        )
      ).data;
    },
    /** Served from a 20 second cache unless refresh is set. */
    async listResources(
      id: number,
      opts: { refresh?: boolean } = {},
    ): Promise<ResourceList> {
      const query = opts.refresh ? "?refresh=true" : "";
      const data = (
        await api.get<Partial<ResourceList>>(
          `/connections/${id}/resources${query}`,
        )
      ).data;
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      return {
        rows,
        counts: countResources(rows),
        fetchedAt: typeof data?.fetchedAt === "string" ? data.fetchedAt : null,
      };
    },
    async getResource(id: number, uuid: string): Promise<Resource> {
      return (
        await api.get<Resource>(
          `/connections/${id}/resources/${encodeURIComponent(uuid)}`,
        )
      ).data;
    },
    /**
     * The docker exec command for a shell or console in a resource's
     * container. Several matching containers answer 300 with choices.
     */
    async shell(
      id: number,
      uuid: string,
      body: ShellRequest,
    ): Promise<ShellResult> {
      try {
        const data = (
          await api.post<ShellAnswer>(
            `/connections/${id}/resources/${encodeURIComponent(uuid)}/shell`,
            body,
          )
        ).data;
        const choices = choicesOf(data);
        return choices
          ? { kind: "choices", choices }
          : { kind: "command", ...data };
      } catch (err) {
        const choices = choicesOf(
          (err as { response?: { data?: unknown } })?.response?.data,
        );
        if (choices) return { kind: "choices", choices };
        throw err;
      }
    },
    async resourceMetrics(
      id: number,
      uuid: string,
      minutes: number,
    ): Promise<ResourceMetrics> {
      const data = (
        await api.get<Partial<ResourceMetrics>>(
          `/connections/${id}/resources/${encodeURIComponent(uuid)}/metrics?minutes=${minutes}`,
        )
      ).data;
      return {
        minutes: typeof data?.minutes === "number" ? data.minutes : minutes,
        cpu: points(data?.cpu),
        memory: points(data?.memory),
      };
    },
    async resourceTraffic(
      id: number,
      uuid: string,
      query: { view: TrafficView; range: TrafficRange; dim?: string },
    ): Promise<TrafficAnswer> {
      const params = new URLSearchParams({ view: query.view });
      if (query.dim) params.set("dim", query.dim);
      params.set("range", query.range);
      const data = (
        await api.get<Partial<TrafficAnswer>>(
          `/connections/${id}/resources/${encodeURIComponent(uuid)}/traffic?${params.toString()}`,
        )
      ).data;
      return {
        view: query.view,
        dim: query.dim,
        // Anything but an explicit false keeps IPs out of the UI.
        ipsHidden: data?.ipsHidden !== false,
        data: data?.data ?? null,
      };
    },
    async serverMetrics(
      id: number,
      serverUuid: string,
      minutes: number,
    ): Promise<ServerMetrics> {
      const data = (
        await api.get<Partial<ServerMetrics>>(
          `/connections/${id}/servers/${encodeURIComponent(serverUuid)}/metrics?minutes=${minutes}`,
        )
      ).data;
      const series: Record<string, MetricPoint[]> = {};
      if (data?.series && typeof data.series === "object") {
        for (const [key, value] of Object.entries(data.series)) {
          series[key] = points(value);
        }
      }
      return {
        source: data?.source === "mcp" ? "mcp" : "sentinel",
        minutes: typeof data?.minutes === "number" ? data.minutes : minutes,
        current: data?.current ? numbers(data.current) : null,
        series,
      };
    },
    /** Turns metrics on in the server's Sentinel settings in Coolify. */
    async enableMetrics(id: number, serverUuid: string): Promise<void> {
      await api.post(
        `/connections/${id}/servers/${encodeURIComponent(serverUuid)}/metrics/enable`,
        {},
      );
    },
  };
}

export type Api = ReturnType<typeof createApi>;
