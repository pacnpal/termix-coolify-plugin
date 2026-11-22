import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { ConnectionError } from "../connections/service.js";
import { failedOutcome, uuidParam } from "../resources/routes.js";
import { DeploymentError, readPaging, type Deployments } from "./service.js";

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/** A deployment uuid from the path; anything else reads as missing. */
function deploymentParam(req: Request): string {
  const raw = String(req.params.deploymentUuid ?? "");
  if (!UUID.test(raw)) {
    throw new ConnectionError("not-found", "Coolify deployment not found");
  }
  return raw;
}

function query(value: unknown): unknown {
  return typeof value === "string" ? value : undefined;
}

type Handler = (req: Request, res: Response) => Promise<void>;

/** Like `safe`, with a DeploymentError answered with its own code. */
function safe(ctx: PluginContext, fn: Handler): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof DeploymentError) {
        res.status(err.status).json({ error: err.message, cause: err.code });
        return;
      }
      sendError(ctx, res, err);
    }
  };
}

/**
 * An application's deployments: history (view), one deployment with its
 * build log (operate: logs hold secrets) and cancel (operate, through the
 * coolify.deployment-cancel action so the press lands in run history).
 */
export function registerDeploymentRoutes(
  router: Router,
  ctx: PluginContext,
  deployments: Deployments,
): void {
  const view = ctx.rbac.require("view") as never;
  const operate = ctx.rbac.require("operate") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/deployments:
   *   get:
   *     summary: A page of an application's deployment history, newest first
   *     description: >-
   *       Reads Coolify's per-application deployments list. Needs
   *       coolify.view and any access to the connection; the uuid must be
   *       one of that connection's own applications (services and databases
   *       have no deployments). Rows carry no build log.
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
   *       - in: query
   *         name: skip
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *       - in: query
   *         name: take
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 50
   *           default: 10
   *     responses:
   *       200:
   *         description: "{ rows, count, skip, take }; count is Coolify's total, or null"
   *       400:
   *         description: A bad skip or take
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: >-
   *           No such application on this connection, or another user's
   *           connection
   *       409:
   *         description: target-changed, the connection changed meanwhile
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/deployments",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      const paging = readPaging({
        skip: query(req.query.skip),
        take: query(req.query.take),
      });
      res.json(await deployments.list(id, uuid, paging));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/deployments/{deploymentUuid}:
   *   get:
   *     summary: One deployment of an application, with its build log
   *     description: >-
   *       Needs coolify.operate and the owner or an operate grant: build
   *       logs hold secrets. The deployment must belong to the application
   *       in the path. Coolify's JSON log lines come parsed, oldest first,
   *       at most 5,000 (the last ones), each with hidden set as Coolify
   *       has it. Every output and command is redacted: the connection's
   *       token and Access secret, URL passwords, credential query
   *       parameters, secret-named fields and Authorization credentials.
   *       log is null when the token can't read build logs (read:sensitive).
   *       The Deployments view polls this every 2 seconds until final.
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
   *       - in: path
   *         name: deploymentUuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: >-
   *           { deployment, log: { lines, truncated } | null, final,
   *           cancellable }
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: >-
   *           No such deployment of this application, or no such application
   *           or connection
   *       409:
   *         description: target-changed, the connection changed meanwhile
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/deployments/:deploymentUuid",
    operate,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      res.json(
        await deployments.get(id, deploymentParam(req), {
          resourceUuid: uuid,
        }),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/deployments/{deploymentUuid}/cancel:
   *   post:
   *     summary: Cancel a queued or running deployment of an application
   *     description: >-
   *       Needs coolify.operate and the owner or an operate grant. Runs
   *       coolify.deployment-cancel, confirmed (the UI asks first). The
   *       connection and the caller's grant are checked again after every
   *       step and right before Coolify is asked.
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
   *       - in: path
   *         name: deploymentUuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ deploymentUuid, status }"
   *       202:
   *         description: Waiting for approval, with the run id
   *       403:
   *         description: Missing coolify.operate, or a view grant
   *       404:
   *         description: >-
   *           No such deployment of this application, or no such application
   *           or connection
   *       409:
   *         description: >-
   *           deployment-ended (it can't be cancelled any more) or
   *           target-changed
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.post(
    "/connections/:id/resources/:uuid/deployments/:deploymentUuid/cancel",
    operate,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const uuid = uuidParam(req);
      const deploymentUuid = deploymentParam(req);
      // Refused here, before the action and before any Coolify request:
      // through core, a refusal thrown inside the action can come back as a
      // plain error (a 502).
      await deployments.authorize(id, "operate", uuid);
      const outcome = await ctx.operations.run("coolify.deployment-cancel", {
        input: { connectionId: String(id), uuid, deploymentUuid },
        confirmed: true,
      });
      const failure = failedOutcome(outcome);
      if (failure) {
        res.status(failure.status).json(failure.body);
        return;
      }
      const data = (outcome.data ?? {}) as { status?: unknown };
      res.json({
        deploymentUuid,
        status: typeof data.status === "string" ? data.status : null,
      });
    }),
  );
}
