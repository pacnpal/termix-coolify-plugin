import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  useHost,
  usePermission,
  type DataResult,
  type PluginHostRecord,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { createApi, type Api, type HostStats } from "./api";
import { linkOf, useServerHealth, type HostLink } from "./linked";
import { formatBytes } from "./views/metrics-parts";

/** The slot action ids: a Linked host's dashboard row, its badge, its metrics. */
export const HOST_ROW_ACTION = "coolify.host-row";
export const HOST_ROW_BADGE_ACTION = "coolify.host-row-badge";
export const HOST_METRICS_ACTION = "coolify.host-metrics-row";

/** As often as the backend reads a host's docker stats (HOST_STATS_TTL_MS). */
export const HOST_STATS_POLL_MS = 30_000;
/** Servers one request may name (the route's MAX_HOST_STATS_SERVERS). */
const MAX_SERVERS = 20;

type T = TermixApp["t"];
/** A server's summary, "failed" when it has none, null while unknown. */
type Value = HostStats | "failed" | null;

interface Feed {
  /** The listeners of each server some row shows. */
  servers: Map<string, Set<() => void>>;
  values: Map<string, Value>;
  timer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
  /** A server joined while a read was out: read again as soon as it ends. */
  again: boolean;
}

function chunks<V>(list: V[], size: number): V[][] {
  const out: V[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Linked hosts' container summaries, one request per connection for every
 * host row that shows one (rows that mount together join the same read), read
 * again HOST_STATS_POLL_MS after each answer while any row still shows that
 * connection. A server's value goes with its last row, so a row shown later,
 * or a host linked to another server, never starts from an old value; an
 * answer that lands after that is dropped.
 */
export function createHostStatsFeed(
  api: Pick<Api, "hostStats">,
  pollMs = HOST_STATS_POLL_MS,
) {
  const feeds = new Map<number, Feed>();

  function schedule(connectionId: number, feed: Feed, ms: number): void {
    if (feed.timer) clearTimeout(feed.timer);
    feed.timer = setTimeout(() => read(connectionId, feed), ms);
  }

  function read(connectionId: number, feed: Feed): void {
    feed.timer = null;
    if (feeds.get(connectionId) !== feed) return;
    if (feed.reading) {
      feed.again = true;
      return;
    }
    feed.reading = true;
    const asked = [...feed.servers.keys()];
    void Promise.all(
      chunks(asked, MAX_SERVERS).map((part) =>
        api.hostStats(connectionId, part).then(
          (answer) => part.map((uuid) => [uuid, answer.servers[uuid]] as const),
          () => part.map((uuid) => [uuid, undefined] as const),
        ),
      ),
    ).then((parts) => {
      if (feeds.get(connectionId) !== feed) return;
      feed.reading = false;
      const changed: (() => void)[] = [];
      for (const [uuid, stats] of parts.flat()) {
        const listeners = feed.servers.get(uuid);
        // Its last row went while the read was out.
        if (!listeners) continue;
        feed.values.set(uuid, stats ?? "failed");
        changed.push(...listeners);
      }
      for (const listener of changed) listener();
      schedule(connectionId, feed, feed.again ? 0 : pollMs);
      feed.again = false;
    });
  }

  return {
    subscribe(
      connectionId: number,
      serverUuid: string,
      listener: () => void,
    ): () => void {
      let feed = feeds.get(connectionId);
      if (!feed) {
        feed = {
          servers: new Map(),
          values: new Map(),
          timer: null,
          reading: false,
          again: false,
        };
        feeds.set(connectionId, feed);
      }
      const own = feed;
      let listeners = own.servers.get(serverUuid);
      if (!listeners) {
        listeners = new Set();
        own.servers.set(serverUuid, listeners);
        // A new server: read soon, together with any row mounting with it.
        if (own.reading) own.again = true;
        else schedule(connectionId, own, 0);
      }
      const mine = listeners;
      mine.add(listener);
      return () => {
        mine.delete(listener);
        if (mine.size > 0 || own.servers.get(serverUuid) !== mine) return;
        own.servers.delete(serverUuid);
        own.values.delete(serverUuid);
        if (own.servers.size > 0 || feeds.get(connectionId) !== own) return;
        if (own.timer) clearTimeout(own.timer);
        feeds.delete(connectionId);
      };
    },
    value(connectionId: number, serverUuid: string): Value {
      return feeds.get(connectionId)?.values.get(serverUuid) ?? null;
    },
  };
}

export type HostStatsFeed = ReturnType<typeof createHostStatsFeed>;

const noop = () => () => {};

function useHostStats(feed: HostStatsFeed, link: HostLink | null): Value {
  const connectionId = link?.connectionId ?? 0;
  const serverUuid = link?.serverUuid ?? "";
  const subscribe = useCallback(
    (listener: () => void) =>
      connectionId && serverUuid
        ? feed.subscribe(connectionId, serverUuid, listener)
        : noop(),
    [feed, connectionId, serverUuid],
  );
  const snapshot = useCallback(
    () =>
      connectionId && serverUuid ? feed.value(connectionId, serverUuid) : null,
    [feed, connectionId, serverUuid],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The row's host: its own record when the owner passes it, else by id. */
function useRowHost(context: Record<string, unknown>): PluginHostRecord | null {
  const given =
    context.host && typeof context.host === "object"
      ? (context.host as PluginHostRecord)
      : null;
  const id = context.hostId as string | number | undefined;
  const found = useHost(given ? undefined : id);
  return given ?? found;
}

/**
 * A Linked host's resource counts: running, degraded and stopped by the
 * shared status rules, from the connection's shared health. Nothing for an
 * ordinary host, a viewer without coolify.view, a read that failed, or a
 * server the connection's target no longer has.
 */
export function hostRowValue(
  t: T,
  health: ReturnType<typeof useServerHealth>,
  serverUuid: string,
): DataResult {
  if (!health?.counts) return null;
  if (health.servers && !health.servers.some((s) => s.uuid === serverUuid)) {
    return null;
  }
  const counts = health.counts[serverUuid] ?? {
    running: 0,
    degraded: 0,
    stopped: 0,
    deploying: 0,
  };
  return {
    shape: "stat",
    items: [
      {
        label: t("resources.health.running"),
        value: counts.running,
        tone: counts.running > 0 ? "good" : "muted",
      },
      {
        label: t("resources.health.degraded"),
        value: counts.degraded,
        tone: counts.degraded > 0 ? "warn" : "muted",
      },
      {
        label: t("resources.health.stopped"),
        value: counts.stopped,
        tone: "muted",
      },
    ],
  };
}

/** A deploying badge while the host's server has deployments running. */
export function hostRowBadgeValue(
  t: T,
  health: ReturnType<typeof useServerHealth>,
  serverUuid: string,
): DataResult {
  if (!health?.deploying) return null;
  if (health.servers && !health.servers.some((s) => s.uuid === serverUuid)) {
    return null;
  }
  const count = health.deploying[serverUuid] ?? 0;
  if (count <= 0) return null;
  return {
    shape: "badge",
    label: t("hostSlots.deploying"),
    tone: "default",
    tooltip: t("hostSlots.deployingHint", { count }),
    icon: "Rocket",
  };
}

/** Container CPU (of the host's CPUs) and memory (of its memory) as bars. */
export function hostMetricsValue(t: T, stats: Value): DataResult {
  if (!stats || stats === "failed") return null;
  const cpu =
    stats.cpus && stats.cpus > 0
      ? Math.min(1, stats.cpuPercent / (stats.cpus * 100))
      : null;
  const memory =
    stats.memoryTotalBytes && stats.memoryTotalBytes > 0
      ? Math.min(1, stats.memoryBytes / stats.memoryTotalBytes)
      : null;
  return {
    shape: "bars",
    items: [
      {
        label: t("hostSlots.containerCpu"),
        value: cpu,
        detail: t("hostSlots.containers", { count: stats.containers }),
      },
      {
        label: t("hostSlots.containerMemory"),
        value: memory,
        detail: stats.memoryTotalBytes
          ? `${formatBytes(stats.memoryBytes)} / ${formatBytes(stats.memoryTotalBytes)}`
          : formatBytes(stats.memoryBytes),
      },
    ],
  };
}

/**
 * Fills Termix's host data slots for Linked hosts: resource counts on the
 * dashboard row, a deploying badge in place of its status badge, and the
 * containers' CPU and memory in the homepage's host metrics. Every value
 * comes from a read shared by all rows of a connection; ordinary hosts get
 * nothing and make no request.
 */
export function registerHostSlots(app: TermixApp): void {
  const api = createApi(app.api);
  const feed = createHostStatsFeed(api);

  function useRowHealth(context: Record<string, unknown>) {
    const canView = usePermission("view");
    const host = useRowHost(context);
    const link = canView ? linkOf(host) : null;
    return { link, health: useServerHealth(api, link) };
  }

  app.registerSlotContribution("dashboard.hostRow", {
    actionId: HOST_ROW_ACTION,
    titleKey: "hostSlots.rowTitle",
    kind: "data",
    useValue: (context) => {
      const { link, health } = useRowHealth(context);
      return link ? hostRowValue(app.t, health, link.serverUuid) : null;
    },
  });

  app.registerSlotContribution("dashboard.hostRowBadge", {
    actionId: HOST_ROW_BADGE_ACTION,
    titleKey: "hostSlots.badgeTitle",
    kind: "data",
    useValue: (context) => {
      const { link, health } = useRowHealth(context);
      return link ? hostRowBadgeValue(app.t, health, link.serverUuid) : null;
    },
  });

  app.registerSlotContribution("homepage.hostMetrics", {
    actionId: HOST_METRICS_ACTION,
    titleKey: "hostSlots.metricsTitle",
    kind: "data",
    useValue: (context) => {
      // The Stats tab's rule: coolify.operate (the backend checks the grant).
      const canOperate = usePermission("operate");
      const host = useRowHost(context);
      const link = useMemo(
        () => (canOperate && context.online !== false ? linkOf(host) : null),
        [canOperate, context.online, host],
      );
      return hostMetricsValue(app.t, useHostStats(feed, link));
    },
  });
}
