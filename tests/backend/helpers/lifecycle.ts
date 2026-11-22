import type { MockContextOptions } from "@termix-ssh/plugin-sdk/testing";
import {
  fakeCoolify,
  healthyCoolify,
  type FakeAnswer,
} from "./fake-coolify.js";
import { startPlugin, type PluginHarness } from "./plugin.js";
import { resourceLists } from "./resources.js";

export const LIFECYCLE_TOKEN = "fake-token-lifecycle";

/** The answers Coolify gives the lifecycle calls these tests make. */
export function lifecycleAnswers(): Record<string, FakeAnswer> {
  const queued = { json: { message: "Request queued." } };
  return {
    "POST /deploy": {
      json: {
        deployments: [
          {
            message: "Deployment queued.",
            resource_uuid: "app-web-uuid",
            deployment_uuid: "dep-uuid",
          },
        ],
      },
    },
    "GET /deployments/dep-uuid": {
      json: {
        deployment_uuid: "dep-uuid",
        application_uuid: "app-web-uuid",
        status: "finished",
        logs: "a build log that never leaves Coolify",
        created_at: "2026-11-19T10:00:00.000000Z",
        finished_at: "2026-11-19T10:02:00.000000Z",
      },
    },
    "POST /applications/app-web-uuid/start": queued,
    "POST /applications/app-web-uuid/stop": queued,
    "POST /applications/app-web-uuid/restart": queued,
    "POST /services/svc-n8n-uuid/applications/part-n8n-uuid/restart": queued,
    "GET /servers": {
      json: [
        {
          uuid: "srv-vps1-uuid",
          name: "vps1",
          ip: "203.0.113.10",
          settings: { is_reachable: true, is_usable: true },
        },
        {
          uuid: "srv-edge-uuid",
          name: "edge",
          ip: "203.0.113.20",
          settings: { is_reachable: false, is_usable: false },
        },
      ],
    },
  };
}

/** A plugin with one connection whose Coolify knows the resource fixtures. */
export async function startLifecycle(
  options: {
    permissions?: string[];
    overrides?: Record<string, FakeAnswer>;
    settings?: Record<string, unknown>;
    serve?: boolean;
    /** Hosts ctx.hosts.get and checkAccess answer with. */
    hosts?: MockContextOptions["hosts"];
  } = {},
): Promise<{
  harness: PluginHarness;
  fake: ReturnType<typeof fakeCoolify>;
  id: number;
}> {
  const fake = healthyCoolify({
    ...resourceLists(),
    ...lifecycleAnswers(),
    ...options.overrides,
  });
  const harness = await startPlugin({
    fetch: fake.fetch,
    permissions: options.permissions,
    settings: options.settings,
    serve: options.serve,
    hosts: options.hosts,
  });
  const created = await harness.mock.ctx.operations.run(
    "coolify.connection-create",
    {
      input: {
        name: "Prod",
        baseUrl: "https://coolify.example.test",
        token: LIFECYCLE_TOKEN,
      },
    },
  );
  const id = (created.data as { id: number }).id;
  return { harness, fake, id };
}

/** Links a Coolify server to a Termix host, as host sync would. */
export function link(
  harness: PluginHarness,
  connectionId: number,
  serverUuid: string,
  hostId: number,
): void {
  harness.db.sqlite
    .prepare(
      "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
    )
    .run(connectionId, serverUuid, hostId);
}

/** Shares a connection with a user at a level, as connection sharing will. */
export function grant(
  harness: PluginHarness,
  connectionId: number,
  userId: string,
  level: "view" | "operate" | "configure",
): void {
  harness.db.sqlite
    .prepare(
      "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
    )
    .run(connectionId, userId, level);
}

/** Calls to Coolify that change something. */
export function changes(fake: ReturnType<typeof fakeCoolify>) {
  return fake.calls.filter((c) => c.method !== "GET");
}
