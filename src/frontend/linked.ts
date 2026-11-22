import { useEffect, useMemo, useState } from "react";
import {
  usePluginApi,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { createApi, type Api, type ServerHealth, type SyncRow } from "./api";

/** Which Coolify server a Linked host mirrors. */
export interface HostLink {
  connectionId: number;
  serverUuid: string;
}

function settingsOf(host: PluginHostRecord): Record<string, unknown> {
  const all = (host.pluginSettings ?? {}) as Record<string, unknown>;
  const own = all.coolify;
  // A host carries only this plugin's settings, under its id or flat.
  return own && typeof own === "object"
    ? (own as Record<string, unknown>)
    : all;
}

/** The link a host's hidden settings record, or null for an ordinary host. */
export function linkOf(
  host: PluginHostRecord | null | undefined,
): HostLink | null {
  if (!host) return null;
  const settings = settingsOf(host);
  if (settings.coolifyLinked === false) return null;
  const connectionId = Number(settings.coolifyConnectionId);
  const serverUuid = settings.coolifyServerUuid;
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0) return null;
  if (typeof serverUuid !== "string" || !serverUuid) return null;
  return { connectionId, serverUuid };
}

const MAX_AGE_MS = 5 * 60_000;
const previews = new Map<
  number,
  { at: number; revision: string | null; rows: Promise<SyncRow[]> }
>();

/**
 * A connection's sync preview, shared by every Linked host of that
 * connection and kept for five minutes, so host rows cost one request per
 * connection rather than one per host. A failed read answers no rows. A
 * caller that knows the connection's revision gets only a preview of that
 * target: a changed address, token or TLS setting reads it again. Without
 * one (a host row's dot), the newest preview is used.
 */
export function cachedPreview(
  api: Api,
  connectionId: number,
  revision: string | null = null,
) {
  const hit = previews.get(connectionId);
  if (
    hit &&
    Date.now() - hit.at < MAX_AGE_MS &&
    (revision === null || hit.revision === revision)
  ) {
    return hit.rows;
  }
  const rows = api.syncPreview(connectionId).catch(() => [] as SyncRow[]);
  previews.set(connectionId, { at: Date.now(), revision, rows });
  return rows;
}

/** Drops a connection's cached preview after its hosts changed. */
export function forgetPreview(connectionId: number): void {
  previews.delete(connectionId);
}

/** How long a connection's server health is shared before it is read again. */
export const HEALTH_MAX_AGE_MS = 60_000;
const healths = new Map<
  number,
  { at: number; health: Promise<ServerHealth | null> }
>();

/**
 * A connection's server health, shared by every Linked host row of that
 * connection and kept a minute, so the dots cost one request per connection.
 * The backend answers it from its own shared caches. A failed read answers
 * null, which shows no dot.
 */
export function cachedServerHealth(
  api: Pick<Api, "serverHealth">,
  connectionId: number,
): Promise<ServerHealth | null> {
  const hit = healths.get(connectionId);
  if (hit && Date.now() - hit.at < HEALTH_MAX_AGE_MS) return hit.health;
  const health = api
    .serverHealth(connectionId)
    .catch(() => null as ServerHealth | null);
  healths.set(connectionId, { at: Date.now(), health });
  return health;
}

/**
 * A Linked host's connection health, read from the shared per connection
 * cache when the host is shown and again every `pollMs` while it stays
 * shown, so every row of a connection costs one request a minute. Keyed by
 * the link: a new link clears it at once, and an answer for an older link
 * (or after unmount) is dropped. An ordinary host (null) makes no request.
 */
export function useServerHealth(
  api: Pick<Api, "serverHealth">,
  link: HostLink | null,
  pollMs = HEALTH_MAX_AGE_MS,
): ServerHealth | null {
  const connectionId = link?.connectionId ?? 0;
  const serverUuid = link?.serverUuid ?? "";
  const key = connectionId && serverUuid ? `${connectionId}:${serverUuid}` : "";
  const [state, setState] = useState<{
    key: string;
    health: ServerHealth | null;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      void cachedServerHealth(api, connectionId).then((health) => {
        if (!live) return;
        setState({ key, health });
        timer = setTimeout(read, pollMs);
      });
    };
    read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, key, connectionId, pollMs]);
  return state && state.key === key ? state.health : null;
}

/** What is wrong with a Linked host's server, worst first. */
export type HostProblem =
  | { kind: "unreachable" }
  | { kind: "gone" }
  | { kind: "unusable" }
  | { kind: "degraded"; count: number };

/**
 * The problem to show for one server. Gone only when the server list was
 * read; degraded counts come from the shared status rule, so an exited
 * resource is stopped, not degraded.
 */
export function problemOf(
  health: ServerHealth,
  serverUuid: string,
): HostProblem | null {
  const server = health.servers?.find((s) => s.uuid === serverUuid) ?? null;
  if (server && !server.reachable) return { kind: "unreachable" };
  if (health.servers && !server) return { kind: "gone" };
  if (server && !server.usable) return { kind: "unusable" };
  const count = health.degraded?.[serverUuid] ?? 0;
  return count > 0 ? { kind: "degraded", count } : null;
}

/**
 * The problem of a Linked host's server, or null when there is none or it
 * is still unknown. An ordinary host (no link) makes no request. An answer
 * for a previous link is dropped.
 */
export function useHostProblem(link: HostLink | null): HostProblem | null {
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [problem, setProblem] = useState<HostProblem | null>(null);
  const connectionId = link?.connectionId ?? 0;
  const serverUuid = link?.serverUuid ?? "";
  useEffect(() => {
    setProblem(null);
    if (!connectionId || !serverUuid) return;
    let live = true;
    void cachedServerHealth(api, connectionId).then((health) => {
      if (live) setProblem(health ? problemOf(health, serverUuid) : null);
    });
    return () => {
      live = false;
    };
  }, [api, connectionId, serverUuid]);
  return problem;
}

/**
 * The sync row of a Linked host's server, or null while unknown. Keyed by
 * the connection's revision when the caller has it: a new revision clears
 * the row, and an answer for an older key is dropped.
 */
export function useLinkedRow(
  link: HostLink | null,
  revision: string | null = null,
): SyncRow | null {
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [row, setRow] = useState<SyncRow | null>(null);
  const connectionId = link?.connectionId ?? 0;
  const serverUuid = link?.serverUuid ?? "";
  useEffect(() => {
    setRow(null);
    if (!connectionId || !serverUuid) return;
    // This request's generation: over once the key changes or on unmount.
    let live = true;
    void cachedPreview(api, connectionId, revision).then((rows) => {
      if (live) {
        setRow(rows.find((r) => r.server.uuid === serverUuid) ?? null);
      }
    });
    return () => {
      live = false;
    };
  }, [api, connectionId, serverUuid, revision]);
  return row;
}
