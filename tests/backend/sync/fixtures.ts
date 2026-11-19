import { healthyCoolify, type FakeAnswer } from "../helpers/fake-coolify.js";
import { startPlugin, type PluginHarness } from "../helpers/plugin.js";

// Obviously fake key material. Tests scan for both markers.
export const PRIVATE_MARKER = "fake-private-material-sync-test";
export const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PRIVATE_MARKER}\n-----END OPENSSH PRIVATE KEY-----`;
export const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZha2UtcHVibGljLWtleS1mb3ItdGVzdHM= coolify";
export const LOCAL_PRIVATE_MARKER = "fake-local-private-material";
export const LOCAL_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${LOCAL_PRIVATE_MARKER}\n-----END OPENSSH PRIVATE KEY-----`;
export const LOCAL_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvY2FsLXB1YmxpYy1rZXktZm9yLXRlc3Rz coolify";

export function server(
  uuid: string,
  name: string,
  ip: string,
  extra: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) {
  return {
    uuid,
    name,
    ip,
    port: 22,
    user: "root",
    private_key_id: 3,
    is_coolify_host: false,
    settings: { is_reachable: true, is_usable: true, ...settings },
    ...extra,
  };
}

export const WEB1 = server("srv-web1", "web-1", "203.0.113.11");
export const WEB2 = server("srv-web2", "web-2", "203.0.113.12");
export const LOCAL = server("srv-local", "localhost", "host.docker.internal", {
  private_key_id: 1,
  is_coolify_host: true,
});
export const TUNNEL = server(
  "srv-vps1",
  "vps1",
  "ssh-vps1.example.test",
  {},
  { is_cloudflare_tunnel: true },
);

export function deployKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    uuid: "key-uuid",
    name: "deploy key",
    private_key: PRIVATE_KEY,
    public_key: PUBLIC_KEY,
    fingerprint: "SHA256:fake-deploy-fingerprint",
    ...overrides,
  };
}

/** A healthy Coolify with four servers: two plain ones sharing key 3, the Coolify host and a tunnel. */
export function syncCoolify(overrides: Record<string, FakeAnswer> = {}) {
  return healthyCoolify({
    "GET /servers": { json: [WEB1, WEB2, LOCAL, TUNNEL] },
    "GET /security/keys": {
      json: [
        { id: 3, uuid: "key-uuid", name: "deploy key" },
        { id: 1, uuid: "key-local", name: "localhost key" },
      ],
    },
    "GET /security/keys/key-uuid": { json: deployKey() },
    "GET /security/keys/key-local": {
      json: {
        id: 1,
        uuid: "key-local",
        name: "localhost key",
        private_key: LOCAL_PRIVATE_KEY,
        public_key: LOCAL_PUBLIC_KEY,
        fingerprint: "SHA256:fake-local-fingerprint",
      },
    },
    ...overrides,
  });
}

export type Fake = ReturnType<typeof syncCoolify>;

/** Starts the plugin and adds one connection named Prod. */
export async function startWithConnection(
  options: {
    fake?: Fake;
    settings?: Record<string, unknown>;
    permissions?: string[];
    dockerRunning?: boolean;
    /** Other plugins running besides this one, by id. */
    plugins?: string[];
    /** The actor's own credential ids, for picked credentials. */
    ownCredentials?: number[];
  } = {},
): Promise<{ harness: PluginHarness; fake: Fake; connectionId: number }> {
  const fake = options.fake ?? syncCoolify();
  const harness = await startPlugin({
    fetch: fake.fetch,
    settings: options.settings,
    permissions: options.permissions,
    credentialSummaries: (options.ownCredentials ?? []).map((id) => ({
      id,
      name: `own credential ${id}`,
      username: "root",
      authType: "key",
      folder: null,
    })),
    installedPlugins:
      options.dockerRunning || options.plugins?.length
        ? [
            {
              id: "coolify",
              version: "1.0.0",
              source: "user",
              state: "active",
            },
            ...[
              ...(options.dockerRunning ? ["docker"] : []),
              ...(options.plugins ?? []),
            ].map((id) => ({
              id,
              version: "1.0.0",
              source: "user" as const,
              state: "active",
            })),
          ]
        : undefined,
  });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: "fake-token-sync-test",
  });
  if (created.status !== 201) {
    throw new Error(`connection not created: ${created.status}`);
  }
  return { harness, fake, connectionId: created.body.id };
}

/** Every row of every plugin table, as text. */
export function dumpTables(harness: PluginHarness): string {
  const tables = harness.db.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p_coolify_%'",
    )
    .all() as { name: string }[];
  return JSON.stringify(
    tables.map((t) =>
      harness.db.sqlite.prepare(`SELECT * FROM ${t.name}`).all(),
    ),
  );
}

export function serverRows(harness: PluginHarness) {
  return harness.db.sqlite
    .prepare("SELECT * FROM p_coolify_servers ORDER BY server_uuid")
    .all() as Record<string, unknown>[];
}
