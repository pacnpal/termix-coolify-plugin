import type { Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { uuidParam } from "../resources/routes.js";
import type { Logs } from "./logs.js";
import { ContainerError, type Containers } from "./service.js";

export function registerContainerRoutes(
  router: Router,
  ctx: PluginContext,
  containers: Containers,
  logs: Logs,
): void {
  const operate = ctx.rbac.require("operate") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/logs:
   *   get:
   *     summary: Recent logs of a resource's container, labelled with where they came from
   *     description: >-
   *       Reads Coolify's /logs endpoint when the API rules allow it: the
   *       caller is the owner or has an operate or configure Grant, and the
   *       token has read:sensitive. Otherwise runs docker logs over SSH on the
   *       server's Linked host, which needs the caller's own connect access to
   *       that host. Both need coolify.operate. source says which one answered
   *       ("coolify" or "ssh"). At most 10,000 lines; a larger count is capped.
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
   *         name: lines
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 10000
   *           default: 100
   *       - in: query
   *         name: timestamps
   *         schema:
   *           type: boolean
   *           default: false
   *       - in: query
   *         name: part
   *         description: A Part of this service, by uuid
   *         schema:
   *           type: string
   *       - in: query
   *         name: container
   *         description: A name from an earlier choices answer (read over SSH)
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: >-
   *           { source: "coolify" | "ssh", text, container? }; container is
   *           the one read over SSH
   *       300:
   *         description: "{ choices: [{ name, running, part }] }: several containers match"
   *       400:
   *         description: A bad lines, timestamps, part or container value
   *       403:
   *         description: Missing coolify.operate, or no connect access to the Linked host (no-host-access)
   *       404:
   *         description: >-
   *           No such resource or connection, another user's, or
   *           container-not-found
   *       409:
   *         description: >-
   *           not-linked (logs over SSH need a Linked host: link first), or
   *           host-key ({ hostId, fingerprints }: open a server terminal once)
   *       502:
   *         description: Coolify or SSH failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/logs",
    operate,
    async (req, res) => {
      try {
        const answer = await logs.snapshot(
          idParam(req),
          uuidParam(req),
          req.query,
        );
        if ("choices" in answer) {
          res.status(300).json(answer);
          return;
        }
        res.json(answer);
      } catch (err) {
        sendContainerError(ctx, res, err);
      }
    },
  );

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
        sendContainerError(ctx, res, err);
      }
    },
  );
}

/** A ContainerError with its own status and extras; anything else as usual. */
function sendContainerError(
  ctx: PluginContext,
  res: Response,
  err: unknown,
): void {
  if (err instanceof ContainerError) {
    res
      .status(err.status)
      .json({ error: err.message, cause: err.code, ...err.extra });
    return;
  }
  sendError(ctx, res, err);
}
