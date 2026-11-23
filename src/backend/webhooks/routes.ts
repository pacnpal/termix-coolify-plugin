import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Webhooks } from "./service.js";

/** The paths served without a login, exactly as registered below. */
export const PUBLIC_WEBHOOK_PATHS = ["/webhook/:token"];

/** The content-length a request declared, or null when it declared none. */
function declaredBytes(req: Request): number | null {
  const raw = req.headers["content-length"];
  if (raw === undefined) return null;
  return /^\d{1,15}$/.test(String(raw)) ? Number(raw) : Number.NaN;
}

/** Fixed answers: nothing a caller sent is ever in them. */
function answer(res: Response, status: number, body: object) {
  res.set("Cache-Control", "no-store");
  return res.status(status).json(body);
}

export function registerWebhookRoutes(
  router: Router,
  ctx: PluginContext,
  webhooks: Webhooks,
): void {
  /**
   * @openapi
   * /plugin-api/coolify/webhook/{token}:
   *   post:
   *     summary: Receive one Coolify webhook notification
   *     description: >-
   *       No login: Coolify's team webhook posts here, and the token in the
   *       path is the only credential (32 random bytes; only its sha256 is
   *       stored, compared in constant time). The body is one of Coolify's
   *       notification payloads, at most 64 KB, holding exactly that event's
   *       keys. An accepted delivery answers 200 at once; the event then
   *       reaches each connection to that Coolify team whose own token can
   *       read its subject, checked live. An unknown token, an oversized body
   *       and a body of any other shape all get the same 400. Nothing sent is
   *       echoed. Core's limit of 120 public requests a minute per address
   *       applies.
   *     tags:
   *       - Coolify
   *     security: []
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [success, message, event]
   *             properties:
   *               success:
   *                 type: boolean
   *               message:
   *                 type: string
   *               event:
   *                 type: string
   *                 description: Coolify's event word, like deployment_failed; see docs/api.md
   *     responses:
   *       200:
   *         description: '{ "ok": true }'
   *       400:
   *         description: '{ "error": "Bad request" } for an unknown token, an oversized body or any other shape, alike'
   *       500:
   *         description: The plugin's database failed; Coolify retries
   */
  router.post("/webhook/:token", async (req: Request, res: Response) => {
    try {
      const delivery = await webhooks.receive(
        String(req.params.token ?? ""),
        req.body,
        declaredBytes(req),
      );
      if (!delivery.accepted) {
        return answer(res, 400, { error: "Bad request" });
      }
      // The fan-out runs on after the answer and never rejects.
      void delivery.fanout;
      return answer(res, 200, { ok: true });
    } catch (err) {
      ctx.log.warn(
        `coolify webhook failed: ${(err as Error)?.name ?? "error"}`,
      );
      return answer(res, 500, { error: "Internal error" });
    }
  });
}
