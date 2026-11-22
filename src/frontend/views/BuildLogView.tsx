import { useEffect, useMemo, useState } from "react";
import { CircleStop, EyeOff, ScrollText, TriangleAlert } from "lucide-react";
import {
  usePluginApi,
  useToast,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  LoadingState,
  NoticePanel,
  StatusBadge,
  ToolbarBand,
  useConfirm,
  type StatusTone,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type Deployment,
  type DeploymentDetail,
} from "../api";
import { isFinalDeployment } from "../../shared/deployment-status";
import { describeFailure } from "./ConnectionForm";

/** How often a deployment that hasn't ended is read again while shown. */
export const BUILD_LOG_POLL_MS = 2_000;

const TONES: Record<string, StatusTone> = {
  queued: "warn",
  in_progress: "info",
  finished: "ok",
  failed: "bad",
  "cancelled-by-user": "idle",
  skipped: "idle",
};

type T = (key: string, options?: Record<string, unknown>) => string;

/** A deployment's status as a badge, in words where the status is known. */
export function DeploymentStatus({ t, status }: { t: T; status: string }) {
  return (
    <StatusBadge tone={TONES[status] ?? "idle"}>
      {status in TONES ? t(`deployments.status.${status}`) : status}
    </StatusBadge>
  );
}

/** Whether nothing more will change, by the backend's word or the status. */
function ended(detail: DeploymentDetail): boolean {
  return detail.final || isFinalDeployment(detail.deployment?.status ?? "");
}

type Read =
  | { kind: "loading" }
  | { kind: "ok"; detail: DeploymentDetail }
  | { kind: "failed" };

/**
 * One deployment's build log, read again every 2 seconds while it is shown
 * and the deployment hasn't ended. Coolify's hidden lines stay hidden until
 * the toggle shows them. Everything it shows is about the deployment it
 * renders for: a read for another deployment, or an answer that comes back
 * after the view moved on, is never shown. Reusable wherever a deployment is
 * opened (history, previews, the connection's queue).
 */
export function BuildLogView({
  connectionId,
  resourceUuid,
  deploymentUuid,
  isVisible = true,
  canCancel = false,
  onChanged,
}: {
  connectionId: number;
  /** The application the deployment belongs to. */
  resourceUuid: string;
  deploymentUuid: string;
  /** Polling stops while the view isn't shown. */
  isVisible?: boolean;
  /** coolify.operate and an operate grant: offers Cancel while it runs. */
  canCancel?: boolean;
  /** After a cancel, so a list around the view can read again. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const confirm = useConfirm();
  const toast = useToast();
  const key = `${connectionId}\n${resourceUuid}\n${deploymentUuid}`;
  // Each read is stored with the deployment it is for, so a render for
  // another one never shows it, even before an effect has run.
  const [state, setState] = useState<{ key: string; read: Read }>({
    key,
    read: { kind: "loading" },
  });
  const [showHidden, setShowHidden] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Bumped to read again now: a retry or a cancel.
  const [attempt, setAttempt] = useState(0);
  const read: Read = state.key === key ? state.read : { kind: "loading" };
  const final = read.kind === "ok" && ended(read.detail);

  useEffect(() => {
    if (!isVisible || final) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      api
        .getDeployment(connectionId, resourceUuid, deploymentUuid)
        .then((detail) => {
          // A cleanup ran (another deployment, hidden, unmounted): drop it.
          if (!live) return;
          setState({ key, read: { kind: "ok", detail } });
          if (!ended(detail)) timer = setTimeout(poll, BUILD_LOG_POLL_MS);
        })
        .catch(() => {
          if (live) setState({ key, read: { kind: "failed" } });
        });
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [
    api,
    connectionId,
    resourceUuid,
    deploymentUuid,
    key,
    isVisible,
    final,
    attempt,
  ]);

  async function cancel(deployment: Deployment): Promise<void> {
    const ok = await confirm({
      title: t("deployments.cancelConfirm.title"),
      description: t("deployments.cancelConfirm.description"),
      confirmLabel: t("deployments.cancelConfirm.confirm"),
      destructive: true,
    });
    if (!ok) return;
    setCancelling(true);
    try {
      const answer = await api.cancelDeployment(
        connectionId,
        resourceUuid,
        deployment.uuid,
      );
      toast.success(
        answer.pending
          ? t("deployments.cancelPending")
          : t("deployments.cancelled"),
      );
      onChanged?.();
    } catch (err) {
      toast.error(
        failureOf(err)
          ? describeFailure(t, err)
          : t("deployments.cancelFailed"),
      );
    } finally {
      setCancelling(false);
      setAttempt((n) => n + 1);
    }
  }

  const detail = read.kind === "ok" ? read.detail : null;
  const lines = detail?.log?.lines ?? [];
  const hiddenCount = lines.filter((l) => l.hidden).length;
  const shown = showHidden ? lines : lines.filter((l) => !l.hidden);

  const toolbar = (
    <ToolbarBand>
      <div className="flex flex-wrap items-center gap-2">
        {detail && <DeploymentStatus t={t} status={detail.deployment.status} />}
        {detail &&
          (ended(detail) ? (
            <span className="text-xs text-muted-foreground">
              {t("deployments.log.ended")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("deployments.log.live")}
            </span>
          ))}
        <Button
          size="sm"
          variant={showHidden ? "default" : "outline"}
          aria-pressed={showHidden}
          onClick={() => setShowHidden((v) => !v)}
        >
          <EyeOff className="size-3.5" />
          {t("deployments.log.showHidden")}
        </Button>
        {hiddenCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {t("deployments.log.hiddenCount", { count: hiddenCount })}
          </span>
        )}
        {canCancel && detail?.cancellable && (
          <Button
            size="sm"
            variant="outline"
            disabled={cancelling}
            onClick={() => void cancel(detail.deployment)}
          >
            <CircleStop className="size-3.5" />
            {t("deployments.cancel")}
          </Button>
        )}
      </div>
    </ToolbarBand>
  );

  let body;
  if (read.kind === "loading") {
    body = <LoadingState label={t("deployments.log.loading")} />;
  } else if (read.kind === "failed") {
    body = (
      <div className="p-4">
        <NoticePanel
          icon={TriangleAlert}
          title={t("deployments.log.failed")}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setState({ key, read: { kind: "loading" } });
                setAttempt((n) => n + 1);
              }}
            >
              {t("deployments.log.retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (!read.detail.log) {
    body = (
      <div className="p-4">
        <NoticePanel icon={ScrollText} title={t("deployments.log.noAccess")} />
      </div>
    );
  } else if (shown.length === 0) {
    body = <EmptyState icon={ScrollText} title={t("deployments.log.empty")} />;
  } else {
    body = (
      <div
        className="min-h-0 flex-1 overflow-auto bg-muted/30 px-3 py-2 font-mono text-xs leading-5"
        role="log"
        aria-label={t("deployments.log.title")}
      >
        {read.detail.log.truncated && (
          <div className="text-muted-foreground">
            {t("deployments.log.truncated", { count: lines.length })}
          </div>
        )}
        {shown.map((line) => (
          <div
            key={line.order}
            className={
              line.hidden
                ? "whitespace-pre-wrap break-all text-muted-foreground"
                : line.stream === "stderr"
                  ? "whitespace-pre-wrap break-all text-destructive"
                  : "whitespace-pre-wrap break-all"
            }
          >
            {line.output}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {body}
    </div>
  );
}
