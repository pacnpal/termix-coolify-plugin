import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { LoadingState, MiniStat, Sparkline } from "@termix-ssh/plugin-sdk/ui";
import { metricsOffOf, type Api, type ServerMetrics as Data } from "../api";
import {
  describeMetricsFailure,
  formatBytes,
  formatPercent,
  MetricsOff,
} from "./metrics-parts";

type Load =
  | { kind: "loading" }
  | { kind: "ok"; data: Data }
  | { kind: "off"; canEnable: boolean }
  | { kind: "error"; message: string };

/**
 * A Coolify server's current metrics and the last hour of CPU, for the
 * Linked host section. They come from Coolify's MCP when it's on, else from
 * Sentinel over SSH; the label says which.
 */
export function ServerMetrics({
  api,
  connectionId,
  serverUuid,
  serverName,
}: {
  api: Api;
  connectionId: number;
  serverUuid: string;
  serverName: string;
}) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    api
      .serverMetrics(connectionId, serverUuid, 60)
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
  }, [api, connectionId, serverUuid, attempt, t]);

  if (load.kind === "loading") {
    return <LoadingState compact label={t("metrics.loading")} />;
  }
  if (load.kind === "error") {
    return <p className="text-muted-foreground text-xs">{load.message}</p>;
  }
  if (load.kind === "off") {
    return (
      <MetricsOff
        api={api}
        connectionId={connectionId}
        serverUuid={serverUuid}
        serverName={serverName}
        canEnable={load.canEnable}
        onEnabled={reload}
      />
    );
  }

  const current = load.data.current ?? {};
  const cpu = current.cpu_percent;
  const used = current.memory_used_bytes;
  const total = current.memory_total_bytes;
  const disk = current.disk_used_percent;
  const load1 = current.load1;
  const cpuSeries = load.data.series.cpu_percent ?? [];
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium">{t("metrics.title")}</h3>
        <span className="text-muted-foreground text-xs">
          {t(`metrics.source.${load.data.source}`)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat
          caption={t("metrics.cpu")}
          value={cpu === undefined ? "–" : formatPercent(cpu)}
        />
        <MiniStat
          caption={t("metrics.memory")}
          value={
            used === undefined
              ? "–"
              : total === undefined
                ? formatBytes(used)
                : `${formatBytes(used)} / ${formatBytes(total)}`
          }
        />
        <MiniStat
          caption={t("metrics.disk")}
          value={disk === undefined ? "–" : formatPercent(disk)}
        />
        <MiniStat
          caption={t("metrics.load")}
          value={load1 === undefined ? "–" : load1.toFixed(2)}
        />
      </div>
      {cpuSeries.length > 1 && (
        <Sparkline
          data={cpuSeries.map((p) => p[1])}
          domain={[0, Math.max(100, ...cpuSeries.map((p) => p[1]))]}
          className="h-10"
        />
      )}
    </section>
  );
}
