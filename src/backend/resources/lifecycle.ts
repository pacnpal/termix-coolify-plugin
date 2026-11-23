import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import en from "../../../locales/en.json";
import {
  isCoolifyDeploymentStatus,
  isFinalDeployment,
  isSkippedDeployment,
  isSuccessfulDeployment,
} from "../../shared/deployment-status.js";
import type { DeployActivity } from "../activity.js";
import type { CoolifyApi } from "../coolify/api.js";
import type { ResourceDto } from "../coolify/dto.js";
import { CoolifyError } from "../coolify/http.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import type { Events } from "../events/service.js";
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

const POLL_MS = 5_000;
const MAX_WAIT_MS = 30 * 60_000;

/** A wait that reached its limit while the deployment had not ended. */
export interface WaitTimeout {
  /** How long the run waited, in whole minutes. */
  minutes: number;
  /** The plugin's own route for the deployment, or null when there is none. */
  link: string | null;
}

/** A deployment's last status in words (locales), never Coolify's text. */
function statusWords(status: string): string {
  const words = en.deployments.status as Record<string, string>;
  return isCoolifyDeploymentStatus(status)
    ? words[status].toLowerCase()
    : "unfinished";
}

function waitTimeoutMessage(
  name: string,
  status: string,
  { minutes, link }: WaitTimeout,
): string {
  const time = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return (
    `The deployment of ${name} was still ${statusWords(status)} after ${time}, ` +
    `so the run stopped waiting; the deployment has not ended. ` +
    (link ? `Follow it at ${link}` : "Follow it in Coolify")
  );
}

/**
 * A deploy that was waited on and did not end with a successful build: a
 * failed run. A deployment Coolify skipped has its own cause, `skipped`, and
 * says so in words; failed and cancelled ones are `deployment-failed`. A wait
 * that reached its limit while the deployment still ran is `wait-timeout`,
 * with the last status in words and a link to the deployment.
 */
export class DeploymentFailedError extends Error {
  readonly code: "deployment-failed" | "skipped" | "wait-timeout";
  readonly status: string;

  constructor(name: string, status: string, timedOut?: WaitTimeout) {
    const skipped = !timedOut && isSkippedDeployment(status);
    let message: string;
    if (timedOut) message = waitTimeoutMessage(name, status, timedOut);
    else if (skipped) {
      message = `Coolify skipped the deployment of ${name}, so no new build ran`;
    } else message = `The deployment of ${name} ended as ${status}`;
    super(message);
    this.name = "DeploymentFailedError";
    if (timedOut) this.code = "wait-timeout";
    else this.code = skipped ? "skipped" : "deployment-failed";
    this.status = status;
  }
}

export interface LifecycleDeps {
  connections: Connections;
  resources: Resources;
  sync: Pick<Sync, "linkOfHost" | "linkedHostFor">;
  /** The post-start hook every deploy path shares (recent activity). */
  deployed: DeployActivity;
  /**
   * The event pipeline: a waited deploy hands it the deployment's end, so a
   * poll that sees the same deployment sends no second event.
   */
  events: Pick<Events, "ingest">;
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
  const { connections, resources, sync, deployed, events } = deps;
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

  /**
   * The plugin's own route for a deployment (GET answers its status and
   * build log). It serves applications only, and is built from checked ids
   * only, never from Coolify's text.
   */
  function deploymentLink(
    connectionId: number,
    resource: ResourceDto,
    deploymentUuid: string,
  ): string | null {
    if (resource.kind !== "application") return null;
    if (!UUID.test(resource.uuid) || !UUID.test(deploymentUuid)) return null;
    return (
      `/plugin-api/${ctx.pluginId}/connections/${connectionId}` +
      `/resources/${resource.uuid}/deployments/${deploymentUuid}`
    );
  }

  /**
   * Polls the deployment until it ends or the wait reaches its limit, and
   * answers its last status. A status that isn't final means the limit was
   * reached: `run` fails that with `wait-timeout`.
   */
  async function waitFor(
    api: CoolifyApi,
    deploymentUuid: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const started = Date.now();
    for (;;) {
      signal?.throwIfAborted();
      const { status } = await api.deployment(deploymentUuid);
      if (isFinalDeployment(status)) return status;
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
     * follows the deployment until it reaches any final status
     * (shared/deployment-status.ts) and hands the event pipeline
     * deployment-finished for a successful build, or deployment-failed and
     * then throws
     * DeploymentFailedError (cause `skipped` when Coolify skipped it). A
     * deployment still running when the wait reaches its limit (30 minutes)
     * emits nothing and throws DeploymentFailedError with cause
     * `wait-timeout`, its last status in words and a link to it. The cached
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
      // The revision before the client: if the target changes in between,
      // the event is about the new target under the old revision, and the
      // pipeline drops it rather than keep it.
      const revision = await connections.revision(connectionId);
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
      // The shared post-start hook, once Coolify accepted the deploy,
      // whatever a wait finds later (as for deploy by tag and rollback).
      if (verb === "deploy") {
        await deployed(connectionId, [
          {
            uuid: resource.uuid,
            name: resource.name,
            kind: resource.kind,
            deploymentUuid: result.deploymentUuid,
            hostId: opts.hostId,
            serverUuid: resource.serverUuid,
          },
        ]);
      }
      if (verb !== "deploy" || !opts.wait || !result.deploymentUuid) {
        return result;
      }
      let status: string;
      try {
        status = await waitFor(api, result.deploymentUuid, opts.signal);
      } finally {
        await resources.invalidate(connectionId);
      }
      // A wait that reached its limit is a failed run of its own, with no
      // event: the deployment itself has not ended.
      if (!isFinalDeployment(status)) {
        throw new DeploymentFailedError(resource.name, status, {
          minutes: Math.max(1, Math.round(maxWaitMs / 60_000)),
          link: deploymentLink(connectionId, resource, result.deploymentUuid),
        });
      }
      // Every final status is one event: finished for a successful build,
      // failed for the rest (failed, cancelled, skipped). It goes through
      // the pipeline, deduped by the deployment's uuid, so a poll that sees
      // the same deployment end sends nothing more. The pipeline gives it
      // the server's Linked host.
      const failed = !isSuccessfulDeployment(status);
      if (revision) {
        await events.ingest(
          connectionId,
          {
            kind: failed ? "deployment-failed" : "deployment-finished",
            source: "poll",
            resourceUuid: resource.uuid,
            serverUuid: resource.serverUuid,
            deploymentUuid: result.deploymentUuid,
            name: resource.name,
            status,
          },
          { revision },
        );
      }
      if (failed) throw new DeploymentFailedError(resource.name, status);
      return { ...result, status };
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
