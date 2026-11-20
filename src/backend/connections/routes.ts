import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { CoolifyError, toRouteError } from "../coolify/http.js";
import {
  ConnectionError,
  type ConnectionInput,
  type ConnectionPatch,
  type Connections,
} from "./service.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;

/**
 * The answer for a failed call. Routes never throw: Termix turns a plugin off
 * after five thrown errors a minute.
 */
export function sendError(ctx: PluginContext, res: Response, err: unknown) {
  if (err instanceof ConnectionError) {
    return res.status(err.status).json({ error: err.message, cause: err.code });
  }
  const { status, body } = toRouteError(err);
  if (!(err instanceof CoolifyError)) {
    // Only the error's name: a message could hold something from a request.
    ctx.log.warn(`coolify route failed: ${(err as Error)?.name ?? "error"}`);
  }
  return res.status(status).json(body);
}

export function safe(ctx: PluginContext, fn: Handler): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendError(ctx, res, err);
    }
  };
}

/** A connection id from the path; a malformed one reads as missing. */
export function idParam(req: Request): number {
  const raw = String(req.params.id ?? "");
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ConnectionError("not-found", "Coolify connection not found");
  }
  return id;
}

const STRING_FIELDS = [
  "name",
  "baseUrl",
  "token",
  "cfAccessId",
  "cfAccessSecret",
  "caCert",
] as const;

/** Picks the known fields and checks their types; the service checks values. */
function readBody(body: unknown, partial: boolean): ConnectionPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConnectionError("invalid-input", "A JSON object is required");
  }
  const raw = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    const value = raw[key];
    if (value === undefined) continue;
    const nullable =
      key === "cfAccessId" || key === "cfAccessSecret" || key === "caCert";
    if (value === null && nullable) {
      out[key] = null;
      continue;
    }
    if (typeof value !== "string") {
      throw new ConnectionError("invalid-input", `${key} must be a string`);
    }
    out[key] = value;
  }
  for (const key of ["allowPrivate", "autoSync"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new ConnectionError(
        "invalid-input",
        `${key} must be true or false`,
      );
    }
    out[key] = value;
  }
  if (!partial) {
    for (const key of ["name", "baseUrl", "token"] as const) {
      if (typeof out[key] !== "string") {
        throw new ConnectionError("invalid-input", `${key} is required`);
      }
    }
  }
  return out as ConnectionPatch;
}

export function registerConnectionRoutes(
  router: Router,
  ctx: PluginContext,
  connections: Connections,
): void {
  const view = ctx.rbac.require("view") as never;
  const configure = ctx.rbac.require("configure") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections:
   *   get:
   *     summary: List the Coolify connections the signed-in user owns or was granted
   *     tags:
   *       - Coolify
   *     responses:
   *       200:
   *         description: The connections, without any token
   *       403:
   *         description: Missing coolify.view
   */
  router.get(
    "/connections",
    view,
    safe(ctx, async (_req, res) => res.json(await connections.list())),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections:
   *   post:
   *     summary: Connect a Coolify instance
   *     description: >-
   *       Runs the ability probe, then stores the connection with its token
   *       sealed. A Coolify older than 4.4 is refused with 409. An instance
   *       that can't be reached is still saved, with the cause in lastError.
   *     tags:
   *       - Coolify
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, baseUrl, token]
   *             properties:
   *               name:
   *                 type: string
   *               baseUrl:
   *                 type: string
   *               token:
   *                 type: string
   *                 writeOnly: true
   *               cfAccessId:
   *                 type: string
   *                 writeOnly: true
   *               cfAccessSecret:
   *                 type: string
   *                 writeOnly: true
   *               allowPrivate:
   *                 type: boolean
   *               caCert:
   *                 type: string
   *     responses:
   *       201:
   *         description: The connection, with the probe checklist and no token
   *       400:
   *         description: Missing or invalid fields
   *       403:
   *         description: Missing coolify.view or coolify.configure
   *       409:
   *         description: Coolify is older than 4.4
   */
  router.post(
    "/connections",
    view,
    configure,
    safe(ctx, async (req, res) => {
      const input = readBody(req.body, false) as ConnectionInput;
      res.status(201).json(await connections.create(input));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}:
   *   get:
   *     summary: Read one Coolify connection
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
   *         description: The connection, without any token
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   */
  router.get(
    "/connections/:id",
    view,
    safe(ctx, async (req, res) => {
      const found = await connections.get(idParam(req));
      if (!found) {
        throw new ConnectionError("not-found", "Coolify connection not found");
      }
      res.json(found);
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}:
   *   patch:
   *     summary: Change a Coolify connection
   *     description: >-
   *       Owner only. An empty or absent token or Cloudflare Access value keeps
   *       the stored one; null for both Cloudflare Access values clears them.
   *       Changing the address, token or TLS settings runs the probe again.
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
   *             properties:
   *               name:
   *                 type: string
   *               baseUrl:
   *                 type: string
   *               token:
   *                 type: string
   *                 writeOnly: true
   *               cfAccessId:
   *                 type: string
   *                 nullable: true
   *                 writeOnly: true
   *               cfAccessSecret:
   *                 type: string
   *                 nullable: true
   *                 writeOnly: true
   *               allowPrivate:
   *                 type: boolean
   *               caCert:
   *                 type: string
   *                 nullable: true
   *               autoSync:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: The changed connection, without any token
   *       400:
   *         description: >-
   *           Invalid fields, or the change needs a stored token or Cloudflare
   *           Access value that can't be read and wasn't sent again
   *       403:
   *         description: Missing coolify.view or coolify.configure, or not the owner
   *       404:
   *         description: No such connection, or another user's
   *       409:
   *         description: Coolify is older than 4.4
   */
  router.patch(
    "/connections/:id",
    view,
    configure,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      res.json(await connections.update(id, readBody(req.body, true)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}:
   *   delete:
   *     summary: Remove a Coolify connection
   *     description: >-
   *       Owner only. Unlinks the connection's Linked hosts (they stay as
   *       ordinary hosts) unless removeHosts is true, then deletes the
   *       connection and the plugin's rows for it. Nothing changes in Coolify.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: removeHosts
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: The removed connection
   *       403:
   *         description: Missing coolify.view or coolify.configure, or not the owner
   *       404:
   *         description: No such connection, or another user's
   */
  router.delete(
    "/connections/:id",
    view,
    configure,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const removeHosts =
        req.query.removeHosts === "true" || req.body?.removeHosts === true;
      res.json(await connections.remove(id, { removeHosts }));
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/probe:
   *   post:
   *     summary: Run the ability probe again
   *     description: >-
   *       Read-only against Coolify. Stores the version, team, abilities and
   *       checklist it found. A failed step is part of the answer, not an
   *       error.
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
   *         description: The probe result and the updated connection
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection, or another user's
   */
  router.post(
    "/connections/:id/probe",
    view,
    safe(ctx, async (req, res) => {
      res.json(await connections.probe(idParam(req)));
    }),
  );
}
