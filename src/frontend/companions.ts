import { useEffect, useMemo, useState } from "react";
import { usePluginApi } from "@termix-ssh/plugin-sdk/frontend";
import { createApi, type Api, type CompanionMap } from "./api";

const MAX_AGE_MS = 60_000;
let cached: { at: number; map: Promise<CompanionMap | null> } | null = null;

/**
 * Which companion plugins run, read once a minute per frame. A failed read
 * answers null, which hides every companion feature.
 */
export function cachedCompanions(api: Api): Promise<CompanionMap | null> {
  if (cached && Date.now() - cached.at < MAX_AGE_MS) return cached.map;
  const map = api
    .companions()
    .then((m) => (m && typeof m === "object" ? m : null))
    .catch(() => null);
  cached = { at: Date.now(), map };
  return map;
}

/** Forgets the cached map, so the next read asks again. */
export function forgetCompanions(): void {
  cached = null;
}

/** The companion map, or null while unknown or unreadable. */
export function useCompanions(): CompanionMap | null {
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [map, setMap] = useState<CompanionMap | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void cachedCompanions(api).then((m) => live && setMap(m));
    read();
    // Read again once the cache is stale, so a companion installed or
    // stopped (or a failed first read) shows within a minute. Every mounted
    // view shares the one cached promise, so this is one request a minute.
    const timer = setInterval(read, MAX_AGE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  return map;
}
