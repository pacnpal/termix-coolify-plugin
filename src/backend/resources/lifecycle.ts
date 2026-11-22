import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { recordActivity } from "../activity.js";
import type { CoolifyApi } from "../coolify/api.js";
import type { ResourceDto } from "../coolify/dto.js";
import { CoolifyError } from "../coolify/http.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import type { Sync } from "../sync/service.js";
import type { Resources } from "./service.js";

export type LifecycleVerb = "start" | "stop" | "restart" | "deploy";

export const LIFECYCLE_VERBS: readonly LifecycleVerb[] = [
  "start",
  "stop",
  "restart",
  "deploy",
];

/** What lifecycle needs to know about a resource to pick its endpoint. */
export type LifecycleTarget = Pick<ResourceDto, "uuid" | "kind" | "parentUuid">;

const isPart = (r: LifecycleTarget) =>
  r.kind === "service-application" || r.kind === "service-database";

/** Finds a uuid in the connection's per-type lists. Not found is a CoolifyError. */
async function find(api: CoolifyApi, uuid: string): Promise<LifecycleTarget> {
  const [applications, services, databases] = await Promise.all([
    api.applications(),
    api.services(),
    api.databases(),
  ]);
  const found = [...applications, ...services, ...databases].find(
    (r) => r.uuid === uuid,
  );
  if (!found) throw new CoolifyError("not-found", 404);
  return found;
}

/**
 * Starts, stops, restarts or deploys a resource or a service Part. A Part
 * starts, stops and restarts through its service's per-Part endpoint, and a
 * deploy of a Part deploys its service. Without `opts.resource` the uuid is
 * looked up in Coolify's lists first. Coolify failures (a 403 is
 * `forbidden-ability`) come through as the CoolifyError the request layer
 * made, unchanged.
 */
export async function lifecycle(
  api: CoolifyApi,
  uuid: string,
  action: LifecycleVerb,
  opts: { force?: boolean; resource?: LifecycleTarget } = {},
): Promise<{ deploymentUuid: string | null }> {
  const target =
    opts.resource && opts.resource.uuid === uuid
      ? opts.resource
      : await find(api, uuid);
  if (action === "deploy") {
    const deployUuid =
      isPart(target) && target.parentUuid ? target.parentUuid : target.uuid;
    const { deploymentUuids } = await api.deploy(deployUuid, {
      force: opts.force === true,
    });
    return { deploymentUuid: deploymentUuids[0] ?? null };
  }
  await api.lifecycle(target.kind, target.uuid, action, {
    parentUuid: target.parentUuid ?? undefined,
  });
  return { deploymentUuid: null };
}

/** Grant levels that may start, stop, restart and deploy (with the owner). */
const OPERATE_LEVELS: ReadonlySet<AccessLevel> = new Set([
  "owner",
  "operate",
  "configure",
]);

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/** Deployment statuses that end a wait. */
const FINISHED = new Set(["finished", "success"]);
const FAILED = new Set(["failed", "error", "cancelled", "cancelled-by-user"]);

const POLL_MS = 5_000;
const MAX_WAIT_MS = 30 * 60_000;

/** A deploy that was waited on and did not finish: a failed run. */
export class DeploymentFailedError extends Error {
  readonly code = "deployment-failed";
  readonly status: string;

  constructor(name: string, status: string) {
    super(`The deployment of ${name} ended as ${status}`);
    this.name = "DeploymentFailedError";
    this.status = status;
  }
}

export interface LifecycleDeps {
  connections: Connections;
  resources: Resources;
  sync: Pick<Sync, "linkOfHost" | "linkedHostFor">;
  /** Waits between deployment polls; tests pass one that doesn't. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

export interface LifecycleOutcome {
  deploymentUuid: string | null;
  /** The deployment's last status, when the deploy was waited on. */
  status?: string;
}

const notFound = () =>
  new ConnectionError("not-found", "Coolify resource not found");

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Who may run lifecycle actions, on what, and the run itself. Every path
 * (routes, resource-scope and server-scope actions) goes through
 * `authorize`: the coolify.operate permission, the owner or a grant of at
 * least operate on the connection, and a uuid that is one of that
 * connection's own resources. Anything else is refused before Coolify is
 * called.
 */
export function createLifecycle(ctx: PluginContext, deps: LifecycleDeps) {
  const { connections, resources, sync } = deps;
  const sleep = deps.sleep ?? abortableSleep;
  const pollMs = deps.pollMs ?? POLL_MS;
  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;

  async function authorize(
    connectionId: number,
    uuid: string,
  ): Promise<ResourceDto> {
    if (!(await ctx.rbac.has("operate"))) {
      throw new ConnectionError(
        "forbidden",
        "Starting, stopping, restarting and deploying need the Operate Coolify permission",
      );
    }
    const access = await connections.access(connectionId);
    if (!access) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    if (!OPERATE_LEVELS.has(access)) {
      throw new ConnectionError(
        "forbidden",
        "Your access to this connection doesn't include operating its resources",
      );
    }
    if (typeof uuid !== "string" || !UUID.test(uuid)) throw notFound();
    // The connection's own list, read with its own token: a uuid from any
    // other connection is not in it. A miss is checked once more, fresh.
    const found =
      (await resources.get(connectionId, uuid)) ??
      (await resources.get(connectionId, uuid, { refresh: true }));
    if (!found) throw notFound();
    return found;
  }

  async function waitFor(
    api: CoolifyApi,
    deploymentUuid: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const started = Date.now();
    for (;;) {
      signal?.throwIfAborted();
      const { status } = await api.deployment(deploymentUuid);
      if (FINISHED.has(status) || FAILED.has(status)) return status;
      if (Date.now() - started >= maxWaitMs) return status;
      await sleep(pollMs, signal);
    }
  }

  return {
    authorize,

    /**
     * A Linked host's resource: the host's link, the actor's access to its
     * connection, and a resource that runs on that host's own server.
     */
    async onHost(
      hostId: number | undefined,
      uuid: string | undefined,
    ): Promise<{ connectionId: number; resource: ResourceDto }> {
      const link = hostId ? await sync.linkOfHost(hostId) : null;
      if (!link) {
        throw new ConnectionError(
          "not-linked",
          "This host is not linked to a Coolify server",
        );
      }
      const resource = await authorize(link.connectionId, uuid ?? "");
      if (resource.serverUuid !== link.serverUuid) throw notFound();
      return { connectionId: link.connectionId, resource };
    },

    /** The Linked host of the resource's server, or null. */
    async hostOf(
      connectionId: number,
      resource: ResourceDto,
    ): Promise<number | null> {
      return resource.serverUuid
        ? sync.linkedHostFor(connectionId, resource.serverUuid)
        : null;
    },

    /**
     * Runs one action on an authorized resource. A deploy with `wait`
     * follows the deployment until it ends and emits deployment-finished or
     * deployment-failed (then throws DeploymentFailedError). The cached
     * resource list, and any fetch still running for it, is dropped once
     * Coolify was asked, even when it refused (a timeout may still have
     * changed something), and again when a waited deploy ends, so the next
     * read shows the change.
     */
    async run(
      connectionId: number,
      resource: ResourceDto,
      verb: LifecycleVerb,
      opts: {
        force?: boolean;
        wait?: boolean;
        signal?: AbortSignal;
        hostId?: number;
      } = {},
    ): Promise<LifecycleOutcome> {
      opts.signal?.throwIfAborted();
      const api = await connections.api(connectionId);
      let result: { deploymentUuid: string | null };
      try {
        result = await lifecycle(api, resource.uuid, verb, {
          force: opts.force,
          resource,
        });
      } finally {
        await resources.invalidate(connectionId);
      }
      // A deploy that started is "Deployed <name>" in the Linked host's
      // recent activity; a waited one only once the run didn't fail.
      const started = verb === "deploy" && Boolean(result.deploymentUuid);
      if (!started || !opts.wait) {
        if (started) {
          await recordActivity(ctx, opts.hostId, "deploy", resource.name);
        }
        return result;
      }
      let status: string;
      try {
        status = await waitFor(api, result.deploymentUuid, opts.signal);
      } finally {
        await resources.invalidate(connectionId);
      }
      const failed = FAILED.has(status);
      if (failed || FINISHED.has(status)) {
        await ctx.operations.emit(
          failed ? "coolify.deployment-failed" : "coolify.deployment-finished",
          {
            connectionId,
            uuid: resource.uuid,
            name: resource.name,
            deploymentUuid: result.deploymentUuid,
            status,
          },
          opts.hostId ? { hostId: opts.hostId } : undefined,
        );
      }
      if (failed) throw new DeploymentFailedError(resource.name, status);
      await recordActivity(ctx, opts.hostId, "deploy", resource.name);
      return { ...result, status };
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
