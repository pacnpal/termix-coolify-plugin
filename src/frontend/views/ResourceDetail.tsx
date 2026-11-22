import { useState, type ReactNode } from "react";
import { Box, Database, SquareTerminal } from "lucide-react";
import { useTabs, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
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
import { resourceHealth } from "../../shared/resource-health";
import { CompanionActions } from "./CompanionActions";
import { DeploymentsTab } from "./DeploymentsTab";
import { PreviewsTab } from "./PreviewsTab";
import { ContainerCompanions } from "./ContainerCompanions";
import { LogsView } from "./LogsView";
import { StatsTab } from "./StatsTab";
import { TrafficTab } from "./TrafficTab";
import {
  PartRestart,
  ResourceActions,
  useLifecycle,
  type LifecycleRunner,
} from "./ResourceActions";
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
 * the body switch.
 */
export const DETAIL_TABS = [
  "overview",
  "shell",
  "logs",
  "deployments",
  "previews",
  "stats",
  "traffic",
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/**
 * A requested view (from tab data, like the palette's "Logs of…"), or the
 * default view when this release doesn't have the one asked for.
 */
export function detailTabOf(requested: unknown): DetailTab {
  return (DETAIL_TABS as readonly unknown[]).includes(requested)
    ? (requested as DetailTab)
    : "overview";
}

/**
 * Views that need canOperate: logs carry secrets, and stats and traffic read
 * over SSH, so they need coolify.operate and the owner or an operate grant,
 * as the backend does.
 */
const OPERATE_TABS: ReadonlySet<DetailTab> = new Set([
  "logs",
  "stats",
  "traffic",
]);

/** Views only applications have: Coolify deploys nothing else on its own. */
const APPLICATION_TABS: ReadonlySet<DetailTab> = new Set([
  "deployments",
  "previews",
  "traffic",
]);

/**
 * The tabs a resource shows: Deployments, Previews and Traffic are for
 * applications.
 */
export function detailTabs(
  resource: Resource | null,
  canOperate: boolean,
): DetailTab[] {
  return DETAIL_TABS.filter(
    (id) =>
      (canOperate || !OPERATE_TABS.has(id)) &&
      (!APPLICATION_TABS.has(id) || resource?.kind === "application"),
  );
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
  lifecycle,
  connectionId,
  revision,
}: {
  t: T;
  connectionId: number;
  revision: string | null;
  resource: Resource;
  rows: readonly Resource[];
  onOpen: (uuid: string) => void;
  /** Null without the right to operate: no Part buttons. */
  lifecycle: LifecycleRunner | null;
}) {
  const service = resource.parentUuid
    ? (rows.find((r) => r.uuid === resource.parentUuid) ?? null)
    : null;
  const parts = rows.filter((r) => r.parentUuid === resource.uuid);
  const tabs = useTabs();
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
                trailing={
                  lifecycle ? (
                    <PartRestart part={p} lifecycle={lifecycle} />
                  ) : undefined
                }
                onClick={() => onOpen(p.uuid)}
              />
            ))}
          </PanelList>
        </div>
      )}
      <ContainerCompanions
        connectionId={connectionId}
        resource={resource}
        revision={revision}
        canOperate={lifecycle !== null}
      />
      <div className="p-3">
        <CompanionActions
          connectionId={connectionId}
          resource={resource}
          revision={revision}
          shell={tabs}
        />
      </div>
    </TileStack>
  );
}

/** A database or a service's database Part: it has a native console. */
export function hasConsole(r: Resource): boolean {
  return r.kind === "database" || r.kind === "service-database";
}

/**
 * Opens a container shell, or a database's console, in a coolify-shell tab.
 * The backend checks the rest: the Linked host and the actor's access to it.
 */
function ShellPanel({
  t,
  resource,
  onShell,
}: {
  t: T;
  resource: Resource;
  /** Null without the right to operate the connection. */
  onShell: ((resource: Resource, console: "shell" | "db") => void) | null;
}) {
  if (!onShell) {
    return (
      <EmptyState icon={SquareTerminal} title={t("detail.shell.noAccess")} />
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-sm text-muted-foreground">{t("detail.shell.hint")}</p>
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
    </div>
  );
}

/**
 * One resource or Part, opened in place over the list. The header names it
 * and its status, with Deploy, Force rebuild, Restart and Start or Stop for
 * people who may operate the connection; a service's Parts restart one by one.
 */
export function ResourceDetail({
  resource,
  rows,
  onOpen,
  onClose,
  connectionId,
  canOperate,
  onChanged,
  onShell,
  revision,
  isVisible = true,
  initialTab,
}: {
  /** Null when the resource is gone from the list. */
  resource: Resource | null;
  rows: readonly Resource[];
  onOpen: (uuid: string) => void;
  onClose: () => void;
  connectionId: number;
  /** coolify.operate and the owner or an operate grant on the connection. */
  canOperate: boolean;
  /** After a lifecycle action, so the list fetches fresh statuses. */
  onChanged: () => void;
  /** Opens a coolify-shell tab for the resource. */
  onShell?: (resource: Resource, console: "shell" | "db") => void;
  /** The connection's target hash, which keys the companion and log views. */
  revision?: string | null;
  /** Whether the tab is shown; a live log follow stops while it isn't. */
  isVisible?: boolean;
  /** The view to open on; an unknown one opens the default. */
  initialTab?: string | null;
}) {
  const { t } = useTranslation();
  const runner = useLifecycle(
    connectionId,
    onChanged,
    `${connectionId}\n${resource?.uuid ?? ""}\n${revision ?? ""}`,
  );
  const lifecycle = canOperate ? runner : null;
  const tabs = detailTabs(resource, canOperate);
  const [chosen, setTab] = useState<DetailTab>(() => detailTabOf(initialTab));
  const tab = tabs.includes(chosen) ? chosen : "overview";
  let body: ReactNode;
  if (!resource) {
    body = <EmptyState icon={Box} title={t("detail.missing")} />;
  } else {
    switch (tab) {
      case "overview":
        body = (
          <OverviewTab
            t={t}
            resource={resource}
            rows={rows}
            onOpen={onOpen}
            lifecycle={lifecycle}
            connectionId={connectionId}
            revision={revision ?? null}
          />
        );
        break;
      case "shell":
        body = (
          <ShellPanel
            t={t}
            resource={resource}
            onShell={canOperate && onShell ? onShell : null}
          />
        );
        break;
      case "logs":
        // Keyed by connection, resource and target: any change starts empty
        // and closes the old follow.
        body = (
          <LogsView
            key={`${connectionId}:${resource.uuid}:${revision ?? ""}`}
            connectionId={connectionId}
            resource={resource}
            isVisible={isVisible}
          />
        );
        break;
      case "deployments":
        // Keyed like logs: a changed target starts empty and stops polling.
        body = (
          <DeploymentsTab
            key={`${connectionId}:${resource.uuid}:${revision ?? ""}`}
            connectionId={connectionId}
            resource={resource}
            canOperate={canOperate}
            isVisible={isVisible}
          />
        );
        break;
      case "previews":
        // Keyed like logs: a changed target starts empty.
        body = (
          <PreviewsTab
            key={`${connectionId}:${resource.uuid}:${revision ?? ""}`}
            connectionId={connectionId}
            resource={resource}
            canOperate={canOperate}
            isVisible={isVisible}
          />
        );
        break;
      case "stats":
        // Keyed like logs: a changed target starts empty and closes the socket.
        body = (
          <StatsTab
            key={`${connectionId}:${resource.uuid}:${revision ?? ""}`}
            connectionId={connectionId}
            resource={resource}
            isVisible={isVisible}
          />
        );
        break;
      case "traffic":
        body = (
          <TrafficTab
            key={`${connectionId}:${resource.uuid}:${revision ?? ""}`}
            connectionId={connectionId}
            resource={resource}
          />
        );
        break;
    }
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
      actions={
        resource && lifecycle ? (
          <ResourceActions resource={resource} lifecycle={lifecycle} />
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
      bare
    >
      {body}
    </InlineView>
  );
}
