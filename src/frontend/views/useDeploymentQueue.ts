import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { failureOf, type Api, type DeploymentQueue } from "../api";
import { describeFailure } from "./ConnectionForm";

/** How often the queue is read again while it is shown (the backend caches 10 s). */
export const QUEUE_POLL_MS = 10_000;

export interface DeploymentQueueState {
  /** Null until the first answer for this connection and target. */
  queue: DeploymentQueue | null;
  loading: boolean;
  error: string | null;
  /** Reads again now; `refresh` skips the backend's cache. */
  reload: (refresh?: boolean) => Promise<void>;
}

interface Held {
  key: string;
  queue: DeploymentQueue | null;
  error: string | null;
}

/**
 * One connection's deployment queue, held by the tab and shared by the
 * Overview and the Deployments section (and the backend serves every reader
 * from one cached read). It is read when it becomes active and again every
 * QUEUE_POLL_MS while it stays active: the tab shown on one of those
 * sections. Hiding or unmounting stops the polling. Everything is kept with
 * the connection and revision it was read for, so another connection never
 * shows it, and an answer that lands after a switch is dropped.
 */
export function useDeploymentQueue(
  api: Api,
  connectionId: number | null,
  revision: string | null,
  active: boolean,
): DeploymentQueueState {
  const { t } = useTranslation();
  const key = connectionId === null ? null : `${connectionId}:${revision}`;
  const [held, setHeld] = useState<Held | null>(null);
  const [loading, setLoading] = useState(false);
  // Each read takes the next generation; only the latest may set state.
  const reads = useRef(0);

  const reload = useCallback(
    async (refresh = false) => {
      if (connectionId === null || key === null) return;
      const mine = ++reads.current;
      const latest = () => mine === reads.current;
      setLoading(true);
      try {
        const queue = await api.deploymentQueue(connectionId, { refresh });
        if (latest()) setHeld({ key, queue, error: null });
      } catch (err) {
        if (!latest()) return;
        const error = failureOf(err)
          ? describeFailure(t, err)
          : t("deploymentsSection.failed");
        setHeld((prev) => ({
          key,
          queue: prev?.key === key ? prev.queue : null,
          error,
        }));
      } finally {
        if (latest()) setLoading(false);
      }
    },
    [api, connectionId, key, t],
  );

  useEffect(() => {
    if (!active || key === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      void reload().finally(() => {
        if (live) timer = setTimeout(poll, QUEUE_POLL_MS);
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
  }, [active, key, reload]);

  const mine = held?.key === key ? held : null;
  return {
    queue: mine?.queue ?? null,
    loading,
    error: mine?.error ?? null,
    reload,
  };
}
