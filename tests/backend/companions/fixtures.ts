import type { PluginSummary } from "@termix-ssh/plugin-sdk/backend";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { OWNER, startPlugin, type PluginHarness } from "../helpers/plugin.js";

// Obviously fake values. Tests scan for them in every companion call.
export const TOKEN = "fake-token-companion-test";
export const DB_PASSWORD = "fake-db-password-companion-test";

/** The Linked host of srv-web1, which the actor can reach. */
export const HOST_ID = 7;
/** The Linked host of srv-web2, which the actor can't reach. */
export const HIDDEN_HOST_ID = 99;

export const COMPANION_IDS = [
  "dns",
  "uptime",
  "log-search",
  "security-center",
  "host-metrics",
  "databases",
  "backups",
] as const;

export function installed(
  ids: readonly string[],
  state = "active",
): PluginSummary[] {
  return [
    { id: "coolify", version: "1.0.0", source: "user", state: "active" },
    ...ids.map((id) => ({
      id,
      version: "1.0.0",
      source: "bundled" as const,
      state,
    })),
  ];
}

/** Coolify with two servers, an app with two domains, a database and a service. */
export function companionCoolify() {
  return healthyCoolify({
    "GET /servers": {
      json: [
        { uuid: "srv-web1", name: "web-1", ip: "203.0.113.11", port: 22 },
        { uuid: "srv-web2", name: "web-2", ip: "203.0.113.12", port: 22 },
      ],
    },
    "GET /servers/srv-web1": {
      json: { uuid: "srv-web1", name: "web-1", ip: "203.0.113.11", port: 22 },
    },
    "GET /applications": {
      json: [
        {
          id: 11,
          uuid: "app-web-uuid",
          name: "web",
          status: "running",
          fqdn: "https://a.example.test,https://b.example.test/app",
          destination: { server: { uuid: "srv-web1" } },
        },
        {
          id: 12,
          uuid: "app-hidden-uuid",
          name: "hidden",
          status: "running",
          fqdn: "https://hidden.example.test",
          destination: { server: { uuid: "srv-web2" } },
        },
      ],
    },
    "GET /databases": {
      json: [
        {
          id: 21,
          uuid: "db-main-uuid",
          name: "main-db",
          database_type: "standalone-postgresql",
          status: "running",
          postgres_password: DB_PASSWORD,
          destination: { server: { uuid: "srv-web1" } },
        },
      ],
    },
    "GET /services": {
      json: [
        {
          uuid: "svc-n8n-uuid",
          name: "n8n",
          status: "running",
          destination: { server: { uuid: "srv-web1" } },
          applications: [
            {
              uuid: "svc-n8n-app",
              name: "n8n",
              fqdn: "https://n8n.example.test",
            },
          ],
          databases: [{ uuid: "svc-n8n-db", name: "postgresql" }],
        },
      ],
    },
  });
}

export type CompanionCall = { name: string; args: unknown[] };

/**
 * Fakes of the companion plugins' services and actions. Every call is
 * recorded, so tests can check what reached a companion.
 */
export function fakeCompanions() {
  const calls: CompanionCall[] = [];
  let next = 1;
  const record = (name: string, args: unknown[]) => calls.push({ name, args });
  const services = {
    "dns.records": {
      findZone: async (fqdn: string) => {
        record("dns.findZone", [fqdn]);
        return { id: "zone-1", name: "example.test" };
      },
      setRecord: async (input: unknown) => {
        record("dns.setRecord", [input]);
        return { zoneId: "zone-1", recordId: `rec-${next++}` };
      },
      deleteRecord: async (handle: unknown) => {
        record("dns.deleteRecord", [handle]);
        return true;
      },
    },
    "uptime.access": {
      summary: async () => {
        record("uptime.summary", []);
        return {
          monitors: [
            {
              id: "mon-a",
              name: "web",
              url: "https://A.example.test/",
              status: "up",
            },
            {
              id: "mon-b",
              name: "web app",
              url: "https://b.example.test/app/health",
              status: "down",
            },
            {
              id: "mon-other",
              name: "elsewhere",
              url: "https://other.example.test",
              status: "up",
            },
          ],
        };
      },
    },
    "security-center.access": {
      check: async (hostId: number) => {
        record("security.check", [hostId]);
        return {
          score: 82,
          vulnerabilities: { critical: 2, high: 5 },
          checkedAt: "2026-11-19T10:00:00.000Z",
        };
      },
    },
    "databases.logins": {
      list: async (input?: unknown) => {
        record("databases.list", input === undefined ? [] : [input]);
        return [
          {
            id: 1,
            hostId: HOST_ID,
            name: "main-db",
            engine: "postgresql",
            database: "postgres",
            username: "postgres",
            password: DB_PASSWORD,
          },
          {
            id: 2,
            hostId: 3,
            name: "main-db",
            engine: "postgresql",
            database: "postgres",
            username: "postgres",
            password: DB_PASSWORD,
          },
        ];
      },
    },
  };
  const actions: Record<
    string,
    (input: Record<string, unknown>, hostId?: number) => unknown
  > = {
    "log-search.search": (input) => ({
      summary: "2 lines",
      data: {
        results: [
          {
            time: "2026-11-19T10:00:00.000Z",
            host: "web-1",
            container: "app-web-uuid-123",
            message: `GET / 200 ${String(input.query)}`,
          },
          { timestamp: "2026-11-19T10:00:01.000Z", line: "second line" },
        ],
      },
    }),
    "backups.failed": (_input, hostId) => ({
      summary: "1 failed job",
      data: {
        jobs: [
          {
            id: "job-1",
            name: "nightly",
            hostId,
            failedAt: "2026-11-19T03:00:00.000Z",
            error: "disk full",
          },
        ],
      },
    }),
    "uptime.pause": () => ({ summary: "paused", changed: true }),
    "uptime.resume": () => ({ summary: "resumed", changed: true }),
  };
  return { calls, services, actions };
}

/**
 * Starts the plugin with the fake companions (only those in `present` count
 * as running), adds the connection Prod, and links srv-web1 to HOST_ID and
 * srv-web2 to HIDDEN_HOST_ID, which the actor can't reach.
 */
export async function startCompanions(
  options: {
    present?: readonly string[];
    /** The state ctx.plugins.list reports for them; "active" when running. */
    state?: string;
    permissions?: string[];
  } = {},
): Promise<{
  harness: PluginHarness;
  companions: ReturnType<typeof fakeCompanions>;
  fake: ReturnType<typeof companionCoolify>;
  connectionId: number;
}> {
  const fake = companionCoolify();
  const companions = fakeCompanions();
  const harness = await startPlugin({
    fetch: fake.fetch,
    permissions: options.permissions,
    installedPlugins: installed(
      options.present ?? COMPANION_IDS,
      options.state,
    ),
    services: companions.services,
    hosts: [
      {
        id: HOST_ID,
        userId: OWNER,
        name: "web-1",
        ip: "203.0.113.11",
        port: 22,
        username: "root",
        folder: "Coolify",
        tags: ["coolify"],
        authType: "credential",
      } as never,
    ],
  });
  for (const [id, action] of Object.entries(companions.actions)) {
    harness.mock.ctx.operations.register(id, {
      run: async (input, context) => {
        companions.calls.push({
          name: id,
          args: [input, { hostId: context.hostId }],
        });
        return action(input, context.hostId) as never;
      },
    });
  }
  // Written directly, so an actor without coolify.configure still has one.
  harness.db.sqlite
    .prepare(
      "INSERT INTO p_coolify_connections (user_id, name, base_url, token_sealed) VALUES (?, ?, ?, ?)",
    )
    .run(
      OWNER,
      "Prod",
      "https://coolify.example.test",
      await harness.mock.ctx.secrets.seal(TOKEN),
    );
  const { id: connectionId } = harness.db.sqlite
    .prepare("SELECT id FROM p_coolify_connections WHERE name = 'Prod'")
    .get() as { id: number };
  const insert = harness.db.sqlite.prepare(
    "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
  );
  insert.run(connectionId, "srv-web1", HOST_ID);
  insert.run(connectionId, "srv-web2", HIDDEN_HOST_ID);
  return { harness, companions, fake, connectionId };
}

/** Gives `userId` a grant on the connection. */
export function grant(
  harness: PluginHarness,
  connectionId: number,
  userId: string,
  level: string,
): void {
  harness.db.sqlite
    .prepare(
      "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
    )
    .run(connectionId, userId, level);
}
