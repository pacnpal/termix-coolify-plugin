import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import en from "../../../locales/en.json";
import type { ResourceDto } from "../coolify/dto.js";
import { fill } from "../../shared/template.js";
import { ConnectionError } from "../connections/service.js";
import type {
  Lifecycle,
  LifecycleOutcome,
  LifecycleVerb,
} from "../resources/lifecycle.js";
import type { Deployments } from "../deployments/service.js";
import type { Resources } from "../resources/service.js";
import type { Sync } from "../sync/service.js";
import { connectionIdInput } from "./connections.js";

const DONE: Record<LifecycleVerb, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  deploy: "Deployed",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "Would deploy <name> on <server>", from locales. */
export function describeDeploy(resource: ResourceDto): string {
  return fill(en.ops.deploy.dryRun, {
    name: resource.name,
    server:
      resource.serverName ?? resource.serverUuid ?? en.ops.deploy.noServer,
  });
}

function summaryOf(
  verb: LifecycleVerb,
  resource: ResourceDto,
  outcome: LifecycleOutcome,
): string {
  if (verb !== "deploy") return `${DONE[verb]} ${resource.name}`;
  if (outcome.status) {
    return `Deployed ${resource.name}: ${outcome.status}`;
  }
  return outcome.deploymentUuid
    ? `Deploy of ${resource.name} queued (deployment ${outcome.deploymentUuid})`
    : `Deploy of ${resource.name} sent; Coolify queued no deployment`;
}

function result(
  verb: LifecycleVerb,
  resource: ResourceDto,
  outcome: LifecycleOutcome,
) {
  return {
    summary: summaryOf(verb, resource, outcome),
    changed: true,
    data: {
      uuid: resource.uuid,
      name: resource.name,
      kind: resource.kind,
      ...outcome,
    },
  };
}

/** The resource list a Linked host's resource section and its picker read. */
function resourceRow(r: ResourceDto) {
  return { ...r, fqdn: r.fqdns[0] ?? null };
}

/**
 * Start, stop, restart and deploy, in both scopes, and the host's resource
 * list. The resource-scope actions act on a Linked host's resource, so runs
 * land in that host's history; the server-scope ones take a connection and
 * a uuid, for resources with no Linked host. Each handler goes through
 * lifecycle.authorize (or onHost) before Coolify is called.
 */
export function registerLifecycleOperations(
  ctx: PluginContext,
  deps: {
    lifecycle: Lifecycle;
    resources: Resources;
    sync: Sync;
    deployments: Pick<Deployments, "rollbackImages">;
  },
): void {
  const { lifecycle, resources, sync, deployments } = deps;

  /**
   * The image an application runs before a deploy, so the run's undo (a
   * rollback) can bring it back. Null for anything but an application, when
   * nothing runs, or when the list can't be read: the deploy goes ahead
   * without an undo. The rollback checks the image is still listed before
   * it acts.
   */
  async function imageBefore(
    connectionId: number,
    resource: ResourceDto,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (resource.kind !== "application") return null;
    try {
      const { current, images } = await deployments.rollbackImages(
        connectionId,
        resource.uuid,
        { signal },
      );
      return current && images.some((i) => i.tag === current) ? current : null;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  ctx.operations.register("coolify.list-resources", {
    run: async (_input, { hostId }) => {
      const link = hostId ? await sync.linkOfHost(hostId) : null;
      if (!link) {
        return {
          summary: "Not a Linked host: no Coolify resources",
          data: { rows: [] },
        };
      }
      const rows = await resources.byServer(link.connectionId, link.serverUuid);
      return {
        summary: `${rows.length} Coolify resource${rows.length === 1 ? "" : "s"}`,
        data: { rows: rows.map(resourceRow) },
      };
    },
  });

  const onHost = (verb: LifecycleVerb) => ({
    run: async (input: Record<string, unknown>, c: PluginOperationContext) => {
      c.signal.throwIfAborted();
      const { connectionId, resource } = await lifecycle.onHost(
        c.hostId,
        c.resourceKey,
      );
      const image =
        verb === "deploy"
          ? await imageBefore(connectionId, resource, c.signal)
          : null;
      const outcome = await lifecycle.run(connectionId, resource, verb, {
        force: input.force === true,
        wait: input.wait === true,
        signal: c.signal,
        hostId: c.hostId,
      });
      return {
        ...result(verb, resource, outcome),
        ...(image && { undoInput: { image } }),
      };
    },
  });

  ctx.operations.register("coolify.deploy", {
    ...onHost("deploy"),
    describe: async (_input, c) => {
      const { resource } = await lifecycle.onHost(c.hostId, c.resourceKey);
      return describeDeploy(resource);
    },
  });
  ctx.operations.register("coolify.start", onHost("start"));
  ctx.operations.register("coolify.restart", onHost("restart"));
  ctx.operations.register("coolify.stop", onHost("stop"));

  /** A server-scope run: the connection and uuid come from the input. */
  async function onConnection(
    input: Record<string, unknown>,
    c: PluginOperationContext,
    verb: LifecycleVerb,
  ) {
    c.signal.throwIfAborted();
    const connectionId = connectionIdInput(input);
    const resource = await lifecycle.authorize(connectionId, text(input.uuid));
    const hostId = await lifecycle.hostOf(connectionId, resource);
    const image =
      verb === "deploy"
        ? await imageBefore(connectionId, resource, c.signal)
        : null;
    const outcome = await lifecycle.run(connectionId, resource, verb, {
      force: input.force === true,
      wait: input.wait === true,
      signal: c.signal,
      hostId: hostId ?? undefined,
    });
    return {
      ...result(verb, resource, outcome),
      ...(image && {
        undoInput: {
          connectionId: String(connectionId),
          uuid: resource.uuid,
          image,
        },
      }),
    };
  }

  ctx.operations.register("coolify.resource-deploy", {
    run: (input, c) => onConnection(input, c, "deploy"),
    describe: async (input) => {
      const resource = await lifecycle.authorize(
        connectionIdInput(input),
        text(input.uuid),
      );
      return describeDeploy(resource);
    },
  });

  ctx.operations.register("coolify.resource-restart", {
    run: (input, c) => onConnection(input, c, "restart"),
  });

  ctx.operations.register("coolify.resource-action", {
    run: (input, c) => {
      const verb = input.action;
      if (verb !== "start" && verb !== "stop") {
        throw new ConnectionError("invalid-input", "action is start or stop");
      }
      return onConnection(input, c, verb);
    },
  });
}
