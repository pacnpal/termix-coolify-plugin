import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { ContainerError } from "../containers/service.js";
import { uuidParam } from "../resources/routes.js";
import { MetricsError, type Metrics } from "./service.js";

function send(ctx: PluginContext, res: Response, err: unknown) {
  if (err instanceof MetricsError || err instanceof ContainerError) {
    return res
      .status(err.status)
      .json({ error: err.message, cause: err.code, ...err.extra });
  }
  return sendError(ctx, res, err);
}

function query(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["minutes", "view", "dim", "range", "limit"]) {
    const value = req.query[key];
    // A repeated parameter is an array: refuse it rather than pick one.
    if (value !== undefined) out[key] = typeof value === "string" ? value : [];
  }
  return out;
}

export function registerMetricsRoutes(
  router: Router,
  ctx: PluginContext,
  metrics: Metrics,
): void {
  const view = ctx.rbac.require("view") as never;
  const operate = ctx.rbac.require("operate") as never;
  const configure = ctx.rbac.require("configure") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/metrics:
   *   get:
   *     summary: A Coolify server's CPU, memory, disk, load and network metrics
   *     description: >-
   *       From Coolify's own MCP get_server_metrics when MCP is on for the
   *       instance (an API read), else from Sentinel over SSH on the server's
   *       Linked host, which needs coolify.operate and the caller's own
   *       connect access to that host. minutes is capped at 43200 (30 days).
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
   *         name: minutes
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 43200
   *           default: 60
   *     responses:
   *       200:
   *         description: >-
   *           { source: "mcp"|"sentinel", minutes, current, series }: current
   *           values by name (cpu_percent, memory_used_bytes, ...), series as
   *           [timestamp ms, value] pairs
   *       400:
   *         description: minutes is not a whole number from 1
   *       403:
   *         description: >-
   *           Missing coolify.view; or the Sentinel fallback without
   *           coolify.operate or connect access to the Linked host
   *       404:
   *         description: No such connection or server, or another user's
   *       409:
   *         description: >-
   *           metrics-off ({ canEnable }), not-linked (no Linked host for the
   *           Sentinel fallback) or host-key
   *       502:
   *         description: Coolify, SSH or Sentinel failed, with a cause
   */
  router.get(
    "/connections/:id/servers/:uuid/metrics",
    view,
    async (req, res) => {
      try {
        res.json(
          await metrics.serverMetrics(idParam(req), uuidParam(req), query(req)),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/servers/{uuid}/metrics/enable:
   *   post:
   *     summary: Turn on metrics for a Coolify server
   *     description: >-
   *       Sets is_metrics_enabled in the server's Sentinel settings through
   *       Coolify's API. Needs coolify.configure and owner or configure access
   *       to the connection, and confirm true; the token needs write in
   *       Coolify.
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
   *             required: [confirm]
   *             properties:
   *               confirm:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: "{ enabled: true }"
   *       400:
   *         description: confirm-required, without confirm true
   *       403:
   *         description: Missing coolify.configure, or only view or operate access
   *       404:
   *         description: No such connection or server, or another user's
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.post(
    "/connections/:id/servers/:uuid/metrics/enable",
    configure,
    async (req, res) => {
      try {
        res.json(
          await metrics.enableMetrics(
            idParam(req),
            uuidParam(req),
            req.body ?? {},
          ),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/metrics:
   *   get:
   *     summary: A resource container's CPU and memory history
   *     description: >-
   *       Read from Sentinel over SSH on the server's Linked host
   *       (/api/container/<uuid>/cpu/history and /memory/history). Needs
   *       lifecycle's check (coolify.operate, an operate grant, the uuid in
   *       the connection's list) and connect access to the host.
   *       minutes is capped at 43200 (30 days).
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
   *         name: minutes
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 43200
   *           default: 60
   *     responses:
   *       200:
   *         description: >-
   *           { source: "sentinel", minutes, cpu: [ts, percent][], memory:
   *           [ts, bytes][] }
   *       400:
   *         description: A bad minutes, or a uuid Sentinel can't be asked about
   *       403:
   *         description: Missing coolify.operate, or no connect access (no-host-access)
   *       404:
   *         description: No such resource or connection, or another user's
   *       409:
   *         description: metrics-off ({ canEnable }), not-linked or host-key
   *       502:
   *         description: Coolify, SSH or Sentinel failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/metrics",
    operate,
    async (req, res) => {
      try {
        res.json(
          await metrics.resourceMetrics(
            idParam(req),
            uuidParam(req),
            query(req),
          ),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}/traffic:
   *   get:
   *     summary: An application's traffic analytics
   *     description: >-
   *       Read from Sentinel over SSH on the server's Linked host when
   *       Coolify's traffic analytics is on for the server. Client IPs are
   *       left out unless Coolify's traffic_ip_mode is full and the caller
   *       has coolify.configure with owner or configure access. Needs
   *       lifecycle's check (coolify.operate, an operate grant, the uuid in
   *       the connection's list) and connect access to the host. limit is
   *       clamped to 200.
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
   *         name: view
   *         schema:
   *           type: string
   *           enum: [overview, paths, series, breakdown]
   *           default: overview
   *       - in: query
   *         name: dim
   *         description: Required for a breakdown
   *         schema:
   *           type: string
   *           enum: [status, method, country, city, referer, browser, os, device, protocol, scheme, tls, cache, bot, agent, ip, useragent]
   *       - in: query
   *         name: range
   *         schema:
   *           type: string
   *           enum: [24h, 7d, 30d]
   *           default: 24h
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *     responses:
   *       200:
   *         description: "{ view, dim?, range, ipsHidden, data }"
   *       400:
   *         description: >-
   *           An unknown view, dimension, range or limit, a resource that
   *           isn't an application, or a uuid Sentinel can't be asked about
   *       403:
   *         description: Missing coolify.operate, or no connect access (no-host-access)
   *       404:
   *         description: No such resource or connection, or another user's
   *       409:
   *         description: traffic-off, not-linked or host-key
   *       502:
   *         description: Coolify, SSH or Sentinel failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid/traffic",
    operate,
    async (req, res) => {
      try {
        res.json(
          await metrics.resourceTraffic(
            idParam(req),
            uuidParam(req),
            query(req),
          ),
        );
      } catch (err) {
        send(ctx, res, err);
      }
    },
  );
}
