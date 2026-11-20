import { vi } from "vitest";
import type { PluginSshExecResult } from "@termix-ssh/plugin-sdk/backend";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { OWNER, startPlugin, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";

export const HOST_ID = 7;
export const FINGERPRINT = "SHA256:fake-host-key-fingerprint";

/** The Linked host of srv-vps1-uuid, as ctx.hosts serves it. */
export const linkedHost = {
  id: HOST_ID,
  userId: OWNER,
  name: "vps1",
  ip: "203.0.113.5",
  port: 22,
  username: "deploy",
  tags: "coolify",
  folder: "Coolify",
  authType: "credential",
};

export interface DockerHost {
  /** `id -u` and `id -Gn` of the SSH user. */
  uid?: number;
  groups?: string;
  /** docker ps answers: the first pattern a command matches wins. */
  ps?: Array<[RegExp, string]>;
  /** Whether the container has bash. */
  bash?: boolean;
  /** Throw core's unknown host key error instead of running anything. */
  hostKey?: boolean;
}

function result(stdout: string, code = 0): PluginSshExecResult {
  return { stdout, stderr: "", code, truncated: false, timedOut: false };
}

/** Stands in for ctx.ssh.exec on the Linked host, recording every command. */
export function fakeDocker(harness: PluginHarness, host: DockerHost) {
  const commands: string[] = [];
  const exec = vi
    .spyOn(harness.mock.ctx.ssh, "exec")
    .mockImplementation(async (_target, command) => {
      commands.push(command);
      if (host.hostKey) {
        const err = new Error(
          "HOST_KEY_UNVERIFIED: open a terminal to this host once",
        ) as Error & { code: string };
        err.code = "HOST_KEY_UNVERIFIED";
        throw err;
      }
      if (command === "id -u; id -Gn") {
        return result(`${host.uid ?? 0}\n${host.groups ?? "root"}\n`);
      }
      if (/docker ps /.test(command)) {
        for (const [pattern, out] of host.ps ?? []) {
          if (pattern.test(command)) return result(out);
        }
        return result("");
      }
      if (/command -v bash/.test(command)) {
        return host.bash === false ? result("", 1) : result("/bin/bash\n");
      }
      return result("", 127);
    });
  return { exec, commands };
}

/** A plugin with one connection whose server srv-vps1-uuid has a Linked host. */
export async function startShell(
  options: { permissions?: string[]; linked?: boolean } = {},
) {
  const fake = healthyCoolify({
    ...resourceLists(),
    "GET /servers/srv-vps1-uuid": {
      json: {
        uuid: "srv-vps1-uuid",
        name: "vps1",
        ip: "203.0.113.5",
        settings: { ssh_host_key_fingerprints: [FINGERPRINT] },
      },
    },
  });
  const harness = await startPlugin({
    fetch: fake.fetch,
    permissions: options.permissions,
    hosts: [linkedHost],
  });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: "fake-token-shell-test",
  });
  if (created.status !== 201) {
    throw new Error(`connection not created: ${created.status}`);
  }
  const connectionId = created.body.id as number;
  if (options.linked !== false) {
    harness.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
      )
      .run(connectionId, "srv-vps1-uuid", HOST_ID);
  }
  return { harness, fake, connectionId };
}
