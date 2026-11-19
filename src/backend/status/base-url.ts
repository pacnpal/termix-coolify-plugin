import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

const KV_KEY = "publicBaseUrl";

let remembered: string | null = null;

/**
 * Notes Termix's public address from a signed-in request, so a status page
 * URL made by an operation (which has no request) can still be absolute.
 * Kept in memory and, when it changes, in ctx.kv.
 */
export async function rememberBaseUrl(
  ctx: PluginContext,
  req: unknown,
): Promise<string | null> {
  let base: string;
  try {
    base = ctx.http.baseUrl(req).replace(/\/+$/, "");
  } catch {
    return remembered;
  }
  if (!/^https?:\/\//.test(base)) return remembered;
  if (base !== remembered) {
    remembered = base;
    try {
      await ctx.kv.set(KV_KEY, base);
    } catch {
      // Memory still has it; the store is only for after a restart.
    }
  }
  return base;
}

/**
 * Router middleware that notes the address from signed-in requests only. A
 * public request's Host header is the caller's to choose, so it never counts.
 */
export function rememberBaseUrlMiddleware(ctx: PluginContext) {
  return (req: unknown, _res: unknown, next: () => void): void => {
    if (ctx.currentActor()) {
      void rememberBaseUrl(ctx, req).catch(() => null);
    }
    next();
  };
}

/**
 * The last public address seen, or null when no signed-in request has come
 * in yet. A URL is then relative to the Termix address.
 */
export async function knownBaseUrl(ctx: PluginContext): Promise<string | null> {
  if (remembered) return remembered;
  try {
    const stored = await ctx.kv.get(KV_KEY);
    if (typeof stored === "string" && /^https?:\/\//.test(stored)) {
      remembered = stored;
    }
  } catch {
    // No store: answer null.
  }
  return remembered;
}
