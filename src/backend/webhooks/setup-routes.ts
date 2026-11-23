import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { baseUrlOf } from "../status/base-url.js";
import { WebhookSetupError, type WebhookSetup } from "./setup.js";

function send(ctx: PluginContext, res: Response, err: unknown) {
  if (err instanceof WebhookSetupError) {
    return res.status(err.status).json({ error: err.message, cause: err.code });
  }
  return sendError(ctx, res, err);
}

/** `{ "confirm": true }` in the body, or `?confirm=true`. */
function confirmed(req: Request): boolean {
  const body = req.body as { confirm?: unknown } | undefined;
  return body?.confirm === true || req.query.confirm === "true";
}

/**
 * The team webhook's one-click setup (#92). The URL's base is this request's
 * own address (`ctx.http.baseUrl`); no answer ever holds the URL.
 */
export function registerWebhookSetupRoutes(
  router: Router,
  ctx: PluginContext,
  setup: WebhookSetup,
): void {
  const view = ctx.rbac.require("view") as never;
  const configure = ctx.rbac.require("configure") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/webhook:
   *   get:
   *     summary: The Coolify team webhook's state
   *     description: >-
   *       Reads the team's webhook notification setting from Coolify and says
   *       whether it is unset, already points at this Termix (our route with a
   *       token this team's row verifies) or points somewhere else, shown only
   *       as its scheme, host and port. Also gives the address our URL would
   *       use (this request's own) and whether it is private, which Coolify
   *       refuses. Never shows a token. Needs coolify.configure and owner or
   *       configure access.
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
   *           { state: "unset"|"ours"|"foreign", enabled, current (masked, for
   *           foreign only, else null), base, basePrivate }
   *       403:
   *         description: Missing coolify.configure, or a view or operate grant (cause forbidden)
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: >-
   *           no-team, scoped-token, secrets-unreadable (the token lacks
   *           read:sensitive, so Coolify hides the URL) or target-changed
   *   post:
   *     summary: Set up the Coolify team webhook
   *     description: >-
   *       Reads the team's webhook first. Unset or already ours: writes our URL
   *       on this request's own address (a new token only when it isn't ours;
   *       only its sha256 is kept), turns the channel on and ticks the events
   *       the plugin receives. Someone else's: changes nothing and answers
   *       replace-needed with their URL masked; POST .../webhook/replace
   *       replaces it. The answer never holds the URL. Needs coolify.configure
   *       and owner or configure access.
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
   *           { outcome: "configured", replaced: false, basePrivate } or
   *           { outcome: "replace-needed", current, basePrivate }
   *       403:
   *         description: Missing coolify.configure, or a view or operate grant
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: >-
   *           no-base-url, no-team, scoped-token, secrets-unreadable or
   *           target-changed (the connection changed between the read and the
   *           write; nothing was written)
   *       422:
   *         description: Coolify refused the URL (it refuses private addresses)
   *   delete:
   *     summary: Turn the Coolify team webhook off
   *     description: >-
   *       Removes our URL from the team's webhook and drops our webhook row,
   *       only while the URL is still ours; polling takes over. Needs
   *       { "confirm": true } or ?confirm=true, coolify.configure and owner or
   *       configure access.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: confirm
   *         schema:
   *           type: boolean
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               confirm:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: '{ outcome: "disabled" } or { outcome: "not-set" }'
   *       400:
   *         description: confirm-required
   *       403:
   *         description: Missing coolify.configure, or a view or operate grant
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: not-ours (someone else's URL, left alone), secrets-unreadable or target-changed
   */
  router.get(
    "/connections/:id/webhook",
    view,
    configure,
    async (req: Request, res: Response) => {
      try {
        res.json(
          await setup.status(idParam(req), { base: baseUrlOf(ctx, req) }),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );

  router.post(
    "/connections/:id/webhook",
    view,
    configure,
    async (req: Request, res: Response) => {
      try {
        res.json(
          await setup.setup(idParam(req), { base: baseUrlOf(ctx, req) }),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );

  router.delete(
    "/connections/:id/webhook",
    view,
    configure,
    async (req: Request, res: Response) => {
      try {
        res.json(
          await setup.disable(idParam(req), { confirmed: confirmed(req) }),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/webhook/replace:
   *   post:
   *     summary: Replace someone else's Coolify team webhook with ours
   *     description: >-
   *       Like POST .../webhook, but writes our URL even when the team's
   *       webhook points somewhere else. Coolify sends to one place only, so
   *       the other receiver stops getting events. Needs { "confirm": true },
   *       coolify.configure and owner or configure access. The answer never
   *       holds the URL.
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
   *             required: [confirm]
   *             properties:
   *               confirm:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: '{ outcome: "configured", replaced, basePrivate }'
   *       400:
   *         description: confirm-required
   *       403:
   *         description: Missing coolify.configure, or a view or operate grant
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: no-base-url, no-team, scoped-token, secrets-unreadable or target-changed
   *       422:
   *         description: Coolify refused the URL (it refuses private addresses)
   */
  router.post(
    "/connections/:id/webhook/replace",
    view,
    configure,
    async (req: Request, res: Response) => {
      try {
        res.json(
          await setup.setup(idParam(req), {
            base: baseUrlOf(ctx, req),
            replace: true,
            confirmed: confirmed(req),
          }),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );
}
