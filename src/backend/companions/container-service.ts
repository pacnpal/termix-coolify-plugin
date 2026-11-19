import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";
import { ConnectionError, type Connections } from "../connections/service.js";
import { assertContainerName, dockerPrefix } from "../containers/commands.js";
import {
  ContainerError,
  readShellRequest,
  type Containers,
  type LocatedContainer,
  type ShellChoices,
} from "../containers/service.js";
import { sshRunner, type SshRunner } from "../ssh.js";
import {
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
import { companions, requireCompanion } from "./detect.js";

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

/** What a tunnel or web UI request carries besides the port. */
interface ContainerRequest {
  part?: string;
  container?: string;
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

function containerRequest(raw: Record<string, unknown>): ContainerRequest {
  // The same checks as a shell request: a Part's uuid, a container name.
  const { part, container } = readShellRequest({
    part: raw.part,
    container: raw.container,
  });
  return { part, container };
}

export interface ContainerCompanionsDeps {
  connections: Connections;
  containers: Containers;
  /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
  run?: SshRunner;
}

/**
 * Companion plugins on a Resource's container: File Manager paths, Tunnels
 * forwards and Reverse Proxy web endpoints. These are SSH features, so each
 * needs coolify.operate and the actor's own `connect` access to the Linked
 * host, and the Resource must be one of the connection's. Checks run in this
 * order, failing closed: permission, input, the companion running, the
 * Resource and its Linked host, the companion's service, then SSH.
 */
export function createContainerCompanions(
  ctx: PluginContext,
  deps: ContainerCompanionsDeps,
) {
  const run = deps.run ?? sshRunner(ctx);

  async function needOperate(): Promise<void> {
    const permitted = await ctx.rbac.has("operate").catch(() => false);
    if (!permitted) {
      throw new ConnectionError("forbidden", "This needs coolify.operate");
    }
  }

  /** The container's internal address, from docker inspect over SSH. */
  async function containerIp(located: LocatedContainer): Promise<string> {
    const name = assertContainerName(located.container);
    return deps.containers.probe(located, async () => {
      const result = await run(
        located.hostId,
        `${dockerPrefix(located.sudo)} inspect -f ${shellQuote(INSPECT_FORMAT)} ${name}`,
      );
      if (result.code !== 0) {
        throw new ContainerError(
          "ssh-failed",
          "The Linked host could not inspect the container.",
        );
      }
      return parseContainerIp(result.stdout);
    });
  }

  return {
    /** Which companion plugins run (the same map as GET /companions). */
    async map() {
      return companions(ctx);
    },

    async paths(
      connectionId: number,
      uuid: string,
      part?: string,
    ): Promise<PathsAnswer> {
      await needOperate();
      const request = containerRequest({ part });
      await requireCompanion(ctx, "files");
      const where = await deps.containers.linked(
        connectionId,
        uuid,
        request.part,
      );
      const paths = dataPaths(where.res);
      const owner = storageOwner(where.res);
      if (!paths || !owner) {
        throw new ContainerError("not-found", "Coolify resource not found");
      }
      const api = await deps.connections.api(connectionId);
      const storages = await api.storages(owner.kind, owner.uuid);
      return {
        hostId: where.hostId,
        dataDir: paths.dataDir,
        composeFile: paths.composeFile,
        volumes: storagePaths(storages),
      };
    },

    async tunnelOpen(
      connectionId: number,
      uuid: string,
      input: unknown,
    ): Promise<TunnelAnswer | ShellChoices> {
      await needOperate();
      const raw = body(input);
      const port = readPort(raw.port);
      const request = containerRequest(raw);
      await requireCompanion(ctx, "tunnels");
      const where = await deps.containers.linked(
        connectionId,
        uuid,
        request.part,
      );
      const tunnels = await tunnelsAccess(ctx);
      const located = await deps.containers.locate(where, request.container);
      if ("choices" in located) return located;
      const targetHost = await containerIp(located);
      const name = tunnelName(where.hostId, where.res.uuid);
      const bound = await openForward(tunnels, {
        hostId: where.hostId,
        name,
        targetHost,
        targetPort: port,
      });
      return { name, hostId: where.hostId, targetPort: port, ...bound };
    },

    async tunnelClose(
      connectionId: number,
      uuid: string,
      portValue: unknown,
      part?: string,
    ): Promise<TunnelClosed> {
      await needOperate();
      readPort(portValue, true);
      const request = containerRequest({ part });
      await requireCompanion(ctx, "tunnels");
      const where = await deps.containers.linked(
        connectionId,
        uuid,
        request.part,
      );
      const tunnels = await tunnelsAccess(ctx);
      const name = tunnelName(where.hostId, where.res.uuid);
      await closeForward(tunnels, name);
      return { name, closed: true };
    },

    async webUi(
      connectionId: number,
      uuid: string,
      input: unknown,
    ): Promise<WebUiAnswer | ShellChoices> {
      await needOperate();
      const raw = body(input);
      const port = readPort(raw.port);
      const scheme = readScheme(raw.scheme);
      const request = containerRequest(raw);
      await requireCompanion(ctx, "reverseProxy");
      const where = await deps.containers.linked(
        connectionId,
        uuid,
        request.part,
      );
      const endpoints = await proxyEndpoints(ctx);
      const located = await deps.containers.locate(where, request.container);
      if ("choices" in located) return located;
      const host = await containerIp(located);
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
