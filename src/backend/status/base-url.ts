import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { trimTrailing } from "../text.js";

/** One kv entry per user: `publicBaseUrl:<userId>`. */
const KV_PREFIX = "publicBaseUrl:";
const HTTP_BASE = /^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i;

// Each user's own last address. A page URL carries its token, so it is only
// ever built from an address the same user sent: a request's Host header is
// the caller's to choose, and one user must never steer another's link.
const remembered = new Map<string, string>();

/** The public address of this request, or null when it isn't http(s). */
export function baseUrlOf(ctx: PluginContext, req: unknown): string | null {
  let base: string;
  try {
    base = trimTrailing(String(ctx.http.baseUrl(req)), "/");
  } catch {
    return null;
  }
  return HTTP_BASE.test(base) ? base : null;
}

/**
 * Notes the signed-in actor's address from their own request, for URLs an
 * operation builds later for that same actor (operations have no request).
 */
export async function rememberBaseUrl(
  ctx: PluginContext,
  req: unknown,
): Promise<void> {
  const userId = ctx.currentActor();
  if (!userId) return;
  const base = baseUrlOf(ctx, req);
  if (!base || remembered.get(userId) === base) return;
  remembered.set(userId, base);
  try {
    await ctx.kv.set(KV_PREFIX + userId, base);
  } catch {
    // Memory still has it; the store is only for after a restart.
  }
}

/** Router middleware: signed-in requests only, each kept for its own actor. */
export function rememberBaseUrlMiddleware(ctx: PluginContext) {
  return (req: unknown, _res: unknown, next: () => void): void => {
    if (ctx.currentActor()) {
      void rememberBaseUrl(ctx, req).catch(() => null);
    }
    next();
  };
}

/**
 * The address this user last sent, or null when they sent none (the URL is
 * then relative). Never another user's address.
 */
export async function knownBaseUrl(
  ctx: PluginContext,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const hit = remembered.get(userId);
  if (hit) return hit;
  try {
    const stored = await ctx.kv.get(KV_PREFIX + userId);
    if (typeof stored === "string" && HTTP_BASE.test(stored)) {
      remembered.set(userId, stored);
      return stored;
    }
  } catch {
    // No store: answer null.
  }
  return null;
}
