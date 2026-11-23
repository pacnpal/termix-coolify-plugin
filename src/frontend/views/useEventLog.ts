import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { failureOf, type Api, type EventPage, type EventRow } from "../api";
import { describeFailure } from "./ConnectionForm";

/**
 * How often the event log is read again while the Events section is shown.
 * No source feeds the log faster: the poller runs every 60 seconds or more,
 * and a webhook's events are in the log by the next read.
 */
export const EVENTS_POLL_MS = 60_000;

/** Events per read. */
export const EVENTS_PAGE = 50;

/** Every event kind, in the kind filter's order (src/backend/events/kinds.ts). */
export const EVENT_KIND_IDS = [
  "deployment-finished",
  "deployment-failed",
  "container-restarted",
  "restart-limit",
  "server-unreachable",
  "backup-succeeded",
  "backup-failed",
  "task-succeeded",
  "task-failed",
  "high-disk",
  "certificate-problem",
  "token-expiring",
] as const;

/** The log's filters; null reads every kind or every subject. */
export interface EventFilters {
  kind: string | null;
  uuid: string | null;
}

export interface EventLogState {
  /** Newest first; null until the first answer for this target and filters. */
  rows: EventRow[] | null;
  /** True when older rows can be loaded. */
  more: boolean;
  loading: boolean;
  error: string | null;
  /** Reads the newest page again now. */
  reload: () => Promise<void>;
  /** Appends the next older page (the `before` cursor). */
  older: () => Promise<void>;
}

interface Held {
  key: string;
  rows: EventRow[] | null;
  nextBefore: number | null;
  error: string | null;
}

const newestFirst = (rows: readonly EventRow[]) =>
  [...rows].sort((a, b) => b.id - a.id);

/**
 * The newest page laid over what is shown. The page is the truth for every
 * id from its oldest row up; older rows already shown stay, with their own
 * cursor. When the page doesn't reach them (more new events than a page),
 * the gap can't be filled, so the page replaces them.
 */
export function mergeNewest(
  held: { rows: readonly EventRow[]; nextBefore: number | null } | null,
  page: EventPage,
): { rows: EventRow[]; nextBefore: number | null } {
  const fresh = newestFirst(page.rows);
  const oldest = fresh[fresh.length - 1]?.id;
  if (!held || oldest === undefined || page.nextBefore === null) {
    return { rows: fresh, nextBefore: page.nextBefore };
  }
  if ((held.rows[0]?.id ?? -1) < oldest) {
    return { rows: fresh, nextBefore: page.nextBefore };
  }
  const kept = held.rows.filter((r) => r.id < oldest);
  return {
    rows: [...fresh, ...kept],
    nextBefore: kept.length ? held.nextBefore : page.nextBefore,
  };
}

/**
 * One connection's event log for the Events section: the newest page, read
 * when it becomes active and again EVENTS_POLL_MS after each read settles
 * (a setTimeout chain, so a slow read is never overtaken), and older pages
 * on request. Hiding or unmounting stops it. Everything is held with the
 * connection, revision and filters it was read for, and each read takes a
 * generation, so a changed target or filter never shows the old rows and an
 * answer that lands after a change is dropped.
 */
export function useEventLog(
  api: Api,
  connectionId: number,
  revision: string | null,
  filters: EventFilters,
  active: boolean,
): EventLogState {
  const { t } = useTranslation();
  const { kind, uuid } = filters;
  const key = `${connectionId}\n${revision}\n${kind ?? ""}\n${uuid ?? ""}`;
  const [held, setHeld] = useState<Held | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the latest newest-page read may set state, and only the latest
  // older-page read; a key change ends both.
  const reads = useRef(0);
  const olderReads = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  const failure = useCallback(
    (err: unknown) =>
      failureOf(err) ? describeFailure(t, err) : t("eventLog.failed"),
    [t],
  );

  const reload = useCallback(async () => {
    const mine = ++reads.current;
    const latest = () => mine === reads.current && keyRef.current === key;
    setLoading(true);
    try {
      const page = await api.events(connectionId, {
        kind,
        uuid,
        limit: EVENTS_PAGE,
      });
      if (!latest()) return;
      setHeld((prev) => ({
        key,
        ...mergeNewest(prev?.key === key && prev.rows ? prev : null, page),
        error: null,
      }));
    } catch (err) {
      if (!latest()) return;
      const error = failure(err);
      setHeld((prev) =>
        prev?.key === key
          ? { ...prev, error }
          : { key, rows: null, nextBefore: null, error },
      );
    } finally {
      if (latest()) setLoading(false);
    }
  }, [api, connectionId, kind, uuid, key, failure]);

  const mine = held?.key === key ? held : null;
  const before = mine?.nextBefore ?? null;

  const older = useCallback(async () => {
    if (before === null) return;
    const read = ++olderReads.current;
    const latest = () => read === olderReads.current && keyRef.current === key;
    try {
      const page = await api.events(connectionId, {
        kind,
        uuid,
        before,
        limit: EVENTS_PAGE,
      });
      if (!latest()) return;
      setHeld((prev) => {
        // Only onto the rows it was asked under.
        if (prev?.key !== key || !prev.rows || prev.nextBefore !== before) {
          return prev;
        }
        const seen = new Set(prev.rows.map((r) => r.id));
        return {
          ...prev,
          rows: newestFirst([
            ...prev.rows,
            ...page.rows.filter((r) => !seen.has(r.id)),
          ]),
          nextBefore: page.nextBefore,
          error: null,
        };
      });
    } catch (err) {
      if (!latest()) return;
      const error = failure(err);
      setHeld((prev) => (prev?.key === key ? { ...prev, error } : prev));
    }
  }, [api, connectionId, kind, uuid, key, before, failure]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      void reload().finally(() => {
        if (live) timer = setTimeout(poll, EVENTS_POLL_MS);
      });
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      // Reads still out answer into nothing.
      reads.current += 1;
      olderReads.current += 1;
      setLoading(false);
    };
  }, [active, reload]);

  return {
    rows: mine?.rows ?? null,
    more: before !== null,
    loading,
    error: mine?.error ?? null,
    reload,
    older,
  };
}
