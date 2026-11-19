import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";

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

/** Which companion plugins run, one flag per feature. */
export interface CompanionMap {
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
  checkedAt: string | null;
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
      await api.delete(`${resourcePath(id, uuid)}/dns/${recordId}`);
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
