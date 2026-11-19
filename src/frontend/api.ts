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
  };
}

export type Api = ReturnType<typeof createApi>;
