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
  /** Set when the check had nothing to try: the ability is unknown. */
  skipped?: "nothing-to-probe";
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
  /** The owner's opt-in to coolify.exec; it also needs the admin's allowExec. */
  execEnabled: boolean;
  access: "owner" | "view" | "operate" | "configure";
  allowPrivate: boolean;
  caCert: string | null;
  cfAccess: boolean;
  lastCheckedAt: string | null;
  steps: ProbeStep[];
  /** Changes when the connection's address, token or TLS settings change. */
  revision: string;
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

/** null for both Cloudflare Access values clears them, as the backend allows. */
export type ConnectionPatch = Partial<
  Omit<ConnectionInput, "cfAccessId" | "cfAccessSecret">
> & {
  cfAccessId?: string | null;
  cfAccessSecret?: string | null;
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

export type LifecycleVerb = "start" | "stop" | "restart" | "deploy";

/** What a lifecycle route answers; status "pending" waits for an approval. */
export interface LifecycleAnswer {
  deploymentUuid: string | null;
  status?: "pending";
}

/** GET /mcp: where the plugin's MCP endpoint is. */
export interface McpInfo {
  endpoint: string;
}

export interface ApiParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  type: string;
  /** The spec allows null. */
  nullable?: boolean;
  description?: string;
}

export interface ApiBodyField {
  name: string;
  type: string;
  /** The spec allows null. */
  nullable?: boolean;
  required: boolean;
  description?: string;
}

/** A Coolify API operation the user may call, with what its form needs. */
export interface ApiOperation {
  id: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  minVersion: string;
  permission: string;
  /** A delete, or one that reads or writes secrets: it always asks first. */
  sensitive?: boolean;
  summary: string;
  params: ApiParam[];
  body: ApiBodyField[] | null;
}

export type JsonPointer = (string | number)[];

export interface ApiCallRequest {
  operationId: string;
  params: Record<string, unknown>;
  body?: unknown;
  confirmed?: boolean;
  confirmText?: string;
}

/** One call's answer: redacted, with the paths of the masked values. */
export interface ApiCallAnswer {
  method: string;
  operationId: string;
  path: string;
  request: unknown;
  data: unknown;
  masked: JsonPointer[];
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
  /**
   * needs-address, needs-credential, needs-ssh-terminal,
   * ssh-terminal-too-old, needs-ssh-terminal-to-clear-tunnel,
   * credential-not-found or credential-check-failed.
   */
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

export interface PatchItem {
  package: string;
  newVersion: string;
  currentVersion: string;
  security: boolean;
  risk: "docker" | "kernel" | "system" | null;
}

/** A server's pending package updates, from Coolify or the plugin's own check. */
export interface PatchStatus {
  /** Null when unknown: the check failed (`error`). */
  updates: number | null;
  security: number | null;
  rebootRequired: boolean | null;
  checkedAt: string | null;
  error: string | null;
  items: PatchItem[];
}

export type UpdatesVia = "package-manager" | "ssh";

export interface ServerUpdates {
  server: { uuid: string; name: string };
  hostId: number | null;
  coolify: PatchStatus | null;
  fresh: PatchStatus | null;
  via: UpdatesVia | null;
}

export interface UpdatesCheck {
  via: UpdatesVia;
  fresh: PatchStatus;
}

export interface UpdatesInstall {
  via: UpdatesVia;
  summary: string;
  changed: boolean;
  pending: boolean;
  output: string;
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

/** Where logs came from: Coolify's API, or docker logs over SSH. */
export type LogSource = "coolify" | "ssh";

export interface LogsQuery {
  lines: number;
  timestamps: boolean;
  part?: string;
  container?: string;
}

export interface LogsAnswer {
  source: LogSource;
  text: string;
  /** The container read over SSH. */
  container?: string;
}

export type LogsResult =
  | ({ kind: "logs" } & LogsAnswer)
  | { kind: "choices"; choices: ContainerChoice[] };

/** The containers of a choices answer (a route body or a socket message). */
export function choicesOf(data: unknown): ContainerChoice[] | null {
  const list = (data as { choices?: unknown } | null)?.choices;
  return Array.isArray(list) ? (list as ContainerChoice[]) : null;
}

/** Which companion plugins run, one flag per feature. */
export interface CompanionMap {
  docker: boolean;
  sshTerminal: boolean;
  files: boolean;
  tunnels: boolean;
  reverseProxy: boolean;
  dns: boolean;
  uptime: boolean;
  logSearch: boolean;
  packageManager: boolean;
  securityCenter: boolean;
  hostMetrics: boolean;
  databases: boolean;
  backups: boolean;
}

/** A DNS record made here for a resource. */
export interface DnsRecord {
  id: number;
  fqdn: string;
  type: "A" | "AAAA" | "CNAME";
  content: string;
  createdAt: string;
}

export interface DnsRecordInput {
  fqdn: string;
  type?: "A" | "AAAA" | "CNAME";
  content?: string;
}

export interface UptimeMonitor {
  id: string;
  name: string;
  url: string;
  status: "up" | "down" | "paused" | "pending" | "unknown";
}

export interface LogSearchAnswer {
  source: "docker";
  query: string;
  results: {
    time: string | null;
    host: string | null;
    container: string | null;
    message: string;
  }[];
}

export interface SecurityAnswer {
  hostId: number;
  score: number | null;
  critical: number | null;
}

export interface BackupsFailedAnswer {
  hostId: number;
  jobs: { id: string; name: string; failedAt: string | null }[];
}

export interface HostMetricsAnswer {
  hostId: number;
  applications: number;
  services: number;
  databases: number;
}

export interface DbLoginAnswer {
  hostId: number;
  saved: boolean;
  logins: {
    id: string | number;
    name: string | null;
    engine: string | null;
    database: string | null;
    username: string | null;
  }[];
}

export interface DbLoginsAnswer {
  hostId: number;
  databases: { uuid: string; name: string; saved: boolean }[];
}

/** A public status page as its owner sees it. Never its link or token. */
export interface StatusPage {
  id: number;
  connectionId: number;
  title: string;
  resources: string[];
  createdAt: string | null;
}

export interface StatusPageList {
  /** False while an admin has turned public status pages off. */
  allowed: boolean;
  pages: StatusPage[];
}

/** A create or rotate answer: the link, shown this once. */
export interface StatusPageLink {
  id: number;
  url: string;
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
    /** Owner only: turns running commands in this connection's containers on or off. */
    async setExec(id: number, execEnabled: boolean): Promise<Connection> {
      return (
        await api.patch<Connection>(`/connections/${id}`, { execEnabled })
      ).data;
    },
    async deleteConnection(id: number): Promise<void> {
      await api.delete(`/connections/${id}`);
    },
    async probeConnection(id: number): Promise<ProbeAnswer> {
      return (await api.post<ProbeAnswer>(`/connections/${id}/probe`)).data;
    },
    async listApiOperations(id: number): Promise<ApiOperation[]> {
      const data = (
        await api.get<{ operations?: ApiOperation[] }>(
          `/connections/${id}/api/operations`,
        )
      ).data;
      return Array.isArray(data?.operations) ? data.operations : [];
    },
    async callApi(id: number, request: ApiCallRequest): Promise<ApiCallAnswer> {
      return (
        await api.post<ApiCallAnswer>(`/connections/${id}/api/call`, request)
      ).data;
    },
    /** One masked value, fresh from Coolify. Audited; never kept. */
    async revealApiValue(
      id: number,
      request: {
        operationId: string;
        params: Record<string, unknown>;
        pointer: JsonPointer;
      },
    ): Promise<string> {
      const data = (
        await api.post<{ value?: unknown }>(
          `/connections/${id}/api/reveal`,
          request,
        )
      ).data;
      return typeof data?.value === "string" ? data.value : "";
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
     * Starts, stops, restarts or deploys a resource or Part. The backend
     * runs it as an action, on the server's Linked host when there is one.
     */
    async resourceAction(
      id: number,
      uuid: string,
      verb: LifecycleVerb,
      opts: { force?: boolean } = {},
    ): Promise<LifecycleAnswer> {
      const body = verb === "deploy" ? { force: opts.force === true } : {};
      const data = (
        await api.post<Partial<LifecycleAnswer>>(
          `/connections/${id}/resources/${encodeURIComponent(uuid)}/${verb}`,
          body,
        )
      ).data;
      return {
        deploymentUuid:
          typeof data?.deploymentUuid === "string" ? data.deploymentUuid : null,
        status: data?.status === "pending" ? "pending" : undefined,
      };
    },
    async listStatusPages(connectionId: number): Promise<StatusPageList> {
      const data = (
        await api.get<Partial<StatusPageList>>(
          `/connections/${connectionId}/status-pages`,
        )
      ).data;
      return {
        allowed: data?.allowed !== false,
        pages: Array.isArray(data?.pages) ? data.pages : [],
      };
    },
    /** The answer's url carries the token: show it once, never keep it. */
    async createStatusPage(
      connectionId: number,
      input: { title: string; resources: string[] },
    ): Promise<StatusPageLink> {
      const data = (
        await api.post<StatusPageLink>(
          `/connections/${connectionId}/status-pages`,
          input,
        )
      ).data;
      return { id: data.id, url: data.url };
    },
    async rotateStatusPage(id: number): Promise<StatusPageLink> {
      const data = (
        await api.post<StatusPageLink>(`/status-pages/${id}/rotate`)
      ).data;
      return { id: data.id, url: data.url };
    },
    async revokeStatusPage(id: number): Promise<void> {
      await api.delete(`/status-pages/${id}`);
    },
    /** Only the endpoint: the panel writes its own snippet, with a placeholder key. */
    async getMcpInfo(): Promise<McpInfo | null> {
      const data = (await api.get<{ endpoint?: unknown }>("/mcp")).data;
      return typeof data?.endpoint === "string"
        ? { endpoint: data.endpoint }
        : null;
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
    async serverUpdates(id: number, uuid: string): Promise<ServerUpdates> {
      return (
        await api.get<ServerUpdates>(
          `/connections/${id}/servers/${encodeURIComponent(uuid)}/updates`,
        )
      ).data;
    },
    async checkServerUpdates(id: number, uuid: string): Promise<UpdatesCheck> {
      return (
        await api.post<UpdatesCheck>(
          `/connections/${id}/servers/${encodeURIComponent(uuid)}/updates/check`,
          {},
        )
      ).data;
    },
    async installServerUpdates(
      id: number,
      uuid: string,
    ): Promise<UpdatesInstall> {
      return (
        await api.post<UpdatesInstall>(
          `/connections/${id}/servers/${encodeURIComponent(uuid)}/updates/install`,
          { confirm: true },
        )
      ).data;
    },
    async rebootServer(
      id: number,
      uuid: string,
      confirmName: string,
    ): Promise<{ via: "ssh"; summary: string }> {
      return (
        await api.post<{ via: "ssh"; summary: string }>(
          `/connections/${id}/servers/${encodeURIComponent(uuid)}/reboot`,
          { confirmName },
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
    async companions(): Promise<CompanionMap> {
      return (await api.get<CompanionMap>("/companions")).data;
    },
    async listDnsRecords(id: number, uuid: string): Promise<DnsRecord[]> {
      const rows = (await api.get<DnsRecord[]>(`${resourcePath(id, uuid)}/dns`))
        .data;
      return Array.isArray(rows) ? rows : [];
    },
    async createDnsRecord(
      id: number,
      uuid: string,
      input: DnsRecordInput,
    ): Promise<DnsRecord> {
      return (await api.post<DnsRecord>(`${resourcePath(id, uuid)}/dns`, input))
        .data;
    },
    async removeDnsRecord(
      id: number,
      uuid: string,
      recordId: number,
    ): Promise<void> {
      await api.delete(
        `${resourcePath(id, uuid)}/dns/${recordId}?confirm=true`,
      );
    },
    async uptime(
      id: number,
      uuid: string,
    ): Promise<{ monitors: UptimeMonitor[] }> {
      const data = (
        await api.get<{ monitors: UptimeMonitor[] }>(
          `${resourcePath(id, uuid)}/uptime`,
        )
      ).data;
      return { monitors: listIn(data, "monitors") };
    },
    async logSearch(id: number, uuid: string): Promise<LogSearchAnswer> {
      const data = (
        await api.get<LogSearchAnswer>(
          `/connections/${id}/log-search?uuid=${encodeURIComponent(uuid)}`,
        )
      ).data;
      return { ...data, results: listIn(data, "results") };
    },
    async security(id: number, serverUuid: string): Promise<SecurityAnswer> {
      return (
        await api.get<SecurityAnswer>(`${serverPath(id, serverUuid)}/security`)
      ).data;
    },
    async backupsFailed(
      id: number,
      serverUuid: string,
    ): Promise<BackupsFailedAnswer> {
      const data = (
        await api.get<BackupsFailedAnswer>(
          `${serverPath(id, serverUuid)}/backups-failed`,
        )
      ).data;
      return { ...data, jobs: listIn(data, "jobs") };
    },
    async hostMetrics(
      id: number,
      serverUuid: string,
    ): Promise<HostMetricsAnswer> {
      return (
        await api.get<HostMetricsAnswer>(
          `${serverPath(id, serverUuid)}/host-metrics`,
        )
      ).data;
    },
    async dbLogin(id: number, uuid: string): Promise<DbLoginAnswer> {
      return (
        await api.get<DbLoginAnswer>(`${resourcePath(id, uuid)}/db-login`)
      ).data;
    },
    async dbLogins(id: number, serverUuid: string): Promise<DbLoginsAnswer> {
      const data = (
        await api.get<DbLoginsAnswer>(`${serverPath(id, serverUuid)}/db-logins`)
      ).data;
      return { ...data, databases: listIn(data, "databases") };
    },
    /**
     * Recent logs, labelled with their source. Several matching containers
     * (over SSH) answer 300 with choices.
     */
    async logs(
      id: number,
      uuid: string,
      query: LogsQuery,
    ): Promise<LogsResult> {
      const params = new URLSearchParams({ lines: String(query.lines) });
      if (query.timestamps) params.set("timestamps", "true");
      if (query.part) params.set("part", query.part);
      if (query.container) params.set("container", query.container);
      const url = `/connections/${id}/resources/${encodeURIComponent(uuid)}/logs?${params}`;
      try {
        const data = (await api.get<LogsAnswer>(url)).data;
        const choices = choicesOf(data);
        if (choices) return { kind: "choices", choices };
        return {
          kind: "logs",
          source: data?.source === "coolify" ? "coolify" : "ssh",
          text: typeof data?.text === "string" ? data.text : "",
          ...(typeof data?.container === "string"
            ? { container: data.container }
            : {}),
        };
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

/** A list field of an answer, or an empty list when it is missing. */
function listIn<T, K extends keyof T>(data: T | null | undefined, key: K) {
  const value = data?.[key];
  return (Array.isArray(value) ? value : []) as T[K] & unknown[];
}

function resourcePath(id: number, uuid: string): string {
  return `/connections/${id}/resources/${encodeURIComponent(uuid)}`;
}

function serverPath(id: number, uuid: string): string {
  return `/connections/${id}/servers/${encodeURIComponent(uuid)}`;
}

export type Api = ReturnType<typeof createApi>;
