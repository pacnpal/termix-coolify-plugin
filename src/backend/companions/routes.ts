import type { Request, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, safe } from "../connections/routes.js";
import type { Companions } from "./service.js";

function param(req: Request, name: string): string {
  return String(req.params[name] ?? "");
}

function recordId(req: Request): number {
  const raw = param(req, "recordId");
  return /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
}

/**
 * Routes for the companion-plugin features. Each one answers 404
 * `{ cause: "companion-missing", plugin }` when that plugin isn't running.
 */
export function registerCompanionRoutes(
  router: Router,
  ctx: PluginContext,
  companions: Companions,
): void {
  const view = ctx.rbac.require("view") as never;
  const operate = ctx.rbac.require("operate") as never;
  const configure = ctx.rbac.require("configure") as never;

  /**
   * @openapi
   * /plugin-api/coolify/companions:
   *   get:
   *     summary: Which companion plugins are running
   *     description: >-
   *       One flag per companion feature (files, tunnels, reverseProxy, dns,
   *       uptime, logSearch, packageManager, securityCenter, hostMetrics,
   *       databases, backups), true when that plugin is installed and running.
   *       Cached for 60 seconds.
   *     tags:
   *       - Coolify
   *     responses:
   *       200:
   *         description: The flags
   *       403:
   *         description: Missing coolify.view
   */
  router.get(
    "/companions",
    view,
    safe(ctx, async (_req, res) => {
      res.json(await companions.map());
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/dns:
   *   get:
   *     summary: DNS records made here for a resource
   *     description: >-
   *       The records this connection created for the resource through the
   *       DNS plugin, so they can be removed. Needs the DNS plugin.
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
   *         description: The records, with name, type, content and creation time
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or the DNS plugin isn't running (cause companion-missing)
   */
  router.get(
    "/connections/:id/resources/:uuid/dns",
    view,
    safe(ctx, async (req, res) => {
      res.json(await companions.dnsList(idParam(req), param(req, "uuid")));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/dns:
   *   post:
   *     summary: Create a DNS record for one of a resource's domains
   *     description: >-
   *       Creates the record through the DNS plugin and remembers it, so it
   *       can be removed with the resource. The name must be one of the
   *       resource's domains. Without content, the record points at the
   *       resource's server address. Needs the DNS plugin, coolify.configure
   *       and a configure grant (or ownership).
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
   *             required: [fqdn]
   *             properties:
   *               fqdn:
   *                 type: string
   *               type:
   *                 type: string
   *                 enum: [A, AAAA, CNAME]
   *               content:
   *                 type: string
   *     responses:
   *       201:
   *         description: The record as stored
   *       400:
   *         description: A name that isn't the resource's, or content that doesn't fit the type
   *       403:
   *         description: Missing coolify.configure, or a grant below configure
   *       404:
   *         description: No such connection or resource, or the DNS plugin isn't running
   *       409:
   *         description: The DNS plugin has no zone for the name (cause no-dns-zone)
   *       502:
   *         description: Coolify or the DNS plugin failed
   */
  router.post(
    "/connections/:id/resources/:uuid/dns",
    view,
    configure,
    safe(ctx, async (req, res) => {
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      res
        .status(201)
        .json(
          await companions.dnsCreate(idParam(req), param(req, "uuid"), body),
        );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/dns/{recordId}:
   *   delete:
   *     summary: Remove a DNS record made here
   *     description: >-
   *       Removes a record this connection created for this resource, through
   *       the DNS plugin, and forgets it. Any other id is refused with
   *       dns-record-not-found before the DNS plugin is asked.
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
   *       - in: path
   *         name: recordId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The record id, removed
   *       403:
   *         description: Missing coolify.configure, or a grant below configure
   *       404:
   *         description: No such connection or stored record, or the DNS plugin isn't running
   *       502:
   *         description: The DNS plugin failed; the record is kept
   */
  router.delete(
    "/connections/:id/resources/:uuid/dns/:recordId",
    view,
    configure,
    safe(ctx, async (req, res) => {
      res.json(
        await companions.dnsRemove(
          idParam(req),
          param(req, "uuid"),
          recordId(req),
        ),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/uptime:
   *   get:
   *     summary: Uptime monitors for a resource
   *     description: >-
   *       The Uptime plugin's monitors whose URL is on one of the resource's
   *       domains, with their status. Needs the Uptime plugin.
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
   *         description: The matched monitors
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection or resource, or the Uptime plugin isn't running
   *       502:
   *         description: Coolify or the Uptime plugin failed
   */
  router.get(
    "/connections/:id/resources/:uuid/uptime",
    view,
    safe(ctx, async (req, res) => {
      res.json(await companions.uptime(idParam(req), param(req, "uuid")));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/log-search:
   *   get:
   *     summary: Search logs across servers for a resource
   *     description: >-
   *       Runs the Log Search plugin's log-search.search with source docker
   *       and the resource uuid as the query. It can't filter by host. Needs
   *       the Log Search plugin, coolify.operate and an operate grant (or
   *       ownership).
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: uuid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The matching log lines, labelled with their source
   *       403:
   *         description: Missing coolify.operate, or a grant below operate
   *       404:
   *         description: No such connection or resource, or the Log Search plugin isn't running
   *       502:
   *         description: Coolify or the Log Search plugin failed
   */
  router.get(
    "/connections/:id/log-search",
    view,
    operate,
    safe(ctx, async (req, res) => {
      const uuid = typeof req.query.uuid === "string" ? req.query.uuid : "";
      res.json(await companions.logSearch(idParam(req), uuid));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/security:
   *   get:
   *     summary: Security Center score for a server's Linked host
   *     description: >-
   *       The Security Center plugin's score and critical findings for the
   *       Linked host. Needs the Security Center plugin and the actor's own
   *       access to the host.
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
   *         description: The host id, score, critical count and check time
   *       403:
   *         description: Missing coolify.view, or no access to the Linked host
   *       404:
   *         description: No such connection, no Linked host, or the plugin isn't running
   *       502:
   *         description: The Security Center plugin failed
   */
  router.get(
    "/connections/:id/servers/:uuid/security",
    view,
    safe(ctx, async (req, res) => {
      res.json(await companions.security(idParam(req), param(req, "uuid")));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/backups-failed:
   *   get:
   *     summary: Failed Termix backup jobs on a server's Linked host
   *     description: >-
   *       Runs the Backups plugin's backups.failed for the Linked host. Needs
   *       the Backups plugin and the actor's own access to the host.
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
   *         description: The host id and the failed jobs (id, name, time)
   *       403:
   *         description: Missing coolify.view, or no access to the Linked host
   *       404:
   *         description: No such connection, no Linked host, or the plugin isn't running
   *       502:
   *         description: The Backups plugin failed
   */
  router.get(
    "/connections/:id/servers/:uuid/backups-failed",
    view,
    safe(ctx, async (req, res) => {
      res.json(
        await companions.backupsFailed(idParam(req), param(req, "uuid")),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/host-metrics:
   *   get:
   *     summary: Coolify resource counts for the Host Metrics card
   *     description: >-
   *       How many applications, services and databases Coolify runs on the
   *       server. Shown on the Linked host when the Host Metrics plugin runs.
   *       Needs the actor's own access to the host.
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
   *         description: The host id and the counts
   *       403:
   *         description: Missing coolify.view, or no access to the Linked host
   *       404:
   *         description: No such connection, no Linked host, or the plugin isn't running
   *       502:
   *         description: Coolify answered with an error, with its cause
   */
  router.get(
    "/connections/:id/servers/:uuid/host-metrics",
    view,
    safe(ctx, async (req, res) => {
      res.json(await companions.hostMetrics(idParam(req), param(req, "uuid")));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/db-logins:
   *   get:
   *     summary: Which Coolify databases on a server have a saved login
   *     description: >-
   *       The Coolify databases on the server, each with whether the Databases
   *       plugin has a saved login for it on the Linked host. Never returns a
   *       password. Needs the Databases plugin and the actor's own access to
   *       the host.
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
   *         description: The host id and one entry per database
   *       403:
   *         description: Missing coolify.view, or no access to the Linked host
   *       404:
   *         description: No such connection, no Linked host, or the plugin isn't running
   *       502:
   *         description: Coolify or the Databases plugin failed
   */
  router.get(
    "/connections/:id/servers/:uuid/db-logins",
    view,
    safe(ctx, async (req, res) => {
      res.json(await companions.dbLogins(idParam(req), param(req, "uuid")));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/db-login:
   *   get:
   *     summary: Saved logins for a Coolify database
   *     description: >-
   *       Whether the Databases plugin has a saved login for this database on
   *       its server's Linked host, with login names and databases only, never
   *       passwords. Needs the Databases plugin and the actor's own access to
   *       the host.
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
   *         description: The host id, whether a login is saved, and the logins
   *       400:
   *         description: The resource is not a database
   *       403:
   *         description: Missing coolify.view, or no access to the Linked host
   *       404:
   *         description: No such connection or resource, no Linked host, or the plugin isn't running
   *       502:
   *         description: Coolify or the Databases plugin failed
   */
  router.get(
    "/connections/:id/resources/:uuid/db-login",
    view,
    safe(ctx, async (req, res) => {
      res.json(await companions.dbLogin(idParam(req), param(req, "uuid")));
    }),
  );
}
