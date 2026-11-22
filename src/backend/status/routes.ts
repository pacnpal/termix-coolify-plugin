import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../connections/service.js";
import { idParam, safe, sendError } from "../connections/routes.js";
import { baseUrlOf } from "./base-url.js";
import { renderStatusPage } from "./render.js";
import {
  StatusPagesOffError,
  handoffIdOf,
  takeOnceUrl,
  type StatusPages,
} from "./service.js";

/** The paths served without a login, exactly as registered below. */
export const PUBLIC_STATUS_PATHS = ["/status/:token", "/status/:token.json"];

export const STATUS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'";

function pageIdParam(req: Request): number {
  const raw = String(req.params.id ?? "");
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ConnectionError("not-found", "Status page not found");
  }
  return id;
}

function send(ctx: PluginContext, res: Response, err: unknown) {
  if (err instanceof StatusPagesOffError) {
    return res.status(err.status).json({ error: err.message, cause: err.code });
  }
  return sendError(ctx, res, err);
}

function publicHeaders(res: Response): void {
  res.set("Content-Security-Policy", STATUS_PAGE_CSP);
  res.set("Cache-Control", "no-store");
  // The URL carries the token; never send it on as a referrer.
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Robots-Tag", "noindex");
}

function notFound(res: Response) {
  publicHeaders(res);
  return res.status(404).json({ error: "Not found" });
}

export function registerStatusRoutes(
  router: Router,
  ctx: PluginContext,
  pages: StatusPages,
): void {
  const view = ctx.rbac.require("view") as never;
  const configure = ctx.rbac.require("configure") as never;
  const guarded =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        send(ctx, res, err);
      }
    };

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/status-pages:
   *   get:
   *     summary: List a connection's public status pages
   *     description: >-
   *       Title, chosen resource uuids and creation time of each live page.
   *       Never the page's link or token. allowed is false while an admin has
   *       turned status pages off.
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
   *         description: "{ allowed, pages: [{ id, connectionId, title, resources, createdAt }] }"
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   */
  router.get(
    "/connections/:id/status-pages",
    view,
    safe(ctx, async (req, res) => {
      const list = await pages.list(idParam(req));
      res.json({ allowed: await pages.allowed(), pages: list });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/status-pages:
   *   post:
   *     summary: Publish a public, read-only status page
   *     description: >-
   *       The page shows only the chosen resources' names, status and last
   *       deploy. The answer's url carries the page token; it is shown this
   *       once and never stored (only its sha256 is). Owner only.
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
   *             required: [title, resources]
   *             properties:
   *               title:
   *                 type: string
   *               resources:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       201:
   *         description: "{ id, connectionId, title, resources, createdAt, url }"
   *       400:
   *         description: Missing title, or resources that aren't uuids
   *       403:
   *         description: Missing coolify.configure, not the owner, or status pages are turned off (cause status-pages-off)
   *       404:
   *         description: No such connection, or another user's
   */
  router.post(
    "/connections/:id/status-pages",
    configure,
    guarded(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // The link is built from this request's own address, never a stored one.
      const { page, url } = await pages.create(
        idParam(req),
        { title: body.title, resources: body.resources },
        { base: baseUrlOf(ctx, req) },
      );
      res.status(201).json({ ...page, url });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/status-pages/{id}/rotate:
   *   post:
   *     summary: Give a status page a new link
   *     description: >-
   *       The old link stops working at once. The answer's url is shown this
   *       once and never stored.
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
   *         description: "{ id, url }"
   *       403:
   *         description: Missing coolify.configure
   *       404:
   *         description: No such page, a revoked one, or another user's
   */
  router.post(
    "/status-pages/:id/rotate",
    configure,
    guarded(async (req, res) => {
      const { page, url } = await pages.rotate(pageIdParam(req), {
        base: baseUrlOf(ctx, req),
      });
      res.json({ id: page.id, url });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/status-pages/{id}:
   *   delete:
   *     summary: Revoke a status page
   *     description: The link stops working and the page leaves the list.
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
   *         description: "{ id, revoked: true }"
   *       403:
   *         description: Missing coolify.configure
   *       404:
   *         description: No such page, a revoked one, or another user's
   */
  router.delete(
    "/status-pages/:id",
    configure,
    guarded(async (req, res) => {
      const page = await pages.revoke(pageIdParam(req));
      res.json({ id: page.id, revoked: true });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/status-pages/handoff/{handoffId}:
   *   post:
   *     summary: Take a status page URL made by an operation, once
   *     description: >-
   *       coolify.status-page-create and coolify.status-page-rotate return a
   *       handoffId instead of the URL, so run history never holds it. The
   *       same user takes the URL here once, within 5 minutes. Needs a
   *       signed-in session or an unscoped API key; a key scoped to
   *       operations uses the MCP tool take_status_page_url instead.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: handoffId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ url }"
   *       403:
   *         description: Missing coolify.configure
   *       404:
   *         description: Nothing to hand over (taken already, expired, another user's or unknown)
   */
  router.post(
    "/status-pages/handoff/:handoffId",
    configure,
    guarded(async (req, res) => {
      const handoffId = handoffIdOf(req.params.handoffId);
      const userId = ctx.currentActor() ?? "";
      const url = handoffId ? takeOnceUrl(userId, handoffId) : null;
      if (!url) {
        throw new ConnectionError("not-found", "Nothing to hand over");
      }
      res.set("Cache-Control", "no-store");
      res.json({ url });
    }),
  );

  const publicPage =
    (format: "html" | "json") => async (req: Request, res: Response) => {
      try {
        const status = await pages.publicView(String(req.params.token ?? ""));
        if (!status) return notFound(res);
        publicHeaders(res);
        if (format === "json") return res.json(status);
        return res.type("html").send(renderStatusPage(status));
      } catch {
        ctx.log.warn("status page view failed");
        return notFound(res);
      }
    };

  /**
   * @openapi
   * /plugin-api/coolify/status/{token}.json:
   *   get:
   *     summary: A public status page as JSON
   *     description: >-
   *       No login. The chosen resources' names, status and last deploy, from
   *       the plugin's cache (a view never calls Coolify), with stale true when
   *       the cache is over 5 minutes old.
   *     tags:
   *       - Coolify
   *     security: []
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "{ title, generatedAt, updatedAt, stale, items: [{ name, status, lastDeployAt, lastDeployOk, uptime? }] }"
   *       404:
   *         description: Unknown or revoked token, or status pages are turned off
   */
  router.get("/status/:token.json", publicPage("json"));

  /**
   * @openapi
   * /plugin-api/coolify/status/{token}:
   *   get:
   *     summary: A public status page
   *     description: >-
   *       No login. Self-contained HTML with no scripts, its own strict
   *       Content-Security-Policy and a 30 second meta refresh. Served from the
   *       plugin's cache; shows "Status may be out of date" when the cache is
   *       over 5 minutes old.
   *     tags:
   *       - Coolify
   *     security: []
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The page
   *       404:
   *         description: Unknown or revoked token, or status pages are turned off
   */
  router.get("/status/:token", publicPage("html"));
}
