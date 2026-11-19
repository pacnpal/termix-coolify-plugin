import { useEffect, useMemo, useState } from "react";
import { ChartColumn } from "lucide-react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  BarSeries,
  LoadingState,
  MiniStat,
  NoticePanel,
  Segmented,
  type BarSeriesItem,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type MetricPoint,
  type Resource,
  type TrafficRange,
} from "../api";
import {
  describeMetricsFailure,
  formatBytes,
  TimeChart,
} from "./metrics-parts";

const RANGES: TrafficRange[] = ["24h", "7d", "30d"];
/** The breakdowns the tab offers; "ip" only when Coolify keeps IPs in full. */
const DIMENSIONS = ["status", "country", "browser", "bot"] as const;

type Row = Record<string, unknown>;

function rows(data: unknown): Row[] {
  return Array.isArray(data)
    ? data.filter((r): r is Row => !!r && typeof r === "object")
    : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bars(data: unknown, labelKey: string): BarSeriesItem[] {
  return rows(data)
    .map((r) => ({
      label: String(r[labelKey] ?? ""),
      value: num(r.requests) ?? 0,
    }))
    .filter((b) => b.label !== "");
}

function series(data: unknown): MetricPoint[] {
  return rows(data)
    .map((r) => [num(r.bucket), num(r.requests)] as const)
    .filter(
      (p): p is readonly [number, number] => p[0] !== null && p[1] !== null,
    )
    .map((p) => [p[0], p[1]]);
}

interface Loaded {
  overview: Row;
  series: MetricPoint[];
  paths: BarSeriesItem[];
  ipsHidden: boolean;
}

type Load =
  | { kind: "loading" }
  | { kind: "ok"; data: Loaded }
  | { kind: "off" }
  | { kind: "error"; message: string };

function Breakdown({
  connectionId,
  uuid,
  range,
  ipsHidden,
}: {
  connectionId: number;
  uuid: string;
  range: TrafficRange;
  ipsHidden: boolean;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [dim, setDim] = useState<string>("status");
  const [items, setItems] = useState<BarSeriesItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dims = ipsHidden ? [...DIMENSIONS] : [...DIMENSIONS, "ip"];

  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    api
      .resourceTraffic(connectionId, uuid, { view: "breakdown", dim, range })
      .then((answer) => live && setItems(bars(answer.data, "value")))
      .catch((err: unknown) => {
        if (live) setError(describeMetricsFailure(t, err));
      });
    return () => {
      live = false;
    };
  }, [api, connectionId, uuid, dim, range, t]);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium">
        {t("metrics.traffic.breakdown")}
      </h3>
      <Segmented
        value={dim}
        onChange={setDim}
        options={dims.map((value) => ({
          value,
          label: t(`ops.fields.trafficDim.${value}`),
        }))}
      />
      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : items === null ? (
        <LoadingState compact />
      ) : items.length ? (
        <BarSeries items={items} />
      ) : (
        <p className="text-muted-foreground text-xs">{t("metrics.empty")}</p>
      )}
    </section>
  );
}

/**
 * An application's traffic from Sentinel: requests over time, top paths and
 * breakdowns. IPs show only when the backend sends them (Coolify's IP mode is
 * full).
 */
export function TrafficTab({
  connectionId,
  resource,
}: {
  connectionId: number;
  resource: Resource;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [range, setRange] = useState<TrafficRange>("24h");
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    const uuid = resource.uuid;
    Promise.all([
      api.resourceTraffic(connectionId, uuid, { view: "overview", range }),
      api.resourceTraffic(connectionId, uuid, { view: "series", range }),
      api.resourceTraffic(connectionId, uuid, { view: "paths", range }),
    ])
      .then(([overview, over, paths]) => {
        if (!live) return;
        setLoad({
          kind: "ok",
          data: {
            overview:
              overview.data && typeof overview.data === "object"
                ? (overview.data as Row)
                : {},
            series: series(over.data),
            paths: bars(paths.data, "path"),
            ipsHidden: overview.ipsHidden,
          },
        });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoad(
          failureOf(err)?.cause === "traffic-off"
            ? { kind: "off" }
            : { kind: "error", message: describeMetricsFailure(t, err) },
        );
      });
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid, range, t]);

  const overview = load.kind === "ok" ? load.data.overview : {};
  const stat = (key: string) => {
    const value = num(overview[key]);
    return value === null ? "–" : String(value);
  };
  const bytesOut = num(overview.bytes_out);

  return (
    <div className="flex flex-col gap-4 p-3">
      <Segmented<TrafficRange>
        value={range}
        onChange={setRange}
        options={RANGES.map((value) => ({
          value,
          label: t(`metrics.ranges.${value}`),
        }))}
      />
      {load.kind === "loading" && (
        <LoadingState label={t("metrics.traffic.loading")} />
      )}
      {load.kind === "error" && (
        <NoticePanel tone="destructive" title={load.message} />
      )}
      {load.kind === "off" && (
        <NoticePanel icon={ChartColumn} title={t("metrics.traffic.off.title")}>
          {t("metrics.traffic.off.hint")}
        </NoticePanel>
      )}
      {load.kind === "ok" && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MiniStat
              caption={t("metrics.traffic.requests")}
              value={stat("requests")}
            />
            <MiniStat
              caption={t("metrics.traffic.visitors")}
              value={stat("unique_visitors")}
            />
            <MiniStat
              caption={t("metrics.traffic.bytesOut")}
              value={bytesOut === null ? "–" : formatBytes(bytesOut)}
            />
          </div>
          <TimeChart
            label={t("metrics.traffic.requestsOverTime")}
            points={load.data.series}
            format={(v) => String(Math.round(v))}
            minMax={1}
          />
          <section className="flex flex-col gap-2">
            <h3 className="text-muted-foreground text-xs font-medium">
              {t("metrics.traffic.topPaths")}
            </h3>
            {load.data.paths.length ? (
              <BarSeries items={load.data.paths} />
            ) : (
              <p className="text-muted-foreground text-xs">
                {t("metrics.empty")}
              </p>
            )}
          </section>
          <Breakdown
            connectionId={connectionId}
            uuid={resource.uuid}
            range={range}
            ipsHidden={load.data.ipsHidden}
          />
          {load.data.ipsHidden && (
            <p className="text-muted-foreground text-xs">
              {t("metrics.traffic.ipsHidden")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
