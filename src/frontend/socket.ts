import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

type WsUrl = (
  path: string,
) => Promise<{ url: string; protocols?: string[] } | null>;

/**
 * app.wsUrl, kept by activate. Each frame runs activate, so every view frame
 * has its own copy; views use openSocket and never hold the app.
 */
let wsUrl: WsUrl | null = null;

export function setWsUrl(fn: WsUrl | null): void {
  wsUrl = fn;
}

/** Keeps app.wsUrl for openSocket. */
export function keepSocketTarget(app: TermixApp): void {
  setWsUrl((path) => app.wsUrl(path));
}

/** A socket on this plugin's own /plugin-ws/coolify/<path>, or null. */
export async function openSocket(path: string): Promise<WebSocket | null> {
  if (!wsUrl) return null;
  const target = await wsUrl(path);
  if (!target) return null;
  return new WebSocket(target.url, target.protocols);
}
