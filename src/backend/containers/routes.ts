import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { uuidParam } from "../resources/routes.js";
import { ContainerError, type Containers } from "./service.js";

export function registerContainerRoutes(
  router: Router,
  ctx: PluginContext,
  containers: Containers,
): void {
  const operate = ctx.rbac.require("operate") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/shell:
   *   post:
   *     summary: The docker exec command for a shell or database console in a resource's container
   *     description: >-
   *       Finds the container on the server's Linked host over SSH (Coolify's
   *       uuid label, then the labels from before Coolify 4.4, and for a Part
   *       its sub-uuid, then its compose service name) and answers the command
   *       a terminal runs there. Needs coolify.operate and the caller's own
   *       connect access to the Linked host. A database console reads its
   *       credentials from the container's own environment inside the
   *       container, so the command holds no password.
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
   *               part:
   *                 type: string
   *                 description: A Part of this service, by uuid
   *               container:
   *                 type: string
   *                 description: A name from an earlier choices answer
   *               console:
   *                 type: string
   *                 enum: [shell, db]
   *     responses:
   *       200:
   *         description: >-
   *           { hostId, title, container, command, fingerprints, note? }; note
   *           "no-console" when a console was asked for an engine with none
   *       300:
   *         description: "{ choices: [{ name, running, part }] }: several containers match"
   *       400:
   *         description: A bad body, like a container name outside [A-Za-z0-9_.-]
   *       403:
   *         description: Missing coolify.operate, or no connect access to the Linked host (no-host-access)
   *       404:
   *         description: >-
   *           No such resource or connection, another user's, or
   *           container-not-found
   *       409:
   *         description: >-
   *           not-linked (the server has no Linked host), not-running, or
   *           host-key ({ hostId, fingerprints }: open a server terminal once)
   *       502:
   *         description: Coolify or SSH failed, with a cause
   */
  router.post(
    "/connections/:id/resources/:uuid/shell",
    operate,
    async (req, res) => {
      try {
        const answer = await containers.shell(
          idParam(req),
          uuidParam(req),
          req.body,
        );
        if ("choices" in answer) {
          res.status(300).json(answer);
          return;
        }
        res.json(answer);
      } catch (err) {
        if (err instanceof ContainerError) {
          res
            .status(err.status)
            .json({ error: err.message, cause: err.code, ...err.extra });
          return;
        }
        sendError(ctx, res, err);
      }
    },
  );
}
