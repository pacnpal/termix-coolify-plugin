import type { ReactNode } from "react";
import { LayoutDashboard, Rocket } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  LoadingState,
  NoticePanel,
  PanelShell,
  RefreshButton,
  StatTile,
  TileStack,
  TileWall,
} from "@termix-ssh/plugin-sdk/ui";
import {
  RESOURCE_HEALTHS,
  type ResourceHealth,
} from "../../shared/resource-health";
import type { QueueDeployment } from "../api";
import { QueueList } from "./DeploymentsSection";
import { formatTime } from "./resource-model";
import type { DeploymentQueueState } from "./useDeploymentQueue";
import type { ResourcesState } from "./useResources";

const TILE_TONE: Record<
  ResourceHealth,
  (count: number) => "default" | "ok" | "warn" | "bad"
> = {
  running: (n) => (n > 0 ? "ok" : "default"),
  degraded: (n) => (n > 0 ? "warn" : "default"),
  stopped: () => "default",
  deploying: () => "default",
};

/**
 * Deployments in progress across the connection, from the tab's shared queue
 * read. A row opens its build log in the Deployments section when allowed.
 */
function InProgress({
  queue,
  onOpen,
  onShowAll,
}: {
  queue: DeploymentQueueState;
  onOpen?: (row: QueueDeployment) => void;
  onShowAll: () => void;
}) {
  const { t } = useTranslation();
  const list = queue.queue;
  let body;
  if (list === null) {
    body = queue.error ? (
      <NoticePanel tone="destructive" title={queue.error} />
    ) : (
      <LoadingState label={t("deploymentsSection.loading")} />
    );
  } else if (!list.running.length) {
    body = <EmptyState icon={Rocket} title={t("overview.inProgress.empty")} />;
  } else {
    body = <QueueList rows={list.running} onOpen={onOpen} />;
  }
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-sm font-medium">
          {t("overview.inProgress.title")}
        </h3>
        <Button size="sm" variant="ghost" onClick={onShowAll}>
          {t("overview.inProgress.showAll")}
        </Button>
      </div>
      {body}
    </section>
  );
}

/**
 * The Overview section: one tile per status, and the deployments in progress.
 * A tile opens the Resources list filtered to that status.
 */
export function OverviewView({
  resources,
  queue,
  picker,
  onShowResources,
  onOpenDeployment,
  onShowDeployments,
}: {
  resources: ResourcesState;
  /** The connection's deployment queue, shared with the Deployments section. */
  queue: DeploymentQueueState;
  /** The connection switcher, when there is more than one connection. */
  picker?: ReactNode;
  onShowResources: (health: ResourceHealth) => void;
  /** Opens a deployment's build log; absent without operate. */
  onOpenDeployment?: (row: QueueDeployment) => void;
  onShowDeployments: () => void;
}) {
  const { t } = useTranslation();
  const { list, loading, error, reload } = resources;
  const updated = formatTime(list?.fetchedAt ?? null);
  return (
    <PanelShell
      icon={<LayoutDashboard className="size-4" />}
      title={t("overview.title")}
      status={updated ? t("overview.updated", { time: updated }) : undefined}
      actions={
        <>
          {picker}
          <RefreshButton
            onClick={() => {
              void reload(true);
              void queue.reload(true);
            }}
            loading={loading}
            label={t("overview.refresh")}
          />
        </>
      }
    >
      {error && <NoticePanel tone="destructive" title={error} />}
      {list === null ? (
        !error && <LoadingState label={t("overview.loading")} />
      ) : (
        <TileStack>
          <TileWall gridClassName="grid-cols-2 md:grid-cols-4">
            {RESOURCE_HEALTHS.map((health) => (
              <StatTile
                key={health}
                label={t(`overview.tiles.${health}`)}
                value={list.counts[health]}
                tone={TILE_TONE[health](list.counts[health])}
                hint={t("overview.tiles.open")}
                onClick={() => onShowResources(health)}
              />
            ))}
          </TileWall>
        </TileStack>
      )}
      <InProgress
        queue={queue}
        onOpen={onOpenDeployment}
        onShowAll={onShowDeployments}
      />
    </PanelShell>
  );
}
