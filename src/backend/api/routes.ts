import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { idParam, sendError } from "../connections/routes.js";
import { OPERATIONS } from "../coolify/generated/operations.js";
import {
  ApiCallError,
  maskedPaths,
  type GenericApi,
} from "../ops/api-generic.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const METHOD_OF = new Map(OPERATIONS.map((op) => [op.id, op.method]));

function fail(ctx: PluginContext, res: Response, err: unknown) {
  if (err instanceof ApiCallError) {
    return res.status(err.status).json({ error: err.message, cause: err.code });
  }
  return sendError(ctx, res, err);
}

/** Routes never throw: Termix turns a plugin off after five thrown errors a minute. */
function safe(ctx: PluginContext, fn: Handler): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(ctx, res, err);
    }
  };
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiCallError("invalid-input", "A JSON object is required");
  }
  return body as Record<string, unknown>;
}

function operationIdOf(body: Record<string, unknown>): string {
  const id = body.operationId;
  if (typeof id !== "string" || !id) {
    throw new ApiCallError("invalid-input", "operationId is required");
  }
  return id;
}

function pointerOf(body: Record<string, unknown>): (string | number)[] {
  const pointer = body.pointer;
  if (
    !Array.isArray(pointer) ||
    pointer.length === 0 ||
    pointer.length > 32 ||
    !pointer.every(
      (p) =>
        (typeof p === "string" && p.length <= 200) ||
        (typeof p === "number" && Number.isSafeInteger(p) && p >= 0),
    )
  ) {
    throw new ApiCallError(
      "invalid-input",
      "pointer must be a list of keys and indexes",
    );
  }
  return pointer as (string | number)[];
}

/**
 * The API console's routes: the operation list with each one's form schema,
 * one call, and revealing one masked value. Each call goes through the same
 * checks as coolify.api-read and coolify.api-call.
 */
export function registerApiConsoleRoutes(
  router: Router,
  ctx: PluginContext,
  api: GenericApi,
): void {
  const view = ctx.rbac.require("view") as never;
  const configure = ctx.rbac.require("configure") as never;

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/api/operations:
   *   get:
   *     summary: The Coolify API operations the signed-in user may call on a connection
   *     description: >-
   *       Each operation with its method, path, the Termix permission it needs
   *       and its parameters and body fields, for the API console's forms.
   *       Operations newer than the connection's Coolify, the excluded
   *       POST /disable, uploads and operations above the user's permission,
   *       grant or token are left out.
   *     tags:
   *       - Coolify
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: reads
   *         schema:
   *           type: boolean
   *         description: Only GET operations
   *     responses:
   *       200:
   *         description: "{ operations }"
   *       403:
   *         description: Missing coolify.view
   *       404:
   *         description: No such connection for this user
   */
  router.get(
    "/connections/:id/api/operations",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const readsOnly = req.query.reads === "1" || req.query.reads === "true";
      // A connection the user can't reach is a 404, not an empty list.
      await api.connection(id);
      res.json({ operations: await api.list(id, { readsOnly }) });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/api/call:
   *   post:
   *     summary: Call one Coolify API operation
   *     description: >-
   *       Runs one vendored Coolify operation with the same checks as
   *       coolify.api-read and coolify.api-call: the operation's own Termix
   *       permission, the grant level and the token. Anything but a GET needs
   *       confirmed true; a DELETE also needs confirmText equal to the
   *       operation id. The answer is redacted, with the paths of the masked
   *       values in masked.
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
   *             required: [operationId]
   *             properties:
   *               operationId:
   *                 type: string
   *               params:
   *                 type: object
   *               body: {}
   *               confirmed:
   *                 type: boolean
   *               confirmText:
   *                 type: string
   *     responses:
   *       200:
   *         description: "{ method, operationId, path, request, data, masked }"
   *       400:
   *         description: Bad input, or a change without its confirm
   *       403:
   *         description: Missing the operation's permission or grant, or an excluded operation
   *       404:
   *         description: No such connection for this user
   *       409:
   *         description: This Coolify doesn't have the operation
   *       502:
   *         description: Coolify failed; cause says why
   */
  router.post(
    "/connections/:id/api/call",
    view,
    safe(ctx, async (req, res) => {
      const id = idParam(req);
      const body = bodyOf(req);
      const operationId = operationIdOf(body);
      const method = METHOD_OF.get(operationId);
      if (method && method !== "GET") {
        if (body.confirmed !== true) {
          throw new ApiCallError(
            "confirm-required",
            `${operationId} changes Coolify; confirm it first`,
          );
        }
        if (method === "DELETE" && body.confirmText !== operationId) {
          throw new ApiCallError(
            "confirm-required",
            `Type ${operationId} to confirm this delete`,
          );
        }
      }
      const result = await api.dispatch({
        connectionId: id,
        operationId,
        params: body.params,
        body: body.body,
      });
      res.json({ ...result, masked: maskedPaths(result.data) });
    }),
  );

  /**
   * @openapi
   * /plugin-api/coolify/connections/{id}/api/reveal:
   *   post:
   *     summary: Reveal one masked value of a Coolify read
   *     description: >-
   *       Reads the GET operation again and answers the one masked value at
   *       pointer. Needs coolify.configure, configure access to the connection
   *       (or ownership) and a token with read:sensitive. Audited; the answer
   *       is never cached.
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
   *             required: [operationId, pointer]
   *             properties:
   *               operationId:
   *                 type: string
   *               params:
   *                 type: object
   *               pointer:
   *                 type: array
   *                 items: {}
   *     responses:
   *       200:
   *         description: "{ value }"
   *       400:
   *         description: Not a read, or not a masked value
   *       403:
   *         description: Missing coolify.configure, configure access, or a token that reads secrets
   *       404:
   *         description: No such connection for this user
   */
  router.post(
    "/connections/:id/api/reveal",
    configure,
    safe(ctx, async (req, res) => {
      res.set("Cache-Control", "no-store");
      const id = idParam(req);
      const body = bodyOf(req);
      const value = await api.reveal({
        connectionId: id,
        operationId: operationIdOf(body),
        params: body.params,
        pointer: pointerOf(body),
      });
      res.json({ value });
    }),
  );
}
