import { useCallback, useSyncExternalStore } from "react";
import {
  useShell,
  type DataResult,
  type DataTone,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { resourceHealth, type ResourceHealth } from "../shared/resource-health";
import { createApi, type Api, type Resource } from "./api";
import { SHELL_TARGET_ACTION, keyOf, shellTabData } from "./views/ShellTab";

/** The slot action id: the container status in a coolify-shell tab's toolbar. */
export const TOOLBAR_STATUS_ACTION = "coolify.toolbar-status";

/** As often as the backend's resource cache turns over (RESOURCE_TTL_MS). */
export const STATUS_POLL_MS = 20_000;

const TONE: Record<ResourceHealth | "gone", DataTone> = {
  running: "good",
  degraded: "warn",
  stopped: "muted",
  deploying: "default",
  gone: "warn",
};

/** A connection's rows, "failed" after a failed read, null while loading. */
type Rows = readonly Resource[] | "failed" | null;

interface Feed {
  rows: Rows;
  listeners: Set<() => void>;
  /** The next read, set once the current one has settled. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Each connection's resources, read from the backend's cached list once per
 * connection however many shell tabs show it, and read again STATUS_POLL_MS
 * after each answer while any tab still does. The last tab to go stops the
 * polling and drops the rows, so a later tab never starts from old ones.
 */
export function createStatusFeed(api: Api, pollMs = STATUS_POLL_MS) {
  const feeds = new Map<number, Feed>();

  // One read at a time: the next is scheduled only once this one settles, so
  // a read slower than pollMs is never overtaken and dropped. An answer for a
  // feed that has gone (its last tab left) is dropped and schedules nothing.
  function read(connectionId: number, feed: Feed): void {
    const settle = (rows: Rows) => {
      if (feeds.get(connectionId) !== feed) return;
      feed.rows = rows;
      for (const listener of feed.listeners) listener();
      feed.timer = setTimeout(() => read(connectionId, feed), pollMs);
    };
    api.listResources(connectionId).then(
      (list) => settle(list.rows),
      () => settle("failed"),
    );
  }

  return {
    subscribe(connectionId: number, listener: () => void): () => void {
      let feed = feeds.get(connectionId);
      if (!feed) {
        feed = { rows: null, listeners: new Set(), timer: null };
        feeds.set(connectionId, feed);
        read(connectionId, feed);
      }
      const own = feed;
      own.listeners.add(listener);
      return () => {
        own.listeners.delete(listener);
        if (own.listeners.size > 0 || feeds.get(connectionId) !== own) return;
        if (own.timer) clearTimeout(own.timer);
        feeds.delete(connectionId);
      };
    },
    rows(connectionId: number): Rows {
      return feeds.get(connectionId)?.rows ?? null;
    },
  };
}

export type StatusFeed = ReturnType<typeof createStatusFeed>;

const CONTAINER = /^[A-Za-z0-9_.-]{1,255}$/;

/**
 * The container each shell tab says it is connected to, by tab id, with the
 * key of the tab data it was for. A null container clears the entry, but only
 * one made for the same key, so a closing view never clears its successor's.
 */
export function createShellTargets() {
  const targets = new Map<string, { key: string; container: string }>();
  const listeners = new Set<() => void>();
  return {
    tell(tabId: unknown, key: unknown, container: unknown): void {
      if (typeof tabId !== "string" || typeof key !== "string") return;
      if (typeof container === "string" && CONTAINER.test(container)) {
        targets.set(tabId, { key, container });
      } else if (targets.get(tabId)?.key === key) {
        targets.delete(tabId);
      } else return;
      for (const listener of listeners) listener();
    },
    container(tabId: string, key: string): string | null {
      const target = targets.get(tabId);
      return target?.key === key ? target.container : null;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ShellTargets = ReturnType<typeof createShellTargets>;

const noop = () => () => {};

function useRows(feed: StatusFeed, connectionId: number | null): Rows {
  const subscribe = useCallback(
    (listener: () => void) =>
      connectionId === null ? noop() : feed.subscribe(connectionId, listener),
    [feed, connectionId],
  );
  const snapshot = useCallback(
    () => (connectionId === null ? null : feed.rows(connectionId)),
    [feed, connectionId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The toolbar value for one tab: a coolify-shell tab's container name (the one
 * the tab connected to, from `targets`) and
 * status, by the plugin's status rules, or "gone" once its resource is no
 * longer in Coolify's list. Any other tab, or no answer yet, draws nothing.
 */
export function useToolbarStatus(
  app: Pick<TermixApp, "t">,
  feed: StatusFeed,
  targets: ShellTargets,
  tabId: string,
): DataResult {
  const shell = useShell();
  const tab = shell?.tabs.list.find((x) => x.id === tabId) ?? null;
  const opened = tab?.type === "coolify-shell" ? shellTabData(tab.data) : null;
  const key = opened ? keyOf(opened) : "";
  const read = useCallback(
    () => targets.container(tabId, key),
    [targets, tabId, key],
  );
  const connected = useSyncExternalStore(targets.subscribe, read, read);
  const rows = useRows(feed, opened?.connectionId ?? null);
  if (!opened || !tab || rows === null || rows === "failed") return null;
  const target = opened.part ?? opened.uuid;
  const row = rows.find((r) => r.uuid === target) ?? null;
  // The container the tab connected to, else the one it was opened with.
  const name = connected ?? opened.container ?? row?.name ?? tab.label;
  if (!row) {
    return {
      shape: "stat",
      items: [
        {
          label: name,
          value: app.t("toolbarStatus.gone"),
          tone: TONE.gone,
          tooltip: app.t("toolbarStatus.goneHint"),
        },
      ],
    };
  }
  const health = resourceHealth(row.status);
  return {
    shape: "stat",
    items: [
      {
        label: name,
        value: app.t(`resources.health.${health}`),
        tone: TONE[health],
      },
    ],
  };
}

/** Fills terminal.toolbarStatus for coolify-shell tabs. */
export function registerToolbarStatus(app: TermixApp): void {
  const feed = createStatusFeed(createApi(app.api));
  const targets = createShellTargets();
  app.registerAction(SHELL_TARGET_ACTION, (tabId, key, container) =>
    targets.tell(tabId, key, container),
  );
  app.registerSlotContribution("terminal.toolbarStatus", {
    actionId: TOOLBAR_STATUS_ACTION,
    titleKey: "toolbarStatus.title",
    kind: "data",
    useValue: (_context, rowKey) =>
      useToolbarStatus(app, feed, targets, rowKey),
  });
}
