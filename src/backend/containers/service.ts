import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { recordShell } from "../activity.js";
import type { ResourceDto } from "../coolify/dto.js";
import { ConnectionError, type Connections } from "../connections/service.js";
import type { Lifecycle } from "../resources/lifecycle.js";
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

type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

/** Where a resource's container runs, checked as the actor. */
export interface ContainerPlace {
  connectionId: number;
  /** The one read of the connection every later step is checked against. */
  snap: Snapshot;
  serverUuid: string;
  hostId: number;
}

export type Located =
  | { kind: "choices"; choices: ContainerChoice[] }
  | {
      kind: "container";
      res: ResourceDto;
      where: ContainerPlace;
      /** Whether docker needs sudo for the SSH user. */
      sudo: boolean;
      container: ContainerChoice;
    };

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
  /** Its `authorize` is the access check: the same as lifecycle's. */
  lifecycle: Pick<Lifecycle, "authorize">;
  sync: Pick<Sync, "linkedHostFor">;
  /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
  run?: SshRunner;
}

/**
 * Container shells and database consoles. Everything is checked before any
 * SSH: lifecycle's `authorize` (coolify.operate, the owner or an operate or
 * configure grant, and a uuid in that connection's own list), its server's
 * Linked host and the actor's own `connect` access to that host. The whole
 * answer is about one snapshot of the connection: if its address, token,
 * Access token or TLS settings change before SSH or before the command is
 * answered, it ends with target-changed.
 */
export function createContainers(ctx: PluginContext, deps: ContainersDeps) {
  const run = deps.run ?? sshRunner(ctx);

  async function fingerprints(
    snap: Snapshot,
    serverUuid: string,
  ): Promise<string[]> {
    try {
      return (await snap.api.server(serverUuid)).hostKeyFingerprints;
    } catch {
      return [];
    }
  }

  /** Fails closed unless the connection still points at the snapshot's target. */
  async function assertSnapshotHolds(connectionId: number, snap: Snapshot) {
    if (
      (await deps.connections.revision(connectionId)) !== snap.view.revision
    ) {
      throw new ConnectionError(
        "target-changed",
        "The connection's address, token or Access settings changed. Open the shell again.",
      );
    }
  }

  /** Runs one probe; core's host key refusal becomes a host-key answer. */
  async function probe<T>(
    target: ContainerPlace,
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
            fingerprints: await fingerprints(target.snap, target.serverUuid),
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
    const res = await deps.lifecycle.authorize(connectionId, uuid);
    if (!part) return { res, serverUuid: res.serverUuid };
    let found: ResourceDto | null = null;
    try {
      found = await deps.lifecycle.authorize(connectionId, part);
    } catch (err) {
      if (!(err instanceof ConnectionError) || err.code !== "not-found") {
        throw err;
      }
    }
    if (!found || found.parentUuid !== uuid) {
      throw new ContainerError("not-found", "Coolify Part not found");
    }
    return { res: found, serverUuid: found.serverUuid ?? res.serverUuid };
  }

  /** The actor's own connect access to a Linked host, or no-host-access. */
  async function assertHostAccess(hostId: number): Promise<void> {
    const access = await ctx.hosts.checkAccess(hostId, "connect");
    if (!access?.hasAccess) {
      throw new ContainerError(
        "no-host-access",
        "You can't open this server's Linked host.",
      );
    }
  }

  /**
   * The resource's container on its Linked host, after every check: the
   * resource (target, lifecycle's authorize), the Linked host (else
   * not-linked), the actor's own connect access to it (else no-host-access),
   * the snapshot's revision, then docker ps. A chosen container must be one
   * of this resource's; several without a choice answer choices. Whether it
   * runs is the caller's to judge.
   */
  async function locate(
    connectionId: number,
    snap: Snapshot,
    uuid: string,
    request: { part?: string; container?: string },
  ): Promise<Located> {
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
    await assertHostAccess(hostId);
    const where: ContainerPlace = { connectionId, snap, serverUuid, hostId };
    await assertSnapshotHolds(connectionId, snap);

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
      return { kind: "choices", choices: containers };
    } else {
      chosen = containers[0];
    }
    if (!chosen) {
      throw new ContainerError(
        "container-not-found",
        "No container of this resource was found on its server.",
      );
    }
    return { kind: "container", res, where, sudo, container: chosen };
  }

  return {
    target,
    locate,
    assertHostAccess,
    assertSnapshotHolds,
    /** Runs SSH work on a located host; a host key refusal becomes host-key. */
    guard: probe,

    async shell(
      connectionId: number,
      uuid: string,
      body: unknown,
    ): Promise<ShellAnswer | ShellChoices> {
      const request = readShellRequest(body);
      // Read once: every later step is checked against this target.
      const snap = await deps.connections.snapshot(connectionId);
      const located = await locate(connectionId, snap, uuid, request);
      if (located.kind === "choices") return { choices: located.choices };
      const { res, where, sudo, container: chosen } = located;
      const { hostId, serverUuid } = where;
      if (!chosen.running) {
        throw new ContainerError("not-running", "The container isn't running.");
      }

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
      const hostKeys = await fingerprints(snap, serverUuid);
      // The route and coolify.shell-command both land here, once per open.
      // Recorded before the last check, so nothing is awaited between that
      // check and the answer. If the target changes meanwhile, the entry
      // stays (it names a shell that was opened) but no command is answered.
      await recordShell(ctx, hostId, res.name);
      await assertSnapshotHolds(connectionId, snap);
      const answer: ShellAnswer = {
        hostId,
        title: res.name,
        container: chosen.name,
        command,
        fingerprints: hostKeys,
      };
      if (request.console === "db" && !engine) answer.note = "no-console";
      return answer;
    },
  };
}

export type Containers = ReturnType<typeof createContainers>;
