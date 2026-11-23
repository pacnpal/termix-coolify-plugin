import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, safe } from "../connections/routes.js";
import { refreshFlag } from "../deployments/queue.js";
import type { Dashboard } from "./service.js";

/** The dashboard cards' and homepage widgets' own reads. */
export function registerDashboardRoutes(
  router: Router,
  ctx: PluginContext,
  dashboard: Dashboard,
): void {
  const view = ctx.rbac.require("view") as never;
  const refreshOf = (raw: unknown) =>
    refreshFlag(typeof raw === "string" ? raw : undefined);

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/overview:
   *   get:
   *     summary: A connection's resource counts by status and its servers
   *     description: >-
   *       For the connection overview card and coolify.connection-overview.
   *       Counts by health with Parts left out (exited counts as stopped),
   *       and how many servers there are and how many Coolify can't reach or
   *       use. Read from the resource (20 seconds) and server status (a
   *       minute) caches the tab reads through, so it asks Coolify nothing
   *       of its own. servers is null when the token can't read servers.
   *       Needs coolify.view and any access to the connection. No
   *       addresses, keys or tokens.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: refresh
   *         description: Set 1 to skip the resource cache
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: >-
   *           { connectionId, counts: { running, degraded, stopped,
   *           deploying }, total, servers: { total, unreachable, unusable }
   *           or null, fetchedAt }
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: target-changed, the connection was repointed during the read
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/overview",
    view,
    safe(ctx, async (req, res) => {
      res.json(
        await dashboard.overview(idParam(req), {
          refresh: refreshOf(req.query.refresh),
        }),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/vulnerabilities:
   *   get:
   *     summary: Counts of a connection's resources by security status
   *     description: >-
   *       For the vulnerabilities card and coolify.vulnerability-summary.
   *       Read from Coolify's /vulnerabilities (the stored image scanning
   *       status of the team's applications, services and databases) and
   *       kept five minutes per connection. It answers counts only: how many
   *       resources are listed, how many have known problems (update now,
   *       update available or no fix), each status's count and the problems
   *       by severity. No names, images or advice Coolify wrote. Needs
   *       coolify.view and any access to the connection.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: refresh
   *         description: Set 1 to skip the five minute cache
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: >-
   *           { connectionId, resources, affected, statuses: { updateNow,
   *           updateAvailable, noFix, checkNeeded, ok, notChecked },
   *           problems: { total, critical, high, medium, exploited },
   *           fetchedAt }
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: target-changed, the connection was repointed meanwhile
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/vulnerabilities",
    view,
    safe(ctx, async (req, res) => {
      res.json(
        await dashboard.vulnerabilities(idParam(req), {
          refresh: refreshOf(req.query.refresh),
        }),
      );
    }),
  );
}
