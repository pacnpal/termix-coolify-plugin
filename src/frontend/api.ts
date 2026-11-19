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

export interface PatchItem {
  package: string;
  newVersion: string;
  currentVersion: string;
  security: boolean;
  risk: "docker" | "kernel" | "system" | null;
}

/** A server's pending package updates, from Coolify or the plugin's own check. */
export interface PatchStatus {
  updates: number;
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
  };
}

export type Api = ReturnType<typeof createApi>;
