import { useState } from "react";
import { Gauge } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  LineChart,
  NoticePanel,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { failureOf, type Api, type MetricPoint } from "../api";
import { describeFailure } from "./ConnectionForm";

type T = ReturnType<typeof useTranslation>["t"];

const BINARY = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Bytes in binary units with one decimal, like "64.0 MiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes || 0))} B`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BINARY.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${BINARY[unit]}`;
}

export function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function clock(ts: number, spanMs: number): string {
  const d = new Date(ts);
  return spanMs > 36 * 3_600_000
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Errors a metrics call answers that have their own text under metrics.errors. */
const METRICS_ERRORS = new Set([
  "not-linked",
  "no-host-access",
  "host-key",
  "forbidden",
  "sentinel-failed",
  "ssh-failed",
  "invalid-input",
  "target-changed",
  "confirm-required",
]);

/** One line for a failed metrics or traffic call. */
export function describeMetricsFailure(t: T, err: unknown): string {
  const failure = failureOf(err);
  if (failure && METRICS_ERRORS.has(failure.cause)) {
    return t(`metrics.errors.${failure.cause}`);
  }
  return failure ? describeFailure(t, err) : t("metrics.failed");
}

/** One series over time: a theme-colored line with a fixed lower bound. */
export function TimeChart({
  label,
  points,
  format,
  minMax,
  color = "var(--chart-1)",
}: {
  label: string;
  /** A theme token, like var(--chart-2). */
  color?: string;
  points: readonly MetricPoint[];
  format: (value: number) => string;
  /** The top of the scale is at least this. */
  minMax: number;
}) {
  const { t } = useTranslation();
  const span = points.length ? points[points.length - 1][0] - points[0][0] : 0;
  const top = Math.max(minMax, ...points.map((p) => p[1]));
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-muted-foreground text-xs font-medium">{label}</h3>
      {points.length ? (
        <LineChart
          series={[
            {
              key: label,
              label,
              color,
              data: points.map((p) => p[1]),
            },
          ]}
          timestamps={points.map((p) => clock(p[0], span))}
          domain={[0, top]}
          yFormatter={format}
          height={140}
        />
      ) : (
        <p className="text-muted-foreground text-xs">{t("metrics.empty")}</p>
      )}
    </section>
  );
}

/**
 * Metrics are off for the server. The button shows only when the backend
 * says the user may turn them on, and asks first: it changes the server's
 * Sentinel settings in Coolify.
 */
export function MetricsOff({
  api,
  connectionId,
  serverUuid,
  serverName,
  canEnable,
  onEnabled,
}: {
  api: Api;
  connectionId: number;
  serverUuid: string | null;
  serverName: string;
  canEnable: boolean;
  onEnabled: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    if (!serverUuid) return;
    const ok = await confirm({
      title: t("metrics.enableConfirm.title", { name: serverName }),
      description: t("metrics.enableConfirm.description"),
      confirmLabel: t("metrics.enableConfirm.confirm"),
      destructive: false,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.enableMetrics(connectionId, serverUuid);
      onEnabled();
    } catch (err) {
      setError(
        failureOf(err)
          ? describeMetricsFailure(t, err)
          : t("metrics.off.enableFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <NoticePanel
      icon={Gauge}
      title={t("metrics.off.title")}
      action={
        canEnable && serverUuid ? (
          <Button size="sm" disabled={busy} onClick={() => void enable()}>
            {t("metrics.off.enable")}
          </Button>
        ) : undefined
      }
    >
      {canEnable ? t("metrics.off.hint") : t("metrics.off.askHint")}
      {error && <p className="text-destructive mt-1">{error}</p>}
    </NoticePanel>
  );
}
