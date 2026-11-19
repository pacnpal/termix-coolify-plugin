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

/** GET /mcp: where the plugin's MCP endpoint is. */
export interface McpInfo {
  endpoint: string;
}

export interface ApiParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  type: string;
  description?: string;
}

export interface ApiBodyField {
  name: string;
  type: string;
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
    /** Only the endpoint: the panel writes its own snippet, with a placeholder key. */
    async getMcpInfo(): Promise<McpInfo | null> {
      const data = (await api.get<{ endpoint?: unknown }>("/mcp")).data;
      return typeof data?.endpoint === "string"
        ? { endpoint: data.endpoint }
        : null;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
