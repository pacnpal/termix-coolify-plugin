import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, safe } from "../connections/routes.js";
import { ConnectionError } from "../connections/service.js";
import type { Events } from "./service.js";

/**
 * A query parameter: absent is undefined, one value is its text, and
 * anything else (a repeated key, `name[x]=`) is refused, so it can never
 * read as "no filter" or "the newest page".
 */
function query(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new ConnectionError("invalid-input", `${name} must be given once`);
}

/** The event log, a page at a time (coolify.events-list). */
export function registerEventRoutes(
  router: Router,
  ctx: PluginContext,
  events: Events,
): void {
  const view = ctx.rbac.require("view") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/events:
   *   get:
   *     summary: A page of the connection's event log, newest first
   *     description: >-
   *       What the event pipeline stored for this connection: deployments
   *       that finished or failed, restarts, unreachable servers, backups,
   *       scheduled tasks, high disk, certificate problems and expiring API
   *       tokens. The log keeps the newest 1000 per connection and holds no
   *       secret, token, credentialed URL or log text. Read from the
   *       plugin's own table; it asks Coolify nothing. Needs coolify.view
   *       and any access to the connection; another user's connection is
   *       404.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: limit
   *         description: Events per page, 1 to 200 (50 when missing)
   *         schema:
   *           type: integer
   *       - in: query
   *         name: before
   *         description: Only events older than this event id (the last page's nextBefore)
   *         schema:
   *           type: integer
   *       - in: query
   *         name: kind
   *         description: One event kind, like deployment-failed
   *         schema:
   *           type: string
   *       - in: query
   *         name: uuid
   *         description: Only events about this resource or server uuid
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: >-
   *           { rows, nextBefore }; each row has id, connectionId, kind,
   *           severity, title, resourceUuid, serverUuid, deploymentUuid,
   *           hostId, name, status, source, fields and createdAt
   *       400:
   *         description: A malformed limit, before, kind or uuid, or one given more than once
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's connection
   */
  router.get(
    "/connections/:id/events",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      res.json(
        await events.list(id, {
          limit: query(req.query.limit, "limit"),
          before: query(req.query.before, "before"),
          kind: query(req.query.kind, "kind"),
          uuid: query(req.query.uuid, "uuid"),
        }),
      );
    }),
  );
}
