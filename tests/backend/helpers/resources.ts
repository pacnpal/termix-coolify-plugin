import application from "../fixtures/coolify/application.json";
import database from "../fixtures/coolify/database.json";
import service from "../fixtures/coolify/service-n8n.json";
import type { FakeAnswer } from "./fake-coolify.js";

/**
 * Marks every secret-looking value in the list fixtures below. Nothing that
 * holds it may reach a DTO, the cache, a route answer or an operation run.
 */
export const SECRET = "FAKE-SECRET-MARKER";

const place = {
  environment: {
    id: 4,
    name: "staging",
    project: { id: 2, uuid: "proj-uuid", name: "Shop" },
  },
};

/** Coolify's per-type lists, with the secret fields its real payloads carry. */
export function resourceLists(): Record<string, FakeAnswer> {
  return {
    "GET /applications": {
      json: [
        {
          ...application,
          manual_webhook_secret_github: `${SECRET}-webhook`,
          http_basic_auth_password: `${SECRET}-basic`,
          docker_compose_raw: `services: { env: ${SECRET}-compose }`,
          dockerfile: `ENV TOKEN=${SECRET}-dockerfile`,
          environment_variables: [
            { key: "API_TOKEN", value: `${SECRET}-env`, real_value: SECRET },
          ],
          private_key: { private_key: `${SECRET}-key` },
          last_deployment_at: "2026-11-18T09:03:00.000000Z",
        },
        {
          id: 12,
          uuid: "app-api-uuid",
          name: "api",
          fqdn: "https://api.x",
          status: "running:unhealthy",
          destination: {
            server: {
              uuid: "srv-edge-uuid",
              name: "edge",
              private_key: `${SECRET}-server-key`,
            },
          },
          ...place,
        },
        {
          id: 13,
          uuid: "app-worker-uuid",
          name: "worker",
          fqdn: null,
          status: "running:unhealthy",
          destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
          ...place,
        },
        {
          id: 14,
          uuid: "app-docs-uuid",
          name: "docs",
          fqdn: "https://docs.x",
          status: "stopped",
          destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
          ...place,
        },
        {
          id: 15,
          uuid: "app-blog-uuid",
          name: "blog",
          fqdn: "https://blog.x",
          status: "starting",
          destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
          ...place,
        },
      ],
    },
    "GET /services": {
      json: [
        {
          ...service,
          docker_compose_raw: `${SECRET}-service-compose`,
          docker_compose: `${SECRET}-service-compose-rendered`,
          applications: service.applications.map((part) => ({
            ...part,
            environment_variables: [{ key: "N8N_KEY", value: SECRET }],
          })),
          databases: service.databases.map((part) => ({
            ...part,
            postgres_password: `${SECRET}-part-db`,
          })),
        },
      ],
    },
    "GET /databases": {
      json: [
        {
          ...database,
          postgres_password: `${SECRET}-db`,
          internal_db_url: `postgres://postgres:${SECRET}@main-db:5432/app`,
          external_db_url: `postgres://postgres:${SECRET}@db.x:5432/app`,
          init_scripts: [{ content: SECRET }],
        },
        {
          id: 22,
          uuid: "db-cache-uuid",
          name: "cache",
          database_type: "standalone-redis",
          status: "exited",
          redis_password: `${SECRET}-redis`,
          destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
          ...place,
        },
      ],
    },
  };
}
