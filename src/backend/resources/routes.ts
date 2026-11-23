import type { Request, Router } from "express";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { forRevision } from "../connections/hold.js";
import { ConnectionError, type Connections } from "../connections/service.js";
import { idParam, safe } from "../connections/routes.js";
import {
  CAUSE_MESSAGES,
  CoolifyError,
  toRouteError,
  type CoolifyCause,
} from "../coolify/http.js";
import { countResources } from "../../shared/resource-health.js";
import type { ServerStatuses } from "../ops/signals.js";
import {
  DeploymentFailedError,
  type Lifecycle,
  type LifecycleVerb,
} from "./lifecycle.js";
import type { Resources } from "./service.js";

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/** A Coolify uuid from the path; anything else reads as missing. */
export function uuidParam(req: Request, name = "uuid"): string {
  const raw = String(req.params[name] ?? "");
  if (!UUID.test(raw)) {
    throw new ConnectionError("not-found", "Coolify resource not found");
  }
  return raw;
}

function flag(value: unknown): boolean {
  return value === "true" || value === "1";
}

export function registerResourceRoutes(
  router: Router,
  ctx: PluginContext,
  resources: Resources,
  connections: Pick<Connections, "revision">,
): void {
  const view = ctx.rbac.require("view") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources:
   *   get:
   *     summary: List a connection's applications, services and databases
   *     description: >-
   *       One list from Coolify's per-type lists, each service followed by its
   *       Parts (parentUuid set). Stripped DTOs only: no environment values,
   *       keys, tokens or compose files. Statuses are cached for 20 seconds;
   *       refresh=true fetches again. counts leaves Parts out.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: serverUuid
   *         schema:
   *           type: string
   *       - in: query
   *         name: refresh
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: >-
   *           { rows, counts: { running, degraded, stopped, deploying },
   *           fetchedAt }
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: target-changed, the connection was repointed during the read
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      // The list is answered only for the target it was read from: load()
      // returns what it fetched even across a repoint.
      const list = await forRevision(connections, id, () =>
        resources.load(id, { refresh: flag(req.query.refresh) }),
      );
      const serverUuid =
        typeof req.query.serverUuid === "string" ? req.query.serverUuid : "";
      const rows = serverUuid
        ? list.rows.filter((r) => r.serverUuid === serverUuid)
        : list.rows;
      res.json({
        rows,
        counts: countResources(rows),
        fetchedAt: new Date(list.fetchedAt).toISOString(),
      });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}:
   *   get:
   *     summary: Read one resource or service Part
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The resource, stripped of every secret
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: >-
   *           No such resource, no such connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const found = await resources.get(id, uuidParam(req), {
        refresh: flag(req.query.refresh),
      });
      if (!found) {
        throw new ConnectionError("not-found", "Coolify resource not found");
      }
      res.json(found);
    }),
  );
}

/** Plugin refusals a run can come back with, by error code. */
const REFUSALS: Record<string, number> = {
  "invalid-input": 400,
  forbidden: 403,
  "not-found": 404,
  "not-linked": 404,
  "target-changed": 409,
  "deployment-ended": 409,
  "targets-changed": 409,
};

/**
 * A waited deploy that was still running when its wait reached the limit:
 * the run reached Coolify and the deployment goes on, so it is neither a
 * refusal nor a run that did not happen.
 */
const WAIT_TIMEOUT = {
  status: 504,
  body: {
    error: "The deployment was still running when the wait ended",
    cause: "wait-timeout",
  },
};

/**
 * A failed run as core reports it, from what a run threw: a timed-out wait
 * keeps its cause. Anything else is thrown on, to the route's own mapping.
 */
function thrownOutcome(err: unknown): PluginOperationOutcome {
  if (err instanceof DeploymentFailedError && err.code === "wait-timeout") {
    return { runId: null, status: "failed", errorCode: err.code };
  }
  throw err;
}

/**
 * The answer for an operation run that did not succeed, when core reports it
 * as an outcome rather than a throw. Only fixed texts go out.
 */
export function failedOutcome(
  outcome: PluginOperationOutcome,
): { status: number; body: Record<string, unknown> } | null {
  if (outcome.approvalId || /approval|pending|waiting/i.test(outcome.status)) {
    return {
      status: 202,
      body: {
        status: "pending",
        runId: outcome.runId,
        deploymentUuid: null,
      },
    };
  }
  const failed =
    Boolean(outcome.error || outcome.errorCode) ||
    /fail|error|denied|refused|reject|cancel|timeout/i.test(outcome.status);
  if (!failed) return null;
  const code = String(outcome.errorCode ?? "");
  if (code === "wait-timeout") return WAIT_TIMEOUT;
  if (code in CAUSE_MESSAGES) {
    return toRouteError(new CoolifyError(code as CoolifyCause, 0));
  }
  const byMessage = (Object.keys(CAUSE_MESSAGES) as CoolifyCause[]).find(
    (cause) => CAUSE_MESSAGES[cause] === outcome.error,
  );
  if (byMessage) return toRouteError(new CoolifyError(byMessage, 0));
  if (REFUSALS[code]) {
    return {
      status: REFUSALS[code],
      body: { error: "The action was refused", cause: code },
    };
  }
  return {
    status: /denied|refused|reject/i.test(outcome.status) ? 403 : 502,
    body: { error: "The action did not run", cause: code || "upstream" },
  };
}

function forceOf(body: unknown): boolean {
  const force =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).force
      : undefined;
  if (force === undefined || force === null) return false;
  if (typeof force !== "boolean") {
    throw new ConnectionError("invalid-input", "force must be true or false");
  }
  return force;
}

/**
 * Each server's reachability and degraded resource count, for the status dot
 * on Linked host rows. Both come from the shared caches the status signals
 * read (servers a minute, resources 20 seconds), so every host row of a
 * connection costs one request here and at most one Coolify read per list.
 * `servers` is null when the token can't read servers (a scoped token);
 * `degraded` is null when the resources can't be read. When neither can,
 * the resources error answers (404 for another user's connection).
 */
export function registerServerHealthRoutes(
  router: Router,
  ctx: PluginContext,
  deps: {
    resources: Pick<Resources, "load">;
    servers: Pick<ServerStatuses, "list">;
  },
): void {
  const view = ctx.rbac.require("view") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/server-health:
   *   get:
   *     summary: Each Coolify server's reachability and degraded count
   *     description: >-
   *       For the status dot on Linked host rows. Reads the cached server
   *       statuses (a minute) and resources (20 seconds), so one request
   *       serves every host of the connection. servers is null when the token
   *       can't read servers; degraded (resources by server uuid, Parts left
   *       out, exited never degraded) is null when resources can't be read.
   *       No addresses, keys or tokens.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: >-
   *           { servers: [{ uuid, reachable, usable }] or null,
   *           degraded: { serverUuid: count } or null }
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/server-health",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      // Each checks the actor's access to the connection before reading Coolify.
      const [list, servers] = await Promise.allSettled([
        deps.resources.load(id),
        deps.servers.list(id),
      ]);
      if (list.status === "rejected" && servers.status === "rejected") {
        throw list.reason;
      }
      let degraded: Record<string, number> | null = null;
      if (list.status === "fulfilled") {
        const byServer = new Map<string, typeof list.value.rows>();
        for (const row of list.value.rows) {
          if (!row.serverUuid) continue;
          const rows = byServer.get(row.serverUuid) ?? [];
          rows.push(row);
          byServer.set(row.serverUuid, rows);
        }
        degraded = Object.fromEntries(
          [...byServer].map(([uuid, rows]) => [
            uuid,
            countResources(rows).degraded,
          ]),
        );
      }
      res.json({
        servers:
          servers.status === "fulfilled"
            ? servers.value.map((s) => ({
                uuid: s.uuid,
                reachable: s.reachable,
                usable: s.usable,
              }))
            : null,
        degraded,
      });
    }),
  );
}

/**
 * The lifecycle routes. Each checks the resource (lifecycle.authorize), then
 * runs the matching action through ctx.operations.run so the press lands in
 * history: the resource-scope action on the server's Linked host, or the
 * server-scope one when there is no Linked host. Stop runs confirmed, since
 * the UI asked first.
 */
export function registerLifecycleRoutes(
  router: Router,
  ctx: PluginContext,
  lifecycle: Lifecycle,
): void {
  const operate = ctx.rbac.require("operate") as never;

  function handle(verb: LifecycleVerb) {
    return safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      const force = verb === "deploy" ? forceOf(req.body) : false;
      const resource = await lifecycle.authorize(id, uuid);
      const hostId = await lifecycle.hostOf(id, resource);
      let actionId: string;
      const options: PluginOperationInvokeOptions = {};
      if (hostId !== null) {
        actionId = `coolify.${verb}`;
        options.hostId = hostId;
        options.resourceKey = uuid;
        options.input = verb === "deploy" ? { force } : {};
      } else {
        const base = { connectionId: String(id), uuid };
        if (verb === "deploy") {
          actionId = "coolify.resource-deploy";
          options.input = { ...base, force };
        } else if (verb === "restart") {
          actionId = "coolify.resource-restart";
          options.input = base;
        } else {
          actionId = "coolify.resource-action";
          options.input = { ...base, action: verb };
        }
      }
      if (verb === "stop" || actionId === "coolify.resource-action") {
        options.confirmed = true;
      }
      const outcome = await ctx.operations
        .run(actionId, options)
        .catch(thrownOutcome);
      const failure = failedOutcome(outcome);
      if (failure) {
        res.status(failure.status).json(failure.body);
        return;
      }
      const data = (outcome.data ?? {}) as { deploymentUuid?: unknown };
      res.json({
        deploymentUuid:
          typeof data.deploymentUuid === "string" ? data.deploymentUuid : null,
      });
    });
  }

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/start:
   *   post:
   *     summary: Start a resource or service Part
   *     description: >-
   *       Needs coolify.operate and the owner or an operate grant. Runs
   *       coolify.start on the server's Linked host, or coolify.resource-action
   *       when there is none.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ deploymentUuid: null }"
   *       202:
   *         description: Waiting for approval, with the run id
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: No such resource on this connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause such as forbidden-ability
   */
  router.post(
    "/connections/:id/resources/:uuid/start",
    operate,
    handle("start"),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/stop:
   *   post:
   *     summary: Stop a resource or service Part
   *     description: >-
   *       Needs coolify.operate and the owner or an operate grant. Runs
   *       coolify.stop on the server's Linked host, or coolify.resource-action
   *       when there is none. The UI confirms first, naming the resource.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ deploymentUuid: null }"
   *       202:
   *         description: Waiting for approval, with the run id
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: No such resource on this connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause such as forbidden-ability
   */
  router.post("/connections/:id/resources/:uuid/stop", operate, handle("stop"));

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/restart:
   *   post:
   *     summary: Restart a resource or service Part
   *     description: >-
   *       Needs coolify.operate and the owner or an operate grant. Runs
   *       coolify.restart on the server's Linked host, or
   *       coolify.resource-restart when there is none. A Part restarts on
   *       its own, through its service.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ deploymentUuid: null }"
   *       202:
   *         description: Waiting for approval, with the run id
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: No such resource on this connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause such as forbidden-ability
   */
  router.post(
    "/connections/:id/resources/:uuid/restart",
    operate,
    handle("restart"),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/deploy:
   *   post:
   *     summary: Deploy a resource, optionally with a force rebuild
   *     description: >-
   *       Needs coolify.operate and the owner or an operate grant. Calls
   *       Coolify's /deploy with the uuid and force. Runs coolify.deploy on
   *       the server's Linked host, or coolify.resource-deploy when there is
   *       none. A Part deploys its service.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               force:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: "{ deploymentUuid }: the queued deployment, or null"
   *       202:
   *         description: Waiting for approval, with the run id
   *       400:
   *         description: force is not true or false
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: No such resource on this connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause such as forbidden-ability
   *       504:
   *         description: >-
   *           cause wait-timeout: a run that waited on the deployment reached
   *           its 30 minute limit while the deployment was still running
   */
  router.post(
    "/connections/:id/resources/:uuid/deploy",
    operate,
    handle("deploy"),
  );
}
