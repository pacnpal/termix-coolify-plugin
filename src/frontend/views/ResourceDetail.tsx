import { useState, type ReactNode } from "react";
import { Box, Database, SquareTerminal } from "lucide-react";
import { usePermission, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  GroupHeading,
  InfoGrid,
  InlineView,
  ListRow,
  PanelList,
  StatusBadge,
  TabStrip,
  TileStack,
  type InfoItem,
} from "@termix-ssh/plugin-sdk/ui";
import type { Resource } from "../api";
import { StatsTab } from "./StatsTab";
import { TrafficTab } from "./TrafficTab";
import { resourceHealth } from "../../shared/resource-health";
import {
  formatTime,
  HEALTH_TONE,
  healthLabel,
  kindLabel,
  serverLabel,
} from "./resource-model";

type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * The detail views: one id, one locale key under detail.tabs and one case in
 * the body. Stats and Traffic read over SSH, so they need coolify.operate;
 * Traffic is for applications.
 */
export const DETAIL_TABS = ["overview", "stats", "traffic"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** The tabs this resource shows to someone with or without coolify.operate. */
export function detailTabs(
  resource: Resource | null,
  canOperate: boolean,
): DetailTab[] {
  if (!resource || !canOperate) return ["overview"];
  return resource.kind === "application"
    ? ["overview", "stats", "traffic"]
    : ["overview", "stats"];
}

function overviewItems(
  t: T,
  r: Resource,
  service: Resource | null,
): InfoItem[] {
  return [
    { label: t("detail.fields.type"), value: kindLabel(t, r.kind) },
    {
      label: t("detail.fields.status"),
      value: (
        <StatusBadge tone={HEALTH_TONE[resourceHealth(r.status)]}>
          {healthLabel(t, r.status)}
        </StatusBadge>
      ),
    },
    { label: t("detail.fields.coolifyStatus"), value: r.status, mono: true },
    { label: t("detail.fields.service"), value: service?.name ?? "" },
    { label: t("detail.fields.server"), value: serverLabel(r) },
    { label: t("detail.fields.project"), value: r.projectName ?? "" },
    { label: t("detail.fields.environment"), value: r.environmentName ?? "" },
    { label: t("detail.fields.engine"), value: r.engine ?? "", mono: true },
    {
      label: t("detail.fields.domains"),
      value: r.fqdns.length ? (
        <span className="flex flex-col">
          {r.fqdns.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </span>
      ) : (
        ""
      ),
    },
    {
      label: t("detail.fields.lastDeploy"),
      value: formatTime(r.lastDeployAt),
    },
    { label: t("detail.fields.uuid"), value: r.uuid, mono: true },
  ];
}

function OverviewTab({
  t,
  resource,
  rows,
  onOpen,
}: {
  t: T;
  resource: Resource;
  rows: readonly Resource[];
  onOpen: (uuid: string) => void;
}) {
  const service = resource.parentUuid
    ? (rows.find((r) => r.uuid === resource.parentUuid) ?? null)
    : null;
  const parts = rows.filter((r) => r.parentUuid === resource.uuid);
  return (
    <TileStack>
      <div className="p-3">
        <InfoGrid items={overviewItems(t, resource, service)} />
      </div>
      {parts.length > 0 && (
        <div>
          <GroupHeading
            title={t("detail.parts")}
            count={parts.length}
            className="px-3 pt-3"
          />
          <PanelList>
            {parts.map((p, i) => (
              <ListRow
                key={p.uuid}
                stripe={i}
                title={p.name}
                meta={[kindLabel(t, p.kind), p.engine, p.fqdns[0]]
                  .filter(Boolean)
                  .join(" · ")}
                badges={
                  <StatusBadge tone={HEALTH_TONE[resourceHealth(p.status)]}>
                    {healthLabel(t, p.status)}
                  </StatusBadge>
                }
                aria-label={p.name}
                onClick={() => onOpen(p.uuid)}
              />
            ))}
          </PanelList>
        </div>
      )}
    </TileStack>
  );
}

/** A database or a service's database Part: it has a native console. */
export function hasConsole(r: Resource): boolean {
  return r.kind === "database" || r.kind === "service-database";
}

/**
 * One resource or Part, opened in place over the list. The header names it
 * and its status; lifecycle buttons arrive with the lifecycle actions.
 */
export function ResourceDetail({
  resource,
  rows,
  connectionId,
  isVisible = true,
  onOpen,
  onClose,
  onShell,
}: {
  /** Null when the resource is gone from the list. */
  resource: Resource | null;
  /** The connection the resource is read through; Stats and Traffic need it. */
  connectionId?: number | null;
  /** Whether the tab is on screen: the live stats socket closes when not. */
  isVisible?: boolean;
  rows: readonly Resource[];
  onOpen: (uuid: string) => void;
  onClose: () => void;
  /** Opens a coolify-shell tab for the resource. */
  onShell?: (resource: Resource, console: "shell" | "db") => void;
}) {
  const { t } = useTranslation();
  // Shells run over SSH: coolify.operate, plus host access the backend checks.
  const canShell = usePermission("operate");
  const [chosen, setTab] = useState<DetailTab>("overview");
  const tabs = connectionId ? detailTabs(resource, canShell) : ["overview"];
  const tab: DetailTab = tabs.includes(chosen) ? chosen : "overview";
  let body: ReactNode;
  if (!resource) {
    body = <EmptyState icon={Box} title={t("detail.missing")} />;
  } else if (tab === "stats" && connectionId) {
    body = (
      <StatsTab
        key={resource.uuid}
        connectionId={connectionId}
        resource={resource}
        isVisible={isVisible}
      />
    );
  } else if (tab === "traffic" && connectionId) {
    body = (
      <TrafficTab
        key={resource.uuid}
        connectionId={connectionId}
        resource={resource}
      />
    );
  } else {
    body = (
      <OverviewTab t={t} resource={resource} rows={rows} onOpen={onOpen} />
    );
  }
  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={resource?.name ?? ""}
      icon={<Box className="size-4" />}
      status={
        resource ? (
          <StatusBadge tone={HEALTH_TONE[resourceHealth(resource.status)]}>
            {healthLabel(t, resource.status)}
          </StatusBadge>
        ) : undefined
      }
      toolbar={
        <TabStrip
          tabs={tabs.map((id) => ({
            id,
            label: t(`detail.tabs.${id}`),
          }))}
          activeTab={tab}
          onTabChange={(id) => setTab(id as DetailTab)}
        />
      }
      actions={
        resource && onShell && canShell ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onShell(resource, "shell")}
            >
              <SquareTerminal className="size-3.5" />
              {t("detail.actions.shell")}
            </Button>
            {hasConsole(resource) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onShell(resource, "db")}
              >
                <Database className="size-3.5" />
                {t("detail.actions.console")}
              </Button>
            )}
          </div>
        ) : undefined
      }
      bare
    >
      {body}
    </InlineView>
  );
}
