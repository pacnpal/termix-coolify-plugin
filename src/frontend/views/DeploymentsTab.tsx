import { useEffect, useMemo, useState } from "react";
import { History, TriangleAlert, Undo2 } from "lucide-react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  Button,
  EmptyState,
  ListRow,
  LoadingState,
  NoticePanel,
  Pager,
  PanelList,
  RefreshButton,
  ToolbarBand,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  type Deployment,
  type DeploymentPage,
  type Resource,
} from "../api";
import { BuildLogView, DeploymentStatus } from "./BuildLogView";
import { RollbackView } from "./RollbackView";
import { formatTime } from "./resource-model";

/** Rows a history page shows. */
export const DEPLOYMENTS_PAGE_SIZE = 10;

type T = (key: string, options?: Record<string, unknown>) => string;

type Load =
  | { kind: "loading" }
  | { kind: "ok"; page: DeploymentPage }
  | { kind: "failed" };

/** Commit, server, and what kind of deployment it was, for a row's meta. */
function metaOf(t: T, d: Deployment): string {
  return [
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

/**
 * An application's deployments: history a page at a time, newest first, and
 * a deployment's live build log when a row is opened. Opening a log needs
 * canOperate (build logs hold secrets), as the backend does. Keyed by
 * connection, application and target where it is used, so any change starts
 * empty.
 */
export function DeploymentsTab({
  connectionId,
  resource,
  canOperate,
  isVisible = true,
}: {
  connectionId: number;
  resource: Resource;
  canOperate: boolean;
  /** Whether the tab is shown; an open build log stops polling while it isn't. */
  isVisible?: boolean;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  // Rollback is for applications, and needs operate as the backend does.
  const canRollback = canOperate && resource.kind === "application";
  const [rollingBack, setRollingBack] = useState(false);
  // Each answer is stored with the page it is for, so another page never
  // shows it.
  const [state, setState] = useState<{ page: number; load: Load }>({
    page: 0,
    load: { kind: "loading" },
  });
  const load: Load = state.page === page ? state.load : { kind: "loading" };

  useEffect(() => {
    if (open || rollingBack) return;
    let live = true;
    setState({ page, load: { kind: "loading" } });
    api
      .listDeployments(connectionId, resource.uuid, {
        skip: page * DEPLOYMENTS_PAGE_SIZE,
        take: DEPLOYMENTS_PAGE_SIZE,
      })
      .then((answer) => {
        if (live) setState({ page, load: { kind: "ok", page: answer } });
      })
      .catch(() => {
        if (live) setState({ page, load: { kind: "failed" } });
      });
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid, page, attempt, open, rollingBack]);

  if (rollingBack && canRollback) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border">
          <BackButton
            onClick={() => setRollingBack(false)}
            label={t("deployments.back")}
          />
        </div>
        <div className="min-h-0 flex-1">
          <RollbackView
            connectionId={connectionId}
            resource={resource}
            onDone={() => {
              setRollingBack(false);
              setPage(0);
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      </div>
    );
  }

  if (open) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border">
          <BackButton
            onClick={() => setOpen(null)}
            label={t("deployments.back")}
          />
          <span className="truncate font-mono text-xs text-muted-foreground">
            {open}
          </span>
        </div>
        <BuildLogView
          connectionId={connectionId}
          resourceUuid={resource.uuid}
          deploymentUuid={open}
          isVisible={isVisible}
          canCancel={canOperate}
        />
      </div>
    );
  }

  let body;
  if (load.kind === "loading") {
    body = <LoadingState label={t("deployments.loading")} />;
  } else if (load.kind === "failed") {
    body = (
      <div className="p-4">
        <NoticePanel
          icon={TriangleAlert}
          title={t("deployments.failed")}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t("deployments.retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (load.page.rows.length === 0 && page === 0) {
    body = <EmptyState icon={History} title={t("deployments.empty")} />;
  } else {
    const { rows, count } = load.page;
    body = (
      <>
        <PanelList>
          {rows.map((d, i) => (
            <ListRow
              key={d.uuid}
              stripe={i}
              title={d.commitMessage ?? d.commit ?? d.uuid}
              meta={metaOf(t, d)}
              badges={<DeploymentStatus t={t} status={d.status} />}
              aria-label={d.commitMessage ?? d.uuid}
              onClick={canOperate ? () => setOpen(d.uuid) : undefined}
            />
          ))}
        </PanelList>
        <Pager
          page={page}
          pages={
            count === null
              ? undefined
              : Math.max(1, Math.ceil(count / DEPLOYMENTS_PAGE_SIZE))
          }
          hasNext={
            count === null ? rows.length === DEPLOYMENTS_PAGE_SIZE : undefined
          }
          onPage={setPage}
        />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarBand>
        <RefreshButton
          label={t("deployments.refresh")}
          loading={load.kind === "loading"}
          onClick={() => setAttempt((n) => n + 1)}
        />
        {canRollback && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRollingBack(true)}
          >
            <Undo2 className="size-3.5" />
            {t("deployments.rollbackOpen")}
          </Button>
        )}
        {!canOperate && (
          <span className="text-xs text-muted-foreground">
            {t("deployments.noLogAccess")}
          </span>
        )}
      </ToolbarBand>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
