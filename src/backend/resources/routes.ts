import type { Request, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../connections/service.js";
import { idParam, safe } from "../connections/routes.js";
import { countResources } from "../../shared/resource-health.js";
import type { Resources } from "./service.js";

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/** A Coolify uuid from the path; anything else reads as missing. */
export function uuidParam(req: Request, name = "uuid"): string {
  const raw = String(req.params[name] ?? "");
  if (!UUID.test(raw)) {
    throw new ConnectionError("not-found", "Coolify resource not found");
  }
  return raw;
}

function flag(value: unknown): boolean {
  return value === "true" || value === "1";
}

export function registerResourceRoutes(
  router: Router,
  ctx: PluginContext,
  resources: Resources,
): void {
  const view = ctx.rbac.require("view") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources:
   *   get:
   *     summary: List a connection's applications, services and databases
   *     description: >-
   *       One list from Coolify's per-type lists, each service followed by its
   *       Parts (parentUuid set). Stripped DTOs only: no environment values,
   *       keys, tokens or compose files. Statuses are cached for 20 seconds;
   *       refresh=true fetches again. counts leaves Parts out.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: serverUuid
   *         schema:
   *           type: string
   *       - in: query
   *         name: refresh
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: >-
   *           { rows, counts: { running, degraded, stopped, deploying },
   *           fetchedAt }
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const list = await resources.load(id, {
        refresh: flag(req.query.refresh),
      });
      const serverUuid =
        typeof req.query.serverUuid === "string" ? req.query.serverUuid : "";
      const rows = serverUuid
        ? list.rows.filter((r) => r.serverUuid === serverUuid)
        : list.rows;
      res.json({
        rows,
        counts: countResources(rows),
        fetchedAt: new Date(list.fetchedAt).toISOString(),
      });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/resources/{uuid}:
   *   get:
   *     summary: Read one resource or service Part
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
   *         description: The resource, stripped of every secret
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: >-
   *           No such resource, no such connection, or another user's
   *       502:
   *         description: Coolify failed, with a cause
   */
  router.get(
    "/connections/:id/resources/:uuid",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const found = await resources.get(id, uuidParam(req), {
        refresh: flag(req.query.refresh),
      });
      if (!found) {
        throw new ConnectionError("not-found", "Coolify resource not found");
      }
      res.json(found);
    }),
  );
}
