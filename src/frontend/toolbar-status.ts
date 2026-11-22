import { useCallback, useSyncExternalStore } from "react";
import {
  useShell,
  type DataResult,
  type DataTone,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { resourceHealth, type ResourceHealth } from "../shared/resource-health";
import { createApi, type Api, type Resource } from "./api";
import { shellTabData } from "./views/ShellTab";

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
  timer: ReturnType<typeof setInterval> | null;
  /** Only the newest read may set rows; an older answer is dropped. */
  generation: number;
}

/**
 * Each connection's resources, read from the backend's cached list once per
 * connection however many shell tabs show it, and read again every
 * STATUS_POLL_MS while any tab still does. The last tab to go stops the
 * polling and drops the rows, so a later tab never starts from old ones.
 */
export function createStatusFeed(api: Api, pollMs = STATUS_POLL_MS) {
  const feeds = new Map<number, Feed>();

  function read(connectionId: number, feed: Feed): void {
    const mine = ++feed.generation;
    const apply = (rows: Rows) => {
      if (feeds.get(connectionId) !== feed || mine !== feed.generation) return;
      feed.rows = rows;
      for (const listener of feed.listeners) listener();
    };
    api.listResources(connectionId).then(
      (list) => apply(list.rows),
      () => apply("failed"),
    );
  }

  return {
    subscribe(connectionId: number, listener: () => void): () => void {
      let feed = feeds.get(connectionId);
      if (!feed) {
        const created: Feed = {
          rows: null,
          listeners: new Set(),
          timer: null,
          generation: 0,
        };
        feeds.set(connectionId, created);
        read(connectionId, created);
        created.timer = setInterval(() => read(connectionId, created), pollMs);
        feed = created;
      }
      const own = feed;
      own.listeners.add(listener);
      return () => {
        own.listeners.delete(listener);
        if (own.listeners.size > 0 || feeds.get(connectionId) !== own) return;
        if (own.timer) clearInterval(own.timer);
        feeds.delete(connectionId);
      };
    },
    rows(connectionId: number): Rows {
      return feeds.get(connectionId)?.rows ?? null;
    },
  };
}

export type StatusFeed = ReturnType<typeof createStatusFeed>;

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
 * The toolbar value for one tab: a coolify-shell tab's container name and
 * status, by the plugin's status rules, or "gone" once its resource is no
 * longer in Coolify's list. Any other tab, or no answer yet, draws nothing.
 */
export function useToolbarStatus(
  app: Pick<TermixApp, "t">,
  feed: StatusFeed,
  tabId: string,
): DataResult {
  const shell = useShell();
  const tab = shell?.tabs.list.find((x) => x.id === tabId) ?? null;
  const opened = tab?.type === "coolify-shell" ? shellTabData(tab.data) : null;
  const rows = useRows(feed, opened?.connectionId ?? null);
  if (!opened || !tab || rows === null || rows === "failed") return null;
  const target = opened.part ?? opened.uuid;
  const row = rows.find((r) => r.uuid === target) ?? null;
  const name = opened.container ?? row?.name ?? tab.label;
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
  app.registerSlotContribution("terminal.toolbarStatus", {
    actionId: TOOLBAR_STATUS_ACTION,
    titleKey: "toolbarStatus.title",
    kind: "data",
    useValue: (_context, rowKey) => useToolbarStatus(app, feed, rowKey),
  });
}
