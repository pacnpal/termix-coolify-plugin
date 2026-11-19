import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

/** What a view needs of a socket: the browser's WebSocket fits. */
export interface LiveSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Opens one of this plugin's sockets, or null when it can't be reached. */
export type OpenLive = (path: string) => Promise<LiveSocket | null>;

let current: Pick<TermixApp, "wsUrl"> | null = null;

/** Called from activate: sockets need the app's wsUrl, which hooks don't give. */
export function setLiveApp(app: Pick<TermixApp, "wsUrl"> | null): void {
  current = app;
}

/** A socket on /plugin-ws/coolify/<path>, with core's auth. */
export const openLive: OpenLive = async (path) => {
  const target = await current?.wsUrl(path);
  if (!target || typeof WebSocket === "undefined") return null;
  const socket = new WebSocket(target.url, target.protocols);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("socket failed"));
  });
  return socket as unknown as LiveSocket;
};
