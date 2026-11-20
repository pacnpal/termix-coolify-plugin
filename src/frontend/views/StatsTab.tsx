import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListRow,
  LoadingState,
  MiniStat,
  NoticePanel,
  PanelList,
  Segmented,
} from "@termix-ssh/plugin-sdk/ui";
import {
  choicesOf,
  createApi,
  metricsOffOf,
  type ContainerChoice,
  type LiveStats,
  type Resource,
  type ResourceMetrics,
} from "../api";
import { openSocket } from "../socket";

/** Opens one of this plugin's sockets; tests give their own. */
type OpenLive = typeof openSocket;
/** WebSocket.OPEN. */
const OPEN = 1;
import {
  describeMetricsFailure,
  formatBytes,
  formatPercent,
  MetricsOff,
  TimeChart,
} from "./metrics-parts";

/** History ranges, in minutes. 30 days is Coolify's own cap. */
export const STATS_RANGES = {
  "1h": 60,
  "24h": 1440,
  "7d": 10_080,
  "30d": 43_200,
};
type Range = keyof typeof STATS_RANGES;

type Load =
  | { kind: "loading" }
  | { kind: "ok"; data: ResourceMetrics }
  | { kind: "off"; canEnable: boolean }
  | { kind: "error"; message: string };

function isLiveStats(value: unknown): value is LiveStats & { type: "stats" } {
  const v = value as Record<string, unknown> | null;
  return (
    !!v &&
    v.type === "stats" &&
    ["cpu", "memPct", "memBytes", "netRx", "netTx"].every(
      (k) => typeof v[k] === "number",
    )
  );
}

/** Waits before each automatic reconnect; after the last, only the button. */
export const RECONNECT_DELAYS_MS = [1_000, 3_000, 9_000];
/** The close code the backend refuses with: access or the target changed. */
const REFUSED = 1008;

/** Why the live readout stopped, shown with a Reconnect button. */
type Stopped = { message: string } | null;

/**
 * The live docker stats readout, from the /stats socket while the view is
 * visible. It closes the socket when hidden or gone. A resource with several
 * containers answers choices: the picker (as the Logs view's) sets
 * `container`, which subscribes again with it.
 *
 * A socket that fails or closes on its own shows why (a 1008 is a refusal,
 * with the backend's cause), keeps the last sample marked stale, and offers
 * Reconnect. A lost connection is retried on its own at most
 * RECONNECT_DELAYS_MS.length times; a refusal never is. Each socket is one
 * generation: events from a superseded one are dropped.
 */
function LiveReadout({
  connectionId,
  uuid,
  container,
  onPick,
  isVisible,
  open,
}: {
  connectionId: number;
  uuid: string;
  /** The picked container; kept by StatsTab, which is keyed per resource. */
  container: string | null;
  onPick: (name: string) => void;
  isVisible: boolean;
  open: OpenLive;
}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [stopped, setStopped] = useState<Stopped>(null);
  const [choices, setChoices] = useState<ContainerChoice[] | null>(null);
  // Bumped to open a new socket: Reconnect and the automatic retries.
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);
  const generation = useRef(0);

  // A new resource or container starts clean, with a fresh retry budget.
  useEffect(() => {
    retries.current = 0;
    setStats(null);
  }, [connectionId, uuid, container]);

  useEffect(() => {
    if (!isVisible) return;
    const gen = ++generation.current;
    const current = () => gen === generation.current;
    let socket: Awaited<ReturnType<OpenLive>> = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ended = false;
    setFailed(null);
    setStopped(null);
    setChoices(null);

    /** The socket ended without the view asking: say why, maybe retry. */
    function lost(code: number | null, reason: string) {
      if (!current() || ended) return;
      ended = true;
      if (code === REFUSED) {
        setStopped({
          message: t(`metrics.live.errors.${reason}`, {
            defaultValue: t("metrics.live.refused"),
          }),
        });
        return;
      }
      setStopped({ message: t("metrics.live.disconnected") });
      const wait = RECONNECT_DELAYS_MS[retries.current];
      if (wait === undefined) return;
      retries.current += 1;
      retry = setTimeout(() => {
        if (current()) setAttempt((n) => n + 1);
      }, wait);
    }

    open("/stats")
      .then((s) => {
        if (!current()) {
          s?.close();
          return;
        }
        socket = s;
        if (!s) {
          setFailed(t("metrics.live.unavailable"));
          return;
        }
        s.onmessage = (event) => {
          if (!current()) return;
          let body: unknown;
          try {
            body = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (isLiveStats(body)) {
            retries.current = 0;
            setStopped(null);
            setStats(body);
          } else if ((body as { type?: unknown })?.type === "choices") {
            setChoices(choicesOf(body));
          } else if ((body as { type?: unknown })?.type === "error") {
            const cause = String((body as { cause?: unknown }).cause ?? "");
            setFailed(
              t(`metrics.live.errors.${cause}`, {
                defaultValue: t("metrics.live.failed"),
              }),
            );
          }
        };
        // A browser always follows error with close, which says why.
        s.onerror = () => undefined;
        s.onclose = (event: { code?: number; reason?: string }) =>
          lost(event?.code ?? null, String(event?.reason ?? ""));
        const start = () =>
          s.send(
            JSON.stringify({
              connectionId,
              uuid,
              ...(container ? { container } : {}),
            }),
          );
        if (s.readyState === OPEN) start();
        else s.onopen = start;
      })
      .catch(() => {
        if (current()) setFailed(t("metrics.live.unavailable"));
      });
    return () => {
      // Unmount, hiding or a new resource: a new generation, and nothing
      // from this socket reaches the view any more.
      generation.current += 1;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [connectionId, uuid, container, isVisible, open, t, attempt]);

  const reconnect = () => {
    retries.current = 0;
    setAttempt((n) => n + 1);
  };
  const reconnectButton = (
    <div>
      <Button size="sm" variant="outline" onClick={reconnect}>
        {t("metrics.live.reconnect")}
      </Button>
    </div>
  );

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium">
        {t("metrics.live.title")}
      </h3>
      {failed ? (
        <>
          <p className="text-muted-foreground text-xs">{failed}</p>
          {reconnectButton}
        </>
      ) : choices ? (
        <div className="flex flex-col gap-2">
          <div>
            <p className="text-sm font-medium">{t("logs.pick.title")}</p>
            <p className="text-muted-foreground text-xs">
              {t("logs.pick.hint")}
            </p>
          </div>
          <PanelList>
            {choices.map((c, i) => (
              <ListRow
                key={c.name}
                stripe={i}
                title={c.name}
                meta={c.part ?? undefined}
                aria-label={c.name}
                onClick={() => onPick(c.name)}
              />
            ))}
          </PanelList>
        </div>
      ) : (
        <>
          {stopped && (
            <>
              <p className="text-muted-foreground text-xs">{stopped.message}</p>
              {reconnectButton}
            </>
          )}
          {stats ? (
            <>
              {stopped && (
                <p className="text-muted-foreground text-xs">
                  {t("metrics.live.stale")}
                </p>
              )}
              <div
                className={`grid grid-cols-2 gap-3 sm:grid-cols-4${stopped ? " opacity-60" : ""}`}
              >
                <MiniStat
                  caption={t("metrics.cpu")}
                  value={formatPercent(stats.cpu)}
                />
                <MiniStat
                  caption={t("metrics.memory")}
                  value={formatBytes(stats.memBytes)}
                />
                <MiniStat
                  caption={t("metrics.live.received")}
                  value={formatBytes(stats.netRx)}
                />
                <MiniStat
                  caption={t("metrics.live.sent")}
                  value={formatBytes(stats.netTx)}
                />
              </div>
            </>
          ) : (
            !stopped && (
              <LoadingState compact label={t("metrics.live.waiting")} />
            )
          )}
        </>
      )}
    </section>
  );
}

/** A resource's CPU and memory history from Sentinel, and the live readout. */
export function StatsTab({
  connectionId,
  resource,
  isVisible,
  open = openSocket,
}: {
  connectionId: number;
  resource: Resource;
  isVisible: boolean;
  /** The socket opener; tests give their own. */
  open?: OpenLive;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [range, setRange] = useState<Range>("1h");
  // The live readout's picked container, for this resource (the tab is keyed by it).
  const [container, setContainer] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    api
      .resourceMetrics(connectionId, resource.uuid, STATS_RANGES[range])
      .then((data) => live && setLoad({ kind: "ok", data }))
      .catch((err: unknown) => {
        if (!live) return;
        const off = metricsOffOf(err);
        setLoad(
          off
            ? { kind: "off", canEnable: off.canEnable }
            : { kind: "error", message: describeMetricsFailure(t, err) },
        );
      });
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid, range, attempt, t]);

  return (
    <div className="flex flex-col gap-4 p-3">
      <Segmented<Range>
        value={range}
        onChange={setRange}
        options={(Object.keys(STATS_RANGES) as Range[]).map((value) => ({
          value,
          label: t(`metrics.ranges.${value}`),
        }))}
      />
      {load.kind === "loading" && <LoadingState label={t("metrics.loading")} />}
      {load.kind === "error" && (
        <NoticePanel tone="destructive" title={load.message} />
      )}
      {load.kind === "off" && (
        <MetricsOff
          api={api}
          connectionId={connectionId}
          serverUuid={resource.serverUuid}
          serverName={resource.serverName ?? resource.serverUuid ?? ""}
          canEnable={load.canEnable}
          onEnabled={reload}
        />
      )}
      {load.kind === "ok" && (
        <>
          <TimeChart
            label={t("metrics.cpu")}
            points={load.data.cpu}
            format={formatPercent}
            minMax={100}
          />
          <TimeChart
            label={t("metrics.memory")}
            points={load.data.memory}
            format={formatBytes}
            minMax={1024 * 1024}
            color="var(--chart-2)"
          />
        </>
      )}
      {load.kind !== "off" && (
        <LiveReadout
          connectionId={connectionId}
          uuid={resource.uuid}
          container={container}
          onPick={setContainer}
          isVisible={isVisible}
          open={open}
        />
      )}
    </div>
  );
}
