import { vi } from "vitest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";

export const connection = {
  id: 1,
  name: "Prod",
  baseUrl: "https://coolify.example.test",
  teamName: "Ops",
  version: "v4.7.5",
  scoped: false,
  abilities: {
    read: true,
    sensitive: true,
    keys: true,
    root: false,
    mcp: false,
  },
  lastError: null,
  autoSync: false,
  access: "owner",
  allowPrivate: false,
  caCert: null,
  cfAccess: false,
  lastCheckedAt: null,
  steps: [],
};

function row(
  fields: { uuid: string; name: string; kind: string } & Record<
    string,
    unknown
  >,
) {
  return {
    id: null,
    status: "running:healthy",
    serverUuid: "srv-vps1-uuid",
    serverName: "vps1",
    projectName: "Shop",
    environmentName: "production",
    fqdns: [],
    parentUuid: null,
    engine: null,
    lastDeployAt: null,
    ...fields,
  };
}

/** Resources as the backend answers them: a service is followed by its Parts. */
export const resourceRows = [
  row({
    uuid: "app-web-uuid",
    name: "web",
    kind: "application",
    fqdns: ["https://shop.example.test"],
    lastDeployAt: "2026-11-18T09:03:00.000Z",
  }),
  row({
    uuid: "app-api-uuid",
    name: "api",
    kind: "application",
    status: "running:unhealthy",
    serverUuid: "srv-edge-uuid",
    serverName: "edge",
    environmentName: "staging",
  }),
  row({ uuid: "svc-n8n-uuid", name: "n8n", kind: "service" }),
  row({
    uuid: "part-n8n-uuid",
    name: "n8n-main",
    kind: "service-application",
    parentUuid: "svc-n8n-uuid",
    fqdns: ["https://n8n.example.test"],
  }),
  row({
    uuid: "part-postgres-uuid",
    name: "postgresql",
    kind: "service-database",
    parentUuid: "svc-n8n-uuid",
    engine: "postgres:16-alpine",
  }),
  row({
    uuid: "db-main-uuid",
    name: "main-db",
    kind: "database",
    engine: "standalone-postgresql",
  }),
  row({
    uuid: "db-cache-uuid",
    name: "cache",
    kind: "database",
    status: "stopped",
    engine: "standalone-redis",
  }),
  row({
    uuid: "app-blog-uuid",
    name: "blog",
    kind: "application",
    status: "starting",
  }),
];

export const resourceAnswer = {
  rows: resourceRows,
  counts: { running: 3, degraded: 1, stopped: 1, deploying: 1 },
  fetchedAt: "2026-11-19T10:00:00.000Z",
};

/** A stub of the plugin's own routes, for renderWithApp({ api }). */
export function stubApi(
  options: { connections?: unknown[]; resources?: unknown } = {},
) {
  const list = options.connections ?? [connection];
  const resources = options.resources ?? resourceAnswer;
  const mocks = {
    get: vi.fn(async (url: string) => {
      if (url === "/connections") return { data: list };
      const one = /^\/connections\/\d+\/resources\/([^/?]+)/.exec(url);
      if (one) {
        return { data: resourceRows.find((r) => r.uuid === one[1]) };
      }
      if (/^\/connections\/\d+\/resources(\?|$)/.test(url)) {
        if (resources instanceof Error) throw resources;
        return { data: resources };
      }
      return { data: list[0] };
    }),
    post: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return mocks as unknown as typeof mocks & PluginApiClient;
}
