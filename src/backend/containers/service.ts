import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto } from "../coolify/dto.js";
import type { Connections } from "../connections/service.js";
import type { Resources } from "../resources/service.js";
import { isHostKeyError, sshRunner, type SshRunner } from "../ssh.js";
import type { Sync } from "../sync/service.js";
import {
  assertContainerName,
  CommandError,
  dockerPrefix,
  engineOf,
  shellCommand,
} from "./commands.js";
import { resolveContainers, type ContainerChoice } from "./resolver.js";

export type ContainerErrorCode =
  | "invalid-input"
  | "not-found"
  | "not-linked"
  | "no-host-access"
  | "not-running"
  | "container-not-found"
  | "host-key"
  | "ssh-failed"
  // docker inspect answered something that isn't an IP address.
  | "bad-container-ip"
  // Reverse Proxy runs, but an admin hasn't set its web endpoint up.
  | "proxy-not-configured";

const STATUS: Record<ContainerErrorCode, 400 | 403 | 404 | 409 | 502> = {
  "invalid-input": 400,
  "not-found": 404,
  "not-linked": 409,
  "no-host-access": 403,
  "not-running": 409,
  "container-not-found": 404,
  "host-key": 409,
  "ssh-failed": 502,
  "bad-container-ip": 502,
  "proxy-not-configured": 409,
};

/** A refusal on the way to a container. `extra` holds no secret. */
export class ContainerError extends Error {
  readonly code: ContainerErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 502;
  readonly extra: Record<string, unknown>;

  constructor(
    code: ContainerErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ContainerError";
    this.code = code;
    this.status = STATUS[code];
    this.extra = extra;
  }
}

export interface ShellRequest {
  /** A Part of the resource in the path, by uuid. */
  part?: string;
  /** A name from an earlier choices answer. */
  container?: string;
  console?: "shell" | "db";
}

export interface ShellAnswer {
  hostId: number;
  title: string;
  container: string;
  command: string;
  /** Coolify's host key fingerprints for the server, when it has them. */
  fingerprints: string[];
  /** "no-console": a console was asked for an engine with none; it's a shell. */
  note?: "no-console";
}

export interface ShellChoices {
  choices: ContainerChoice[];
}

/** A resource whose server has a Linked host the actor may open. */
export interface LinkedTarget {
  connectionId: number;
  res: ResourceDto;
  serverUuid: string;
  hostId: number;
}

/** A running container of a LinkedTarget, and whether docker needs sudo. */
export interface LocatedContainer extends LinkedTarget {
  container: string;
  sudo: boolean;
}

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message: string): ContainerError {
  return new ContainerError("invalid-input", message);
}

/** Checks a shell request body (a route body or an operation input). */
export function readShellRequest(body: unknown): ShellRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw invalid("A JSON object is required");
  }
  const raw = body as Record<string, unknown>;
  const out: ShellRequest = {};
  const part = raw.part;
  if (part !== undefined && part !== null && part !== "") {
    if (typeof part !== "string" || !UUID.test(part)) {
      throw invalid("part must be a Part's uuid");
    }
    out.part = part;
  }
  const container = raw.container;
  if (container !== undefined && container !== null && container !== "") {
    try {
      out.container = assertContainerName(container);
    } catch {
      throw invalid("container must be a container name");
    }
  }
  const mode = raw.console;
  if (mode !== undefined && mode !== null && mode !== "") {
    if (mode !== "shell" && mode !== "db") {
      throw invalid("console must be shell or db");
    }
    out.console = mode;
  }
  return out;
}

export interface ContainersDeps {
  connections: Connections;
  resources: Resources;
  sync: Sync;
  /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
  run?: SshRunner;
}

/**
 * Container shells and database consoles. Everything is checked before any
 * SSH: the connection (owner or any Grant: shells need host access, not a
 * grant level), the resource in that connection's list, its server's Linked
 * host and the actor's own `connect` access to that host.
 */
export function createContainers(ctx: PluginContext, deps: ContainersDeps) {
  const run = deps.run ?? sshRunner(ctx);

  async function fingerprints(
    connectionId: number,
    serverUuid: string,
  ): Promise<string[]> {
    try {
      const api = await deps.connections.api(connectionId);
      return (await api.server(serverUuid)).hostKeyFingerprints;
    } catch {
      return [];
    }
  }

  /** Runs one probe; core's host key refusal becomes a host-key answer. */
  async function probe<T>(
    target: { connectionId: number; serverUuid: string; hostId: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      if (isHostKeyError(err)) {
        throw new ContainerError(
          "host-key",
          "Open a server terminal once to trust this host's key.",
          {
            hostId: target.hostId,
            fingerprints: await fingerprints(
              target.connectionId,
              target.serverUuid,
            ),
          },
        );
      }
      // Only a fixed message: SSH output could hold anything.
      throw new ContainerError(
        "ssh-failed",
        "The Linked host could not run docker over SSH.",
      );
    }
  }

  /** Whether docker needs sudo: not root and not in the docker group. */
  async function needsSudo(hostId: number): Promise<boolean> {
    const result = await run(hostId, "id -u; id -Gn");
    const [uid, groups] = result.stdout.split("\n").map((l) => l.trim());
    if (result.code !== 0 || !/^\d+$/.test(uid ?? "")) {
      throw new ContainerError(
        "ssh-failed",
        "The Linked host's user could not be read.",
      );
    }
    if (uid === "0") return false;
    return !(groups ?? "").split(/\s+/).includes("docker");
  }

  async function hasBash(
    hostId: number,
    container: string,
    sudo: boolean,
  ): Promise<boolean> {
    const name = assertContainerName(container);
    const result = await run(
      hostId,
      `${dockerPrefix(sudo)} exec ${name} sh -c 'command -v bash'`,
    );
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async function target(
    connectionId: number,
    uuid: string,
    part: string | undefined,
  ): Promise<{ res: ResourceDto; serverUuid: string | null }> {
    if (!UUID.test(uuid)) {
      throw new ContainerError("not-found", "Coolify resource not found");
    }
    // Checks the actor's access to the connection first: another user's
    // connection is a 404, and the uuid must be one of its resources.
    const rows = await deps.resources.list(connectionId);
    const res = rows.find((r) => r.uuid === uuid);
    if (!res)
      throw new ContainerError("not-found", "Coolify resource not found");
    if (!part) return { res, serverUuid: res.serverUuid };
    const found = rows.find((r) => r.uuid === part && r.parentUuid === uuid);
    if (!found) throw new ContainerError("not-found", "Coolify Part not found");
    return { res: found, serverUuid: found.serverUuid ?? res.serverUuid };
  }

  /**
   * The resource (or Part) and its server's Linked host, once the actor's
   * access to the connection and their own `connect` access to the host are
   * checked. Runs nothing over SSH.
   */
  async function linked(
    connectionId: number,
    uuid: string,
    part: string | undefined,
  ): Promise<LinkedTarget> {
    const { res, serverUuid } = await target(connectionId, uuid, part);
    const hostId = serverUuid
      ? await deps.sync.linkedHostFor(connectionId, serverUuid)
      : null;
    if (!serverUuid || !hostId) {
      throw new ContainerError(
        "not-linked",
        "Link this server first: sync it from Coolify to make it a Linked host.",
      );
    }
    const access = await ctx.hosts.checkAccess(hostId, "connect");
    if (!access?.hasAccess) {
      throw new ContainerError(
        "no-host-access",
        "You can't open this server's Linked host.",
      );
    }
    return { res, serverUuid, hostId, connectionId };
  }

  /**
   * The running container of a resource on its Linked host: the one named in
   * `container` when it is among the resource's candidates, the only one, or
   * choices when several match.
   */
  async function locate(
    where: LinkedTarget,
    container: string | undefined,
  ): Promise<LocatedContainer | ShellChoices> {
    const { hostId, res } = where;
    const sudo = await probe(where, () => needsSudo(hostId));
    const containers = await probe(where, () =>
      resolveContainers(run, hostId, res, { sudo }),
    );
    let chosen: ContainerChoice | undefined;
    if (container) {
      chosen = containers.find((c) => c.name === container);
      if (!chosen) {
        throw new ContainerError(
          "container-not-found",
          "That container doesn't belong to this resource.",
        );
      }
    } else if (containers.length > 1) {
      return { choices: containers };
    } else {
      chosen = containers[0];
    }
    if (!chosen) {
      throw new ContainerError(
        "container-not-found",
        "No container of this resource was found on its server.",
      );
    }
    if (!chosen.running) {
      throw new ContainerError("not-running", "The container isn't running.");
    }
    return { ...where, container: chosen.name, sudo };
  }

  return {
    linked,
    locate,

    /** Runs one SSH probe on a located container's host, mapping failures. */
    probe<T>(where: LinkedTarget, fn: () => Promise<T>): Promise<T> {
      return probe(where, fn);
    },

    async shell(
      connectionId: number,
      uuid: string,
      body: unknown,
    ): Promise<ShellAnswer | ShellChoices> {
      const request = readShellRequest(body);
      const where = await linked(connectionId, uuid, request.part);
      const located = await locate(where, request.container);
      if ("choices" in located) return located;
      const { res, serverUuid, hostId, sudo } = located;
      const chosen = { name: located.container };

      const engine = request.console === "db" ? engineOf(res.engine) : null;
      let command: string;
      try {
        if (engine) {
          command = shellCommand(chosen.name, {
            sudo,
            shell: "sh",
            mode: "db",
            engine,
          });
        } else {
          const bash = await probe(where, () =>
            hasBash(hostId, chosen.name, sudo),
          );
          command = shellCommand(chosen.name, {
            sudo,
            shell: bash ? "bash" : "sh",
            mode: "shell",
          });
        }
      } catch (err) {
        if (err instanceof CommandError) {
          throw new ContainerError("container-not-found", err.message);
        }
        throw err;
      }
      const answer: ShellAnswer = {
        hostId,
        title: res.name,
        container: chosen.name,
        command,
        fingerprints: await fingerprints(connectionId, serverUuid),
      };
      if (request.console === "db" && !engine) answer.note = "no-console";
      return answer;
    },
  };
}

export type Containers = ReturnType<typeof createContainers>;
