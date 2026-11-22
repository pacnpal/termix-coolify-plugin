import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { safe } from "../connections/routes.js";
import { refreshFlag } from "../deployments/queue.js";
import { attentionBody, type AttentionService } from "./service.js";

/** The sidebar panel's and the rail badge's one read (coolify.attention). */
export function registerAttentionRoutes(
  router: Router,
  ctx: PluginContext,
  attention: AttentionService,
): void {
  const view = ctx.rbac.require("view") as never;

  /**
   * @openapi
   * /plugin-api/coolify/attention:
   *   get:
   *     summary: Deployments in progress and attention items across the user's connections
   *     description: >-
   *       For the sidebar panel, the rail badge and coolify.attention. For
   *       every connection the user can view: its queued and running
   *       deployments, recent failed deployments (the application's latest
   *       ended one, within 24 hours), degraded resources (Parts left out;
   *       exited counts as stopped) and servers Coolify can't reach. It is
   *       put together from the caches the tab reads through (the
   *       deployment queue, resources and server statuses), so it asks
   *       Coolify nothing of its own. A connection whose read failed keeps
   *       the parts that were read and says why in error. badge is running
   *       plus failed. Needs coolify.view; other users' connections are
   *       never in it.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: query
   *         name: refresh
   *         description: Set 1 to skip the deployment queue and resource caches
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: >-
   *           { connections, counts, badge, fetchedAt }; each connection has
   *           id, name, access, scoped, running, failed, degraded,
   *           unreachable and error
   *       403:
   *         description: Missing coolify.view
   */
  router.get(
    "/attention",
    view,
    safe(ctx, async (req, res) => {
      const raw = req.query.refresh;
      res.json(
        attentionBody(
          await attention.read({
            refresh: refreshFlag(typeof raw === "string" ? raw : undefined),
          }),
        ),
      );
    }),
  );
}
