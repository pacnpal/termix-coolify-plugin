import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, safe } from "../connections/routes.js";
import type { Alerts } from "./service.js";

/** Your own alert preferences for one connection (coolify.alert-prefs[-set]). */
export function registerAlertRoutes(
  router: Router,
  ctx: PluginContext,
  alerts: Alerts,
): void {
  const view = ctx.rbac.require("view") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/alert-prefs:
   *   get:
   *     summary: Your alert kinds for this connection
   *     description: >-
   *       The event kinds you get alerts for from this connection, through
   *       Termix's Alerts hub. Until you pick your own, the defaults apply:
   *       deploy failed, restart limit, server unreachable, backup failed,
   *       task failed, high disk, certificate problems and API token
   *       expiring. Only your own preferences; everyone with access to the
   *       connection has their own. Needs coolify.view and any access to the
   *       connection; another user's connection is 404.
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
   *         description: "{ connectionId, kinds, isDefault, defaults, available }"
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's connection
   *   put:
   *     summary: Set your alert kinds for this connection
   *     description: >-
   *       Body { "kinds": ["deployment-failed", ...] } picks the event kinds
   *       you get alerts for (an empty list turns them off for this
   *       connection); { "kinds": null } goes back to the defaults. Every
   *       kind must be a known event kind. Changes only your own
   *       preferences. Needs coolify.view and any access to the connection;
   *       another user's connection is 404.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - kinds
   *             properties:
   *               kinds:
   *                 type: array
   *                 nullable: true
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: "{ connectionId, kinds, isDefault, defaults, available }"
   *       400:
   *         description: kinds is missing, not a list, or names an unknown kind
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's connection
   */
  router.get(
    "/connections/:id/alert-prefs",
    view,
    safe(ctx, async (req, res) => {
      res.json(await alerts.prefs(idParam(req)));
    }),
  );

  router.put(
    "/connections/:id/alert-prefs",
    view,
    safe(ctx, async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Missing kinds is not null: it is refused, never read as a reset.
      res.json(await alerts.setPrefs(idParam(req), body.kinds));
    }),
  );
}
