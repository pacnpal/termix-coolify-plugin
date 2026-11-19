import type { ReactNode } from "react";
import { LayoutDashboard } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
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
import { formatTime } from "./resource-model";
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
 * The Overview section: one tile per status. A tile opens the Resources list
 * filtered to that status.
 */
export function OverviewView({
  resources,
  picker,
  onShowResources,
}: {
  resources: ResourcesState;
  /** The connection switcher, when there is more than one connection. */
  picker?: ReactNode;
  onShowResources: (health: ResourceHealth) => void;
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
            onClick={() => void reload(true)}
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
    </PanelShell>
  );
}
