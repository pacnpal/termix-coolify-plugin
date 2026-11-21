import { useEffect, useMemo, useState } from "react";
import {
  usePluginApi,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { createApi, type Api, type SyncRow } from "./api";

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
