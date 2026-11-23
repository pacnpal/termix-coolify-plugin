import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { failureOf, type Api, type Connection } from "../../api";
import { describeFailure } from "../ConnectionForm";

/** What a card shows for its target. */
export type CardState<T> =
  | { kind: "loading" }
  | { kind: "no-access" }
  | { kind: "error"; message: string }
  | { kind: "ready"; connection: Connection; data: T };

interface Held<T> {
  key: string;
  state: CardState<T>;
}

/** 403 and 404 on the connection read: not this user's to see. */
function refused(err: unknown): boolean {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  return status === 403 || status === 404;
}

/**
 * One card's read: the connection (its access and revision; a database read,
 * never Coolify), then `load` for it. It is read when `active` turns on and
 * again every `pollMs` after each answer while it stays on, a setTimeout
 * chain, so a slow read is never overtaken. Hiding or unmounting stops it.
 * Everything is kept with the `key` it was read for (the card's connection
 * and resource): a card switched to another target shows loading until its
 * own answer, and only the newest read may set state, so a late answer for
 * an old target is dropped. A connection and its data are read together, so
 * a new revision replaces both at once.
 */
export function useCardRead<T>(
  api: Api,
  key: string | null,
  connectionId: number | null,
  load: (connection: Connection, refresh: boolean) => Promise<T>,
  pollMs: number,
  active: boolean,
): { state: CardState<T>; reload: (refresh?: boolean) => Promise<void> } {
  const { t } = useTranslation();
  const [held, setHeld] = useState<Held<T> | null>(null);
  const reads = useRef(0);
  const latestLoad = useRef(load);
  latestLoad.current = load;

  const reload = useCallback(
    async (refresh = false) => {
      if (key === null || connectionId === null) return;
      const mine = ++reads.current;
      const latest = () => mine === reads.current;
      let connection: Connection;
      try {
        connection = await api.getConnection(connectionId);
      } catch (err) {
        if (!latest()) return;
        setHeld({
          key,
          state: refused(err)
            ? { kind: "no-access" }
            : { kind: "error", message: t("dashboard.failed") },
        });
        return;
      }
      try {
        const data = await latestLoad.current(connection, refresh);
        if (latest()) {
          setHeld({ key, state: { kind: "ready", connection, data } });
        }
      } catch (err) {
        if (!latest()) return;
        setHeld({
          key,
          state: {
            kind: "error",
            message: failureOf(err)
              ? describeFailure(t, err)
              : t("dashboard.failed"),
          },
        });
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
        if (live) timer = setTimeout(poll, pollMs);
      });
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      // A read still out answers into nothing.
      reads.current += 1;
    };
  }, [active, key, pollMs, reload]);

  const state: CardState<T> =
    held?.key === key ? held.state : { kind: "loading" };
  return { state, reload };
}
