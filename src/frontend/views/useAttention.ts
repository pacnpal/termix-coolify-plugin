import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Attention } from "../api";

/** How often the sidebar panel reads again while it is shown. */
export const PANEL_POLL_MS = 15_000;
/** How often the rail badge reads again: a count, so a minute is plenty. */
export const BADGE_POLL_MS = 60_000;

export interface AttentionState {
  /** Null until the first answer. */
  attention: Attention | null;
  loading: boolean;
  /** The last read failed; what was read before stays. */
  failed: boolean;
  /** Reads again now; `refresh` skips the backend's caches. */
  reload: (refresh?: boolean) => Promise<void>;
}

/**
 * The attention read (GET /attention), shared by the sidebar panel and the
 * rail badge: the backend puts it together from the same cached reads the
 * tab uses, so neither surface costs Coolify a request of its own. It is read
 * when `active` turns on and again every `pollMs` while it stays on; turning
 * it off or unmounting stops the polling. Each answer replaces the last one
 * whole, so a connection the user lost leaves with it, and only the latest
 * read may set state: an older answer that lands late is dropped.
 */
export function useAttention(
  api: Api,
  active: boolean,
  pollMs: number,
): AttentionState {
  const [attention, setAttention] = useState<Attention | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const reads = useRef(0);

  const reload = useCallback(
    async (refresh = false) => {
      const mine = ++reads.current;
      const latest = () => mine === reads.current;
      setLoading(true);
      try {
        const answer = await api.attention({ refresh });
        if (latest()) {
          setAttention(answer);
          setFailed(false);
        }
      } catch {
        if (latest()) setFailed(true);
      } finally {
        if (latest()) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      void reload().finally(() => {
        if (live) timer = setTimeout(poll, pollMs);
      });
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      // A read still out answers into nothing.
      reads.current += 1;
      setLoading(false);
    };
  }, [active, pollMs, reload]);

  return { attention, loading, failed, reload };
}

/**
 * The Coolify rail item's badge hook: running deployments plus recent
 * failures, read every BADGE_POLL_MS from the background frame. It asks for
 * nothing without coolify.view, and answers null (no badge) then, at zero,
 * and until the first answer.
 */
export function railBadge(app: {
  api: Api;
  hasPermission: (name: string) => Promise<boolean>;
}): () => number | null {
  return function useCoolifyBadge() {
    const [allowed, setAllowed] = useState(false);
    useEffect(() => {
      let live = true;
      void app.hasPermission("view").then(
        (yes) => {
          if (live) setAllowed(yes);
        },
        () => {},
      );
      return () => {
        live = false;
      };
    }, []);
    const { attention } = useAttention(app.api, allowed, BADGE_POLL_MS);
    const count = allowed ? (attention?.badge ?? 0) : 0;
    return count > 0 ? count : null;
  };
}
