import { useCallback, useEffect, useMemo, useState } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
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

/**
 * The live docker stats readout, from the /stats socket while the view is
 * visible. It closes the socket when hidden or gone. A resource with several
 * containers answers choices: the picker (as the Logs view's) sets
 * `container`, which subscribes again with it.
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
  const [choices, setChoices] = useState<ContainerChoice[] | null>(null);

  useEffect(() => {
    if (!isVisible) return;
    let socket: Awaited<ReturnType<OpenLive>> = null;
    let gone = false;
    setFailed(null);
    setChoices(null);
    setStats(null);
    open("/stats")
      .then((s) => {
        if (gone) {
          s?.close();
          return;
        }
        socket = s;
        if (!s) {
          setFailed(t("metrics.live.unavailable"));
          return;
        }
        s.onmessage = (event) => {
          let body: unknown;
          try {
            body = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (isLiveStats(body)) {
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
        if (!gone) setFailed(t("metrics.live.unavailable"));
      });
    return () => {
      gone = true;
      socket?.close();
    };
  }, [connectionId, uuid, container, isVisible, open, t]);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium">
        {t("metrics.live.title")}
      </h3>
      {failed ? (
        <p className="text-muted-foreground text-xs">{failed}</p>
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
      ) : stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
      ) : (
        <LoadingState compact label={t("metrics.live.waiting")} />
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
