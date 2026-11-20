import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type {
  PluginSshExecOptions,
  PluginSshExecResult,
} from "@termix-ssh/plugin-sdk/backend";
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
  /** What `docker logs` prints. */
  logs?: string;
  /**
   * Answers a command run in a container (coolify.exec) over ctx.ssh.connect,
   * with its stdin; "hang" never answers, until the channel is killed.
   */
  exec?: (
    command: string,
    stdin: string | undefined,
  ) => PluginSshExecResult | "hang";
  /** The process group id the exec script's marker line reports. */
  pgid?: number;
  /** A line written before the real marker, as a forged one would be. */
  beforeMarker?: string;
  /** A marker with the real prefix, forged by the command after the real one. */
  forgedPgid?: number;
}

function result(stdout: string, code = 0): PluginSshExecResult {
  return { stdout, stderr: "", code, truncated: false, timedOut: false };
}

/** Stands in for ctx.ssh.exec on the Linked host, recording every command. */
export function fakeDocker(harness: PluginHarness, host: DockerHost) {
  const commands: string[] = [];
  const calls: Array<{ command: string; options?: PluginSshExecOptions }> = [];
  const exec = vi
    .spyOn(harness.mock.ctx.ssh, "exec")
    .mockImplementation(async (_target, command, options) => {
      commands.push(command);
      calls.push({ command, options });
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
      if (/docker logs /.test(command)) {
        return result(host.logs ?? "");
      }
      if (/command -v bash/.test(command)) {
        return host.bash === false ? result("", 1) : result("/bin/bash\n");
      }
      return result("", 127);
    });
  const channels: FakeChannel[] = [];
  const dispose = vi.fn();
  // Only for coolify.exec, so a test's own ctx.ssh.connect fake stays.
  const connect = vi.spyOn(harness.mock.ctx.ssh, "connect");
  if (host.exec) {
    connect.mockImplementation(async () => {
      if (host.hostKey) throw hostKeyError();
      const client = {
        exec(
          command: string,
          options: unknown,
          callback: (err: Error | undefined, stream: FakeChannel) => void,
        ) {
          commands.push(command);
          const call: {
            command: string;
            options?: PluginSshExecOptions;
            script?: string;
          } = { command, options: {} };
          calls.push(call);
          const channel = new FakeChannel(options);
          channels.push(channel);
          if (/ kill -KILL /.test(command)) {
            // The group kill: it ends on its own.
            queueMicrotask(() => {
              channel.emit("exit", 0);
              channel.close();
            });
            callback(undefined, channel);
            return true;
          }
          channel.onEnd = (stdin) => {
            // The exec script carries the command in a quoted here-document
            // and has the new group's leader print a marker line first.
            const doc = stdin && /<<'(\w+)'[^\n]*\n([\s\S]*)\n\1\n/.exec(stdin);
            const mark = stdin && /echo "(\S+ \S+) \$\$"/.exec(stdin);
            const command_ = doc ? doc[2] : stdin;
            call.options = { stdin: command_ };
            call.script = stdin;
            const answer = host.exec
              ? host.exec(command, command_)
              : result("", 127);
            if (host.beforeMarker) {
              channel.emit("data", Buffer.from(`${host.beforeMarker}\n`));
            }
            if (mark) {
              channel.emit(
                "data",
                Buffer.from(`${mark[1]} ${host.pgid ?? 4242}\n`),
              );
            }
            if (mark && host.forgedPgid !== undefined) {
              channel.emit(
                "data",
                Buffer.from(`${mark[1]} ${host.forgedPgid}\n`),
              );
            }
            if (answer === "hang") return;
            if (answer.stdout) channel.emit("data", Buffer.from(answer.stdout));
            if (answer.stderr) {
              channel.stderr.emit("data", Buffer.from(answer.stderr));
            }
            channel.emit("exit", answer.code);
            channel.close();
          };
          callback(undefined, channel);
          return true;
        },
      };
      return {
        client,
        jumpClient: null,
        host: { id: HOST_ID, ip: "203.0.113.5", port: 22, username: "deploy" },
        dispose,
      } as never;
    });
  }
  return { exec, commands, calls, connect, channels, dispose };
}

function hostKeyError(): Error {
  const err = new Error(
    "HOST_KEY_UNVERIFIED: open a terminal to this host once",
  ) as Error & { code: string };
  err.code = "HOST_KEY_UNVERIFIED";
  return err;
}

/** Stands in for an ssh2 exec channel opened by coolify.exec. */
export class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  signals: string[] = [];
  closed = false;
  onEnd: ((stdin: string | undefined) => void) | null = null;
  constructor(readonly options: unknown) {
    super();
  }
  signal(name: string) {
    this.signals.push(name);
  }
  end(data?: string | Buffer) {
    this.onEnd?.(data === undefined ? undefined : String(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

/** Sets whether the stored probe found read:sensitive on the token. */
export function setSensitive(
  harness: PluginHarness,
  connectionId: number,
  sensitive: boolean,
): void {
  const row = harness.db.sqlite
    .prepare("SELECT abilities FROM p_coolify_connections WHERE id = ?")
    .get(connectionId) as { abilities: string };
  const stored = JSON.parse(row.abilities);
  stored.abilities = { ...stored.abilities, sensitive };
  harness.db.sqlite
    .prepare("UPDATE p_coolify_connections SET abilities = ? WHERE id = ?")
    .run(JSON.stringify(stored), connectionId);
}

/** A plugin with one connection whose server srv-vps1-uuid has a Linked host. */
export async function startShell(
  options: {
    permissions?: string[];
    linked?: boolean;
    /** Admin settings, like allowExec. */
    settings?: Record<string, unknown>;
  } = {},
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
    settings: options.settings,
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
