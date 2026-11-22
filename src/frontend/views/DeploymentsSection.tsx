import { useState, type ReactNode } from "react";
import { History, Rocket, Tags, TriangleAlert } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  Button,
  EmptyState,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  PanelShell,
  RefreshButton,
} from "@termix-ssh/plugin-sdk/ui";
import type { Api, QueueDeployment } from "../api";
import { BuildLogView, DeploymentStatus } from "./BuildLogView";
import { DeployByTagForm } from "./DeployByTagForm";
import { formatTime } from "./resource-model";
import type { DeploymentQueueState } from "./useDeploymentQueue";

type T = (key: string, options?: Record<string, unknown>) => string;

/** The application, when it ran, the commit and the server, for a row's meta. */
export function queueMeta(t: T, d: QueueDeployment): string {
  return [
    d.resourceName,
    formatTime(d.createdAt),
    d.commit ? d.commit.slice(0, 7) : null,
    d.serverName,
    d.pullRequestId > 0
      ? t("deployments.preview", { id: d.pullRequestId })
      : null,
    d.rollback ? t("deployments.rollback") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Queue rows as a list; a row opens its build log when `onOpen` is given. */
export function QueueList({
  rows,
  onOpen,
}: {
  rows: QueueDeployment[];
  onOpen?: (row: QueueDeployment) => void;
}) {
  const { t } = useTranslation();
  return (
    <PanelList>
      {rows.map((d, i) => (
        <ListRow
          key={d.uuid}
          stripe={i}
          title={d.commitMessage ?? d.commit ?? d.uuid}
          meta={queueMeta(t, d)}
          badges={<DeploymentStatus t={t} status={d.status} />}
          aria-label={d.commitMessage ?? d.uuid}
          onClick={onOpen ? () => onOpen(d) : undefined}
        />
      ))}
    </PanelList>
  );
}

/** A deployment opened from the section, for the connection it came from. */
export interface OpenDeployment {
  connectionId: number;
  resourceUuid: string;
  deploymentUuid: string;
}

/**
 * The connection-wide Deployments section: what is queued or running and the
 * recent ones across the connection's applications, a deployment's live build
 * log (with cancel, from BuildLogView), and deploy by tag. The queue comes
 * from the tab's shared read; opening a log and deploying need operate.
 */
export function DeploymentsSection({
  api,
  connectionId,
  revision,
  queue,
  canOperate,
  isVisible,
  open,
  onOpen,
  picker,
}: {
  api: Api;
  connectionId: number;
  revision: string | null;
  queue: DeploymentQueueState;
  canOperate: boolean;
  isVisible: boolean;
  /** The build log shown, held by the tab so the queue stops polling under it. */
  open: OpenDeployment | null;
  onOpen: (open: OpenDeployment | null) => void;
  picker?: ReactNode;
}) {
  const { t } = useTranslation();
  const [tagForm, setTagForm] = useState(false);
  const shown = open && open.connectionId === connectionId ? open : null;

  if (shown) {
    return (
      <PanelShell
        icon={<Rocket className="size-4" />}
        title={t("deploymentsSection.title")}
        actions={picker}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border">
            <BackButton
              onClick={() => onOpen(null)}
              label={t("deploymentsSection.back")}
            />
            <span className="truncate font-mono text-xs text-muted-foreground">
              {shown.deploymentUuid}
            </span>
          </div>
          <BuildLogView
            connectionId={shown.connectionId}
            resourceUuid={shown.resourceUuid}
            deploymentUuid={shown.deploymentUuid}
            isVisible={isVisible}
            canCancel={canOperate}
            onChanged={() => void queue.reload(true)}
          />
        </div>
      </PanelShell>
    );
  }

  const openRow = canOperate
    ? (d: QueueDeployment) =>
        onOpen({
          connectionId,
          resourceUuid: d.resourceUuid,
          deploymentUuid: d.uuid,
        })
    : undefined;
  const { queue: list, error, loading } = queue;
  const updated = formatTime(list?.fetchedAt ?? null);

  let body;
  if (list === null) {
    body = error ? (
      <div className="p-4">
        <NoticePanel
          icon={TriangleAlert}
          tone="destructive"
          title={error}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void queue.reload(true)}
            >
              {t("deploymentsSection.retry")}
            </Button>
          }
        />
      </div>
    ) : (
      <LoadingState label={t("deploymentsSection.loading")} />
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {error && <NoticePanel tone="destructive" title={error} />}
        <h3 className="px-4 pt-3 text-xs font-medium uppercase text-muted-foreground">
          {t("deploymentsSection.running")}
        </h3>
        {list.running.length ? (
          <QueueList rows={list.running} onOpen={openRow} />
        ) : (
          <EmptyState icon={Rocket} title={t("deploymentsSection.noRunning")} />
        )}
        <h3 className="px-4 pt-3 text-xs font-medium uppercase text-muted-foreground">
          {t("deploymentsSection.recent")}
        </h3>
        {list.recent.length ? (
          <QueueList rows={list.recent} onOpen={openRow} />
        ) : (
          <EmptyState icon={History} title={t("deploymentsSection.noRecent")} />
        )}
        {!canOperate && (
          <span className="px-4 pb-3 text-xs text-muted-foreground">
            {t("deployments.noLogAccess")}
          </span>
        )}
      </div>
    );
  }

  return (
    <PanelShell
      icon={<Rocket className="size-4" />}
      title={t("deploymentsSection.title")}
      status={
        updated ? t("deploymentsSection.updated", { time: updated }) : undefined
      }
      actions={
        <>
          {picker}
          {canOperate && (
            <Button
              size="sm"
              variant={tagForm ? "default" : "outline"}
              aria-pressed={tagForm}
              onClick={() => setTagForm((v) => !v)}
            >
              <Tags className="size-3.5" />
              {t("deployByTag.open")}
            </Button>
          )}
          <RefreshButton
            onClick={() => void queue.reload(true)}
            loading={loading}
            label={t("deploymentsSection.refresh")}
          />
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto">
        {canOperate && tagForm && (
          <DeployByTagForm
            key={`${connectionId}\n${revision}`}
            api={api}
            connectionId={connectionId}
            revision={revision}
            onDeployed={() => void queue.reload(true)}
            onClose={() => setTagForm(false)}
          />
        )}
        {body}
      </div>
    </PanelShell>
  );
}
