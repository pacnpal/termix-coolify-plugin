import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";
import { ConnectionError, type Connections } from "../connections/service.js";
import { assertContainerName, dockerPrefix } from "../containers/commands.js";
import {
  ContainerError,
  readShellRequest,
  type ContainerPlace,
  type Containers,
  type ShellChoices,
} from "../containers/service.js";
import type { ResourceDto } from "../coolify/dto.js";
import { pathParamProblem } from "../coolify/path.js";
import type { Resources } from "../resources/service.js";
import { sshRunner, type SshRunner } from "../ssh.js";
import type { Sync } from "../sync/service.js";
import {
  BadContainerIp,
  closeForward,
  dataPaths,
  INSPECT_FORMAT,
  openForward,
  openWebEndpoint,
  parseContainerIp,
  proxyEndpoints,
  storageOwner,
  storagePaths,
  tunnelName,
  tunnelsAccess,
} from "./container-adapters.js";
import { requireCompanion } from "./detect.js";

export interface PathsAnswer {
  hostId: number;
  dataDir: string;
  composeFile: string;
  volumes: string[];
}

export interface TunnelAnswer {
  name: string;
  hostId: number;
  targetPort: number;
  bindHost: string;
  bindPort: number;
}

export interface TunnelClosed {
  name: string;
  closed: true;
}

export interface WebUiAnswer {
  url: string;
}

/** How many forwards one actor may have open through this plugin at once. */
export const TUNNELS_MAX_PER_ACTOR = 5;

export type ContainerCompanionErrorCode =
  // docker inspect answered no private container address.
  | "bad-container-ip"
  // Reverse Proxy runs, but an admin hasn't set its web endpoint up.
  | "proxy-not-configured"
  // No forward this actor opened here has that resource and port.
  | "tunnel-not-found"
  // Another actor's forward of this resource is open.
  | "tunnel-in-use"
  // TUNNELS_MAX_PER_ACTOR forwards are already open.
  | "too-many-tunnels";

const STATUS: Record<ContainerCompanionErrorCode, 404 | 409 | 429 | 502> = {
  "bad-container-ip": 502,
  "proxy-not-configured": 409,
  "tunnel-not-found": 404,
  "tunnel-in-use": 409,
  "too-many-tunnels": 429,
};

const MESSAGES: Record<ContainerCompanionErrorCode, string> = {
  "bad-container-ip":
    "The container has no private address Termix can reach on its server.",
  "proxy-not-configured":
    "Reverse Proxy can't open web pages yet. An admin sets its Termix address and Web endpoint domain (a wildcard DNS name pointing at the proxy) in Settings.",
  "tunnel-not-found": "No forward you opened here matches that port.",
  "tunnel-in-use": "Someone else is forwarding this resource right now.",
  "too-many-tunnels": `You already have ${TUNNELS_MAX_PER_ACTOR} forwards open. Stop one first.`,
};

/** A refusal of a container companion feature, with a fixed message. */
export class ContainerCompanionError extends Error {
  readonly code: ContainerCompanionErrorCode;
  readonly status: 404 | 409 | 429 | 502;

  constructor(code: ContainerCompanionErrorCode) {
    super(MESSAGES[code]);
    this.name = "ContainerCompanionError";
    this.code = code;
    this.status = STATUS[code];
  }
}

function invalid(message: string): ConnectionError {
  return new ConnectionError("invalid-input", message);
}

/** A port: an integer from 1 to 65535, as a number or a route's digits. */
export function readPort(value: unknown, fromPath = false): number {
  const port =
    fromPath && typeof value === "string" && /^\d{1,5}$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw invalid("port must be an integer from 1 to 65535");
  }
  return port;
}

function readScheme(value: unknown): "http" | "https" {
  if (value === undefined || value === null || value === "") return "http";
  if (value === "http" || value === "https") return value;
  throw invalid("scheme must be http or https");
}

function body(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid("A JSON object is required");
  }
  return value as Record<string, unknown>;
}

/** #15's path-segment check, on a value that becomes part of a path or name. */
function segment(name: string, value: string): string {
  if (pathParamProblem(name, value)) {
    throw new ConnectionError("not-found", "Coolify resource not found");
  }
  return value;
}

interface ContainerRequest {
  part?: string;
  container?: string;
}

function containerRequest(
  uuid: string,
  raw: Record<string, unknown>,
): ContainerRequest {
  segment("uuid", uuid);
  // The same checks as a shell request: a Part's uuid, a container name.
  const { part, container } = readShellRequest({
    part: raw.part,
    container: raw.container,
  });
  if (part) segment("part", part);
  if (container) segment("container", container);
  return { part, container };
}

type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

export interface ContainerCompanionsDeps {
  connections: Connections;
  containers: Containers;
  resources: Pick<Resources, "get">;
  sync: Pick<Sync, "linkedHostFor">;
  /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
  run?: SshRunner;
}

/** A forward this plugin opened, by its Tunnels name. */
interface OpenForward {
  actor: string;
  port: number;
}

/**
 * Companion plugins on a Resource's container: File Manager paths (a read),
 * Tunnels forwards and Reverse Proxy web endpoints (SSH features). Each
 * method reads the connection once with `connections.snapshot` and checks
 * the snapshot's revision again before SSH, before every companion or
 * Coolify call, and after docker inspect, so a changed target ends with
 * target-changed and nothing is opened.
 *
 * - Paths: coolify.view, the owner or any grant, the uuid in that
 *   connection's own list, its Linked host and the actor's view access to it.
 * - Tunnels and web UI: lifecycle's `authorize` (coolify.operate, the owner
 *   or an operate or configure grant, the uuid in the connection's own
 *   list), the Linked host and the actor's own connect access to it, all
 *   through `containers.locate` or `containers.target`.
 */
export function createContainerCompanions(
  ctx: PluginContext,
  deps: ContainerCompanionsDeps,
) {
  const run = deps.run ?? sshRunner(ctx);
  const { connections, containers } = deps;

  // ponytail: in memory, per process, as exec's caps. A restart forgets
  // which forwards are ours, so they can then only be stopped in Tunnels.
  const forwards = new Map<string, OpenForward>();

  // Opens and closes of one tunnel name run one at a time, so a close never
  // acts on a forward that a reopen replaced while it waited, and two opens
  // of a name never interleave.
  // ponytail: in-process queues, as sync's `serialized`; move to the
  // database if the backend ever runs as more than one process.
  const queues = new Map<string, Promise<unknown>>();
  function serialized<T>(name: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(name) ?? Promise.resolve()).then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(name, tail);
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name);
    });
    return run;
  }

  function actor(): string {
    const id = ctx.currentActor();
    if (!id) throw new ConnectionError("forbidden", "Sign in first");
    return id;
  }

  const holds = (connectionId: number, snap: Snapshot) =>
    containers.assertSnapshotHolds(connectionId, snap);

  /** The container's internal address, from docker inspect over SSH. */
  async function containerIp(
    where: ContainerPlace,
    name: string,
    sudo: boolean,
  ): Promise<string> {
    const container = assertContainerName(name);
    await holds(where.connectionId, where.snap);
    const stdout = await containers.guard(where, async () => {
      const result = await run(
        where.hostId,
        `${dockerPrefix(sudo)} inspect -f ${shellQuote(INSPECT_FORMAT)} ${container}`,
      );
      if (result.code !== 0) {
        throw new ContainerError(
          "ssh-failed",
          "The Linked host could not inspect the container.",
        );
      }
      return result.stdout;
    });
    let ip: string;
    try {
      ip = parseContainerIp(stdout);
    } catch (err) {
      if (err instanceof BadContainerIp) {
        throw new ContainerCompanionError("bad-container-ip");
      }
      throw err;
    }
    await holds(where.connectionId, where.snap);
    return ip;
  }

  /** A running container of the resource, or choices, after every check. */
  async function running(
    connectionId: number,
    snap: Snapshot,
    uuid: string,
    request: ContainerRequest,
  ) {
    const located = await containers.locate(connectionId, snap, uuid, request);
    if (located.kind === "choices") return located;
    if (!located.container.running) {
      throw new ContainerError("not-running", "The container isn't running.");
    }
    return located;
  }

  /** One of the connection's own resources (a Part must be uuid's). */
  async function resourceOf(
    connectionId: number,
    uuid: string,
    part: string | undefined,
  ): Promise<ResourceDto> {
    const find = async (id: string) =>
      (await deps.resources.get(connectionId, id)) ??
      (await deps.resources.get(connectionId, id, { refresh: true }));
    const res = await find(uuid);
    if (!res) {
      throw new ConnectionError("not-found", "Coolify resource not found");
    }
    if (!part) return res;
    const found = await find(part);
    if (!found || found.parentUuid !== uuid) {
      throw new ContainerError("not-found", "Coolify Part not found");
    }
    return found;
  }

  return {
    async paths(
      connectionId: number,
      uuid: string,
      part?: string,
    ): Promise<PathsAnswer> {
      const request = containerRequest(uuid, { part });
      const permitted = await ctx.rbac.has("view").catch(() => false);
      if (!permitted) {
        throw new ConnectionError("forbidden", "This needs coolify.view");
      }
      // Read once; another user's connection is not-found here, and any
      // access the snapshot answers is the owner's or a grant's.
      const snap = await connections.snapshot(connectionId);
      await requireCompanion(ctx, "files");
      const res = await resourceOf(connectionId, uuid, request.part);
      const serverUuid = res.serverUuid;
      const hostId = serverUuid
        ? await deps.sync.linkedHostFor(connectionId, serverUuid)
        : null;
      if (!hostId) {
        throw new ContainerError(
          "not-linked",
          "Link this server first: sync it from Coolify to make it a Linked host.",
        );
      }
      const access = await ctx.hosts
        .checkAccess(hostId, "view")
        .catch(() => null);
      if (access?.hasAccess !== true) {
        throw new ContainerError(
          "no-host-access",
          "You can't open this server's Linked host.",
        );
      }
      const paths = dataPaths(res);
      const owner = storageOwner(res);
      if (!paths || !owner) {
        throw new ConnectionError("not-found", "Coolify resource not found");
      }
      const storages = await snap.api.storages(owner.kind, owner.uuid, {
        beforeFetch: () => holds(connectionId, snap),
      });
      await holds(connectionId, snap);
      return {
        hostId,
        dataDir: paths.dataDir,
        composeFile: paths.composeFile,
        volumes: storagePaths(storages, paths.dataDir),
      };
    },

    async tunnelOpen(
      connectionId: number,
      uuid: string,
      input: unknown,
    ): Promise<TunnelAnswer | ShellChoices> {
      const raw = body(input);
      const port = readPort(raw.port);
      const request = containerRequest(uuid, raw);
      const who = actor();
      const snap = await connections.snapshot(connectionId);
      await requireCompanion(ctx, "tunnels");
      // Access first (no SSH), then the service, then SSH.
      await containers.target(connectionId, uuid, request.part);
      const tunnels = await tunnelsAccess(ctx);
      const located = await running(connectionId, snap, uuid, request);
      if (located.kind === "choices") return { choices: located.choices };
      const { where, res, sudo, container } = located;
      const name = tunnelName(where.hostId, segment("uuid", res.uuid));
      return serialized(name, async () => {
        const held = forwards.get(name);
        if (held && held.actor !== who) {
          throw new ContainerCompanionError("tunnel-in-use");
        }
        const mine = [...forwards.values()].filter((f) => f.actor === who);
        if (!held && mine.length >= TUNNELS_MAX_PER_ACTOR) {
          throw new ContainerCompanionError("too-many-tunnels");
        }
        // The slot is reserved before the first await, so concurrent opens
        // of other names count it against the cap.
        forwards.set(name, { actor: who, port });
        let oldStopped = !held;
        let forwardAsked = false;
        try {
          const targetHost = await containerIp(where, container.name, sudo);
          if (held) {
            // The same actor reopening: the old forward goes first.
            await holds(connectionId, snap);
            await closeForward(tunnels, name);
            oldStopped = true;
          }
          await holds(connectionId, snap);
          forwardAsked = true;
          const bound = await openForward(tunnels, {
            hostId: where.hostId,
            name,
            targetHost,
            targetPort: port,
          });
          return { name, hostId: where.hostId, targetPort: port, ...bound };
        } catch (err) {
          if (oldStopped) forwards.delete(name);
          else forwards.set(name, held!);
          // Tunnels may have opened it before failing to answer: stop it.
          if (forwardAsked) await closeForward(tunnels, name).catch(() => {});
          throw err;
        }
      });
    },

    async tunnelClose(
      connectionId: number,
      uuid: string,
      portValue: unknown,
      part?: string,
    ): Promise<TunnelClosed> {
      const port = readPort(portValue, true);
      const request = containerRequest(uuid, { part });
      const who = actor();
      const snap = await connections.snapshot(connectionId);
      await requireCompanion(ctx, "tunnels");
      const { res, serverUuid } = await containers.target(
        connectionId,
        uuid,
        request.part,
      );
      const hostId = serverUuid
        ? await deps.sync.linkedHostFor(connectionId, serverUuid)
        : null;
      if (!hostId) {
        throw new ContainerError(
          "not-linked",
          "Link this server first: sync it from Coolify to make it a Linked host.",
        );
      }
      await containers.assertHostAccess(hostId);
      const name = tunnelName(hostId, segment("uuid", res.uuid));
      return serialized(name, async () => {
        const held = forwards.get(name);
        // Only a forward this plugin opened, for this actor, on this port.
        if (!held || held.actor !== who || held.port !== port) {
          throw new ContainerCompanionError("tunnel-not-found");
        }
        const tunnels = await tunnelsAccess(ctx);
        await holds(connectionId, snap);
        await closeForward(tunnels, name);
        forwards.delete(name);
        return { name, closed: true as const };
      });
    },

    async webUi(
      connectionId: number,
      uuid: string,
      input: unknown,
    ): Promise<WebUiAnswer | ShellChoices> {
      const raw = body(input);
      const port = readPort(raw.port);
      const scheme = readScheme(raw.scheme);
      const request = containerRequest(uuid, raw);
      const snap = await connections.snapshot(connectionId);
      await requireCompanion(ctx, "reverseProxy");
      // Access first (no SSH), then the service, then SSH.
      await containers.target(connectionId, uuid, request.part);
      await holds(connectionId, snap);
      const { endpoints, ready } = await proxyEndpoints(ctx);
      if (!ready) throw new ContainerCompanionError("proxy-not-configured");
      const located = await running(connectionId, snap, uuid, request);
      if (located.kind === "choices") return { choices: located.choices };
      const { where, sudo, container } = located;
      const host = await containerIp(where, container.name, sudo);
      const url = await openWebEndpoint(endpoints, {
        hostId: where.hostId,
        host,
        port,
        scheme,
      });
      return { url };
    },
  };
}

export type ContainerCompanions = ReturnType<typeof createContainerCompanions>;
