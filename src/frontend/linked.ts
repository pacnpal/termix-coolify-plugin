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
const previews = new Map<number, { at: number; rows: Promise<SyncRow[]> }>();

/**
 * A connection's sync preview, shared by every Linked host of that
 * connection and kept for five minutes, so host rows cost one request per
 * connection rather than one per host. A failed read answers no rows.
 */
export function cachedPreview(api: Api, connectionId: number) {
  const hit = previews.get(connectionId);
  if (hit && Date.now() - hit.at < MAX_AGE_MS) return hit.rows;
  const rows = api.syncPreview(connectionId).catch(() => [] as SyncRow[]);
  previews.set(connectionId, { at: Date.now(), rows });
  return rows;
}

/** Drops a connection's cached preview after its hosts changed. */
export function forgetPreview(connectionId: number): void {
  previews.delete(connectionId);
}

/** The sync row of a Linked host's server, or null while unknown. */
export function useLinkedRow(link: HostLink | null): SyncRow | null {
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [row, setRow] = useState<SyncRow | null>(null);
  const connectionId = link?.connectionId ?? 0;
  const serverUuid = link?.serverUuid ?? "";
  useEffect(() => {
    if (!connectionId || !serverUuid) {
      setRow(null);
      return;
    }
    let live = true;
    void cachedPreview(api, connectionId).then((rows) => {
      if (live) {
        setRow(rows.find((r) => r.server.uuid === serverUuid) ?? null);
      }
    });
    return () => {
      live = false;
    };
  }, [api, connectionId, serverUuid]);
  return row;
}
