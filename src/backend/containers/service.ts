import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto } from "../coolify/dto.js";
import type { Connections } from "../connections/service.js";
import type { Resources } from "../resources/service.js";
import {
  dockerNeedsSudo,
  isHostKeyError,
  sshRunner,
  type SshRunner,
} from "../ssh.js";
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
  | "ssh-failed";

const STATUS: Record<ContainerErrorCode, 400 | 403 | 404 | 409 | 502> = {
  "invalid-input": 400,
  "not-found": 404,
  "not-linked": 409,
  "no-host-access": 403,
  "not-running": 409,
  "container-not-found": 404,
  "host-key": 409,
  "ssh-failed": 502,
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

/** A running container of a resource, found after every access check. */
export interface LocatedContainer {
  res: ResourceDto;
  serverUuid: string;
  hostId: number;
  sudo: boolean;
  container: string;
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
    const sudo = await dockerNeedsSudo(run, hostId);
    if (sudo === null) {
      throw new ContainerError(
        "ssh-failed",
        "The Linked host's user could not be read.",
      );
    }
    return sudo;
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
   * The running container a request names, after every check: the resource
   * in the connection's list, its server's Linked host, the actor's connect
   * access, and the container's labels on that host. Several matches answer
   * choices.
   */
  async function locate(
    connectionId: number,
    uuid: string,
    request: ShellRequest,
  ): Promise<LocatedContainer | ShellChoices> {
    const { res, serverUuid } = await target(connectionId, uuid, request.part);
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
    const where = { connectionId, serverUuid, hostId };

    const sudo = await probe(where, () => needsSudo(hostId));
    const containers = await probe(where, () =>
      resolveContainers(run, hostId, res, { sudo }),
    );
    let chosen: ContainerChoice | undefined;
    if (request.container) {
      chosen = containers.find((c) => c.name === request.container);
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
    return { res, serverUuid, hostId, sudo, container: chosen.name };
  }

  return {
    locate,

    async shell(
      connectionId: number,
      uuid: string,
      body: unknown,
    ): Promise<ShellAnswer | ShellChoices> {
      const request = readShellRequest(body);
      const found = await locate(connectionId, uuid, request);
      if ("choices" in found) return found;
      const { res, serverUuid, hostId, sudo } = found;
      const chosen = { name: found.container };
      const where = { connectionId, serverUuid, hostId };

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
