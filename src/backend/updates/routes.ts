import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { UpdateError, type Updates } from "./service.js";

/** Like connections' `safe`, with UpdateError's own statuses. Never throws. */
function handle(
  ctx: PluginContext,
  fn: (req: Request, res: Response) => Promise<unknown>,
) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof UpdateError) {
        res.status(err.status).json({ error: err.message, cause: err.code });
        return;
      }
      sendError(ctx, res, err);
    }
  };
}

export function registerUpdateRoutes(
  router: Router,
  ctx: PluginContext,
  updates: Updates,
): void {
  const view = ctx.rbac.require("view") as never;
  const operate = ctx.rbac.require("operate") as never;
  const administer = ctx.rbac.require("administer") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/updates:
   *   get:
   *     summary: Read a Coolify server's pending package updates
   *     description: >-
   *       Coolify's last patch check (updates, security updates, the packages
   *       with their risk, reboot required and when it ran) next to the last
   *       check this plugin ran itself, labelled with the path it took
   *       (package-manager or ssh). Coolify's record works without a Linked
   *       host. Read only.
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
   *         description: "{ server, hostId, coolify, fresh, via }"
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection or server, or another user's
   *       502:
   *         description: Coolify answered with an error, with its cause
   */
  router.get(
    "/connections/:id/servers/:uuid/updates",
    view,
    handle(ctx, async (req, res) => {
      res.json(await updates.status(idParam(req), req.params.uuid));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/updates/check:
   *   post:
   *     summary: Check a Coolify server for package updates now
   *     description: >-
   *       Runs the Package Manager plugin's package-manager.list-updates on the
   *       Linked host when that plugin runs, otherwise refreshes the package
   *       lists over SSH with fixed commands. Keeps the result and says which
   *       path ran. Needs connect access to the Linked host.
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
   *         description: "{ via, fresh }"
   *       403:
   *         description: Missing coolify.operate, or no connect access to the Linked host
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: No Linked host (not-linked), no known package manager, or the plugin list can't be read (companions-unknown)
   *       502:
   *         description: SSH or the Package Manager plugin failed, or the package lists couldn't be read (check-failed)
   */
  router.post(
    "/connections/:id/servers/:uuid/updates/check",
    operate,
    handle(ctx, async (req, res) => {
      res.json(await updates.check(idParam(req), req.params.uuid));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/updates/install:
   *   post:
   *     summary: Install every pending package update on a Coolify server
   *     description: >-
   *       Needs confirm true. Runs package-manager.upgrade-all on the Linked
   *       host when the Package Manager plugin runs (its own rules apply),
   *       otherwise upgrades over SSH as root or with passwordless sudo.
   *       Updates of Docker packages restart every container on the server.
   *       Needs edit access to the Linked host.
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
   *             required: [confirm]
   *             properties:
   *               confirm:
   *                 type: boolean
   *                 enum: [true]
   *     responses:
   *       200:
   *         description: "{ via, summary, changed, pending, output }"
   *       400:
   *         description: confirm is not true (confirm-required)
   *       403:
   *         description: Missing coolify.operate, or no edit access to the Linked host
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: No Linked host (not-linked), no known package manager, the plugin list can't be read (companions-unknown), or sudo needs a password
   *       502:
   *         description: SSH or the Package Manager plugin failed, or the package lists couldn't be read (check-failed)
   */
  router.post(
    "/connections/:id/servers/:uuid/updates/install",
    operate,
    handle(ctx, async (req, res) => {
      res.json(
        await updates.install(idParam(req), req.params.uuid, req.body ?? {}),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/reboot:
   *   post:
   *     summary: Reboot a Coolify server
   *     description: >-
   *       confirmName must be the server's exact name in Coolify. Reboots over
   *       SSH on the Linked host; every Coolify application, service and
   *       database on the server goes down until it is back. Needs
   *       coolify.administer and edit access to the Linked host.
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
   *             required: [confirmName]
   *             properties:
   *               confirmName:
   *                 type: string
   *     responses:
   *       200:
   *         description: "{ via: ssh, summary }"
   *       400:
   *         description: confirmName is not the server's name (name-mismatch)
   *       403:
   *         description: Missing coolify.administer, or no edit access to the Linked host
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: No Linked host (not-linked), or sudo needs a password
   *       502:
   *         description: SSH failed
   */
  router.post(
    "/connections/:id/servers/:uuid/reboot",
    administer,
    handle(ctx, async (req, res) => {
      res.json(
        await updates.reboot(idParam(req), req.params.uuid, req.body ?? {}),
      );
    }),
  );
}
