import type { Request, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, safe } from "../connections/routes.js";
import { ConnectionError } from "../connections/service.js";
import { readChoices, type Sync } from "./service.js";

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

function uuidParam(req: Request): string {
  const raw = String(req.params.uuid ?? "");
  if (!UUID.test(raw)) {
    throw new ConnectionError(
      "not-linked",
      "This Coolify server has no Linked host",
    );
  }
  return raw;
}

export function registerSyncRoutes(
  router: Router,
  ctx: PluginContext,
  sync: Sync,
): void {
  const view = ctx.rbac.require("view") as never;
  const configure = ctx.rbac.require("configure") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers:
   *   get:
   *     summary: Preview host sync for a Coolify connection
   *     description: >-
   *       Each Coolify server with the Termix host it is or would become: new,
   *       linked, blocked (with a cause such as needs-address,
   *       needs-credential, needs-ssh-terminal, ssh-terminal-too-old or
   *       needs-ssh-terminal-to-clear-tunnel) or gone from Coolify. Changes
   *       nothing.
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
   *         description: One row per server, without any key or token
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   *       502:
   *         description: Coolify answered with an error, with its cause
   */
  router.get(
    "/connections/:id/servers",
    view,
    safe(ctx, async (req, res) => {
      res.json(await sync.preview(idParam(req)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/sync:
   *   post:
   *     summary: Create or update Linked hosts from Coolify servers
   *     description: >-
   *       Owner only. For each included server, creates or updates its Linked
   *       host in the Coolify folder and locks it. Rows that can't sync yet are
   *       reported with a cause while the others sync. Servers gone from
   *       Coolify are reported, never deleted. Copies each Coolify key into
   *       one Termix credential unless the admin turned key copy off.
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
   *             required: [choices]
   *             properties:
   *               choices:
   *                 type: array
   *                 items:
   *                   type: object
   *                   required: [uuid]
   *                   properties:
   *                     uuid:
   *                       type: string
   *                     include:
   *                       type: boolean
   *                     addressOverride:
   *                       type: string
   *                       nullable: true
   *                     credentialId:
   *                       type: integer
   *                       nullable: true
   *     responses:
   *       200:
   *         description: One result per server
   *       400:
   *         description: Invalid choices
   *       403:
   *         description: Missing coolify.view or coolify.configure, or not the owner
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: >-
   *           target-changed: the connection's address, token, Access token or
   *           TLS settings changed during the sync. Nothing more was written.
   *       502:
   *         description: Coolify answered with an error, with its cause
   */
  router.post(
    "/connections/:id/sync",
    view,
    configure,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      // Who may sync is settled before the body is read.
      await sync.assertOwner(id);
      res.json(await sync.apply(id, readChoices(req.body?.choices)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/unlink:
   *   post:
   *     summary: Unlink a Coolify server's Linked host
   *     description: >-
   *       Owner only. Releases the lock and makes the host an ordinary,
   *       editable host, or deletes it when removeHost is true. The address
   *       override and credential choice are kept for a later sync.
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
   *               removeHost:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: The host id and whether it was deleted
   *       403:
   *         description: Missing coolify.view or coolify.configure, or not the owner
   *       404:
   *         description: No such connection, or the server has no Linked host
   */
  router.post(
    "/connections/:id/servers/:uuid/unlink",
    view,
    configure,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      await sync.assertOwner(id);
      res.json(
        await sync.unlink(id, uuidParam(req), {
          removeHost: req.body?.removeHost === true,
        }),
      );
    }),
  );
}
