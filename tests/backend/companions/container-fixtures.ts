import { vi } from "vitest";
import type {
  PluginSshExecResult,
  PluginSummary,
} from "@termix-ssh/plugin-sdk/backend";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { startPlugin, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists, SECRET } from "../helpers/resources.js";
import { HOST_ID, linkedHost } from "../containers/fixtures.js";

export { HOST_ID };

export const TOKEN = "fake-token-companion-test";

/** The plugin ids behind the three container-level companions. */
export const FILES = "file-manager";
export const TUNNELS = "tunnels";
export const REVERSE_PROXY = "reverse-proxy";

function plugin(id: string): PluginSummary {
  return { id, version: "1.0.0", source: "bundled", state: "active" };
}

export interface CompanionCalls {
  forward: unknown[][];
  stop: unknown[][];
  available: number;
  open: unknown[][];
}

/**
 * Stand-ins for tunnels.access and reverse-proxy.endpoints, shaped as the
 * design's "Companion plugins" section calls them, recording every call.
 */
export function fakeServices(
  options: { proxyReady?: boolean; bindPort?: number } = {},
) {
  const calls: CompanionCalls = {
    forward: [],
    stop: [],
    available: 0,
    open: [],
  };
  const services = {
    "tunnels.access": {
      async forward(...args: unknown[]) {
        calls.forward.push(args);
        return { bindHost: "127.0.0.1", bindPort: options.bindPort ?? 41234 };
      },
      async stop(...args: unknown[]) {
        calls.stop.push(args);
        return true;
      },
    },
    "reverse-proxy.endpoints": {
      async available() {
        calls.available += 1;
        return options.proxyReady !== false;
      },
      async open(...args: unknown[]) {
        calls.open.push(args);
        return { url: "https://e-1a2b.apps.example.test/?once=fake-one-time" };
      },
    },
  };
  return { services, calls };
}

export interface DockerAnswers {
  /** docker ps answers: the first pattern a command matches wins. */
  ps?: Array<[RegExp, string]>;
  /** What `docker inspect` prints for the container's networks. */
  ips?: string;
}

function result(stdout: string, code = 0): PluginSshExecResult {
  return { stdout, stderr: "", code, truncated: false, timedOut: false };
}

/** Stands in for ctx.ssh.exec on the Linked host, as root, recording commands. */
export function fakeDockerHost(harness: PluginHarness, host: DockerAnswers) {
  const commands: string[] = [];
  const exec = vi
    .spyOn(harness.mock.ctx.ssh, "exec")
    .mockImplementation(async (_target, command) => {
      commands.push(command);
      if (command === "id -u; id -Gn") return result("0\nroot\n");
      if (/docker ps /.test(command)) {
        for (const [pattern, out] of host.ps ?? []) {
          if (pattern.test(command)) return result(out);
        }
        return result("");
      }
      if (/docker inspect /.test(command)) {
        return result(host.ips ?? "10.0.1.5 \n");
      }
      return result("", 127);
    });
  return { exec, commands };
}

export const WEB_RUNNING: [RegExp, string] = [
  /applicationUuid=app-web-uuid/,
  "web-abc|running||\n",
];

/**
 * A plugin with one connection whose server srv-vps1-uuid has a Linked host,
 * the given companion plugins running and their services offered.
 */
export async function startCompanions(
  options: {
    running?: string[];
    permissions?: string[];
    proxyReady?: boolean;
    services?: Record<string, object>;
  } = {},
) {
  const running = options.running ?? [FILES, TUNNELS, REVERSE_PROXY];
  const fakes = fakeServices({ proxyReady: options.proxyReady });
  const fake = healthyCoolify({
    ...resourceLists(),
    "GET /servers/srv-vps1-uuid": {
      json: { uuid: "srv-vps1-uuid", name: "vps1", ip: "203.0.113.5" },
    },
    "GET /applications/app-web-uuid/storages": {
      json: {
        persistent_storages: [
          {
            id: 1,
            name: "app-web-uuid-data",
            mount_path: "/app/data",
            host_path: null,
          },
          {
            id: 2,
            name: "uploads",
            mount_path: "/app/uploads",
            host_path: "/srv/uploads",
          },
        ],
        file_storages: [
          {
            id: 3,
            fs_path: "/data/coolify/applications/app-web-uuid/config.yml",
            mount_path: "/app/config.yml",
            content: `${SECRET}-file-content`,
            is_directory: false,
          },
        ],
      },
    },
    "GET /databases/db-main-uuid/storages": {
      json: { persistent_storages: [], file_storages: [] },
    },
    "GET /services/svc-n8n-uuid/storages": {
      json: {
        persistent_storages: [
          { id: 5, name: "n8n-data", mount_path: "/home/node/.n8n" },
        ],
        file_storages: [],
      },
    },
  });
  const harness = await startPlugin({
    fetch: fake.fetch,
    permissions: options.permissions,
    hosts: [linkedHost],
    installedPlugins: [plugin("coolify"), ...running.map(plugin)],
    services: options.services ?? fakes.services,
  });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: TOKEN,
  });
  if (created.status !== 201) {
    throw new Error(`connection not created: ${created.status}`);
  }
  const connectionId = created.body.id as number;
  harness.db.sqlite
    .prepare(
      "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
    )
    .run(connectionId, "srv-vps1-uuid", HOST_ID);
  return { harness, fake, connectionId, calls: fakes.calls };
}
