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
  };
}

export type Api = ReturnType<typeof createApi>;
