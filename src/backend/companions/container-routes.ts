import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { ContainerError } from "../containers/service.js";
import { uuidParam } from "../resources/routes.js";
import type { ContainerCompanions } from "./container-service.js";

function partQuery(req: Request): string | undefined {
  const part = req.query.part;
  return typeof part === "string" && part !== "" ? part : undefined;
}

function fail(ctx: PluginContext, res: Response, err: unknown): void {
  if (err instanceof ContainerError) {
    res
      .status(err.status)
      .json({ error: err.message, cause: err.code, ...err.extra });
    return;
  }
  sendError(ctx, res, err);
}

type Handler = (req: Request, res: Response) => Promise<void>;

function guarded(ctx: PluginContext, fn: Handler): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(ctx, res, err);
    }
  };
}

/** 300 with `{ choices }` when several containers match, else 200. */
function answer(res: Response, body: object): void {
  if ("choices" in body) {
    res.status(300).json(body);
    return;
  }
  res.json(body);
}

/**
 * Routes for the companion plugins on a Resource's container. Each answers
 * 404 `{ cause: "companion-missing", plugin }` when that plugin isn't running.
 */
export function registerContainerCompanionRoutes(
  router: Router,
  ctx: PluginContext,
  companions: ContainerCompanions,
): void {
  const view = ctx.rbac.require("view") as never;
  const operate = ctx.rbac.require("operate") as never;

  /**
   * @openapi
   * /plugin-api/coolify/companions:
   *   get:
   *     summary: Which companion plugins are running
   *     description: >-
   *       One flag per companion feature (files, tunnels, reverseProxy, dns,
   *       uptime, logSearch, packageManager, securityCenter, hostMetrics,
   *       databases, backups), true when that plugin is installed and running.
   *       Cached for 60 seconds.
   *     tags:
   *       - Coolify
   *     responses:
   *       200:
   *         description: The flags
   *       403:
   *         description: Missing coolify.view
   */
  router.get(
    "/companions",
    view,
    guarded(ctx, async (_req, res) => {
      res.json(await companions.map());
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/paths:
   *   get:
   *     summary: Where a resource's files are on its server, for File Manager
   *     description: >-
   *       The resource's data folder (/data/coolify/applications/<uuid>,
   *       /data/coolify/services/<uuid> or /data/coolify/databases/<uuid>; a
   *       Part uses its service's), its compose file, and each storage's
   *       place on the server (a bind mount's or file's host path, or a
   *       Docker volume's _data folder), from Coolify's storages list
   *       without file contents. Needs File Manager, coolify.operate and the
   *       caller's own connect access to the Linked host.
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
   *         name: part
   *         schema:
   *           type: string
   *         description: A Part of the service in the path, by uuid
   *     responses:
   *       200:
   *         description: "{ hostId, dataDir, composeFile, volumes: string[] }"
   *       403:
   *         description: Missing coolify.operate, or no connect access to the Linked host (no-host-access)
   *       404:
   *         description: >-
   *           No such resource or connection, another user's, or File Manager
   *           isn't running (companion-missing, with plugin)
   *       409:
   *         description: not-linked (the server has no Linked host)
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/paths",
    operate,
    guarded(ctx, async (req, res) => {
      res.json(
        await companions.paths(idParam(req), uuidParam(req), partQuery(req)),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/tunnel:
   *   post:
   *     summary: Reach a container's port from the Termix server through Tunnels
   *     description: >-
   *       Reads the container's internal address with docker inspect over
   *       SSH, then asks Tunnels to forward the port through the Linked host,
   *       listening on the Termix server's 127.0.0.1. The forward is named
   *       web:<hostId>:coolify-<uuid> and isn't saved in the Tunnels list.
   *       Needs Tunnels, coolify.operate and the caller's own connect access
   *       to the Linked host.
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
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [port]
   *             properties:
   *               port:
   *                 type: integer
   *                 minimum: 1
   *                 maximum: 65535
   *               part:
   *                 type: string
   *               container:
   *                 type: string
   *                 description: A name from an earlier choices answer
   *     responses:
   *       200:
   *         description: "{ name, hostId, targetPort, bindHost, bindPort }"
   *       300:
   *         description: "{ choices: [{ name, running, part }] }: several containers match"
   *       400:
   *         description: A port that isn't an integer from 1 to 65535, or a bad body
   *       403:
   *         description: Missing coolify.operate, or no connect access to the Linked host (no-host-access)
   *       404:
   *         description: >-
   *           No such resource or connection, container-not-found, or Tunnels
   *           isn't running (companion-missing, with plugin)
   *       409:
   *         description: not-linked, not-running or host-key
   *       502:
   *         description: >-
   *           SSH or Tunnels failed, or bad-container-ip when docker inspect
   *           answers no IP address
   */
  router.post(
    "/connections/:id/resources/:uuid/tunnel",
    operate,
    guarded(ctx, async (req, res) => {
      answer(
        res,
        await companions.tunnelOpen(idParam(req), uuidParam(req), req.body),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/tunnel/{port}:
   *   delete:
   *     summary: Stop reaching a container from the Termix server
   *     description: >-
   *       Closes the Tunnels forward web:<hostId>:coolify-<uuid>. Needs
   *       Tunnels, coolify.operate and the caller's own connect access to the
   *       Linked host.
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
   *         name: port
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 65535
   *       - in: query
   *         name: part
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ name, closed: true }"
   *       400:
   *         description: A port that isn't an integer from 1 to 65535
   *       403:
   *         description: Missing coolify.operate, or no connect access to the Linked host (no-host-access)
   *       404:
   *         description: No such resource or connection, or Tunnels isn't running (companion-missing)
   *       409:
   *         description: not-linked
   *       502:
   *         description: Tunnels failed (companion-failed)
   */
  router.delete(
    "/connections/:id/resources/:uuid/tunnel/:port",
    operate,
    guarded(ctx, async (req, res) => {
      res.json(
        await companions.tunnelClose(
          idParam(req),
          uuidParam(req),
          String(req.params.port ?? ""),
          partQuery(req),
        ),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/web-ui:
   *   post:
   *     summary: A one-time signed-in URL to a container's web UI, through Reverse Proxy
   *     description: >-
   *       Reads the container's internal address with docker inspect over
   *       SSH and asks Reverse Proxy for a one-time signed-in URL to that
   *       port. No tunnel or public domain is needed. Refuses with
   *       proxy-not-configured while an admin hasn't set Reverse Proxy's
   *       Termix address and Web endpoint domain. Needs Reverse Proxy,
   *       coolify.operate and the caller's own connect access to the Linked
   *       host.
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
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [port]
   *             properties:
   *               port:
   *                 type: integer
   *                 minimum: 1
   *                 maximum: 65535
   *               scheme:
   *                 type: string
   *                 enum: [http, https]
   *               part:
   *                 type: string
   *               container:
   *                 type: string
   *     responses:
   *       200:
   *         description: "{ url }: open it once, it signs the caller in"
   *       300:
   *         description: "{ choices: [{ name, running, part }] }: several containers match"
   *       400:
   *         description: A bad port or scheme
   *       403:
   *         description: Missing coolify.operate, or no connect access to the Linked host (no-host-access)
   *       404:
   *         description: >-
   *           No such resource or connection, container-not-found, or Reverse
   *           Proxy isn't running (companion-missing, with plugin)
   *       409:
   *         description: proxy-not-configured, not-linked, not-running or host-key
   *       502:
   *         description: SSH or Reverse Proxy failed, or bad-container-ip
   */
  router.post(
    "/connections/:id/resources/:uuid/web-ui",
    operate,
    guarded(ctx, async (req, res) => {
      answer(
        res,
        await companions.webUi(idParam(req), uuidParam(req), req.body),
      );
    }),
  );
}
