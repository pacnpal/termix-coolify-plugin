import { useState, type ReactNode } from "react";
import { Box } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
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
import {
  formatTime,
  HEALTH_TONE,
  healthLabel,
  kindLabel,
  serverLabel,
} from "./resource-model";

type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * The detail views. Later releases add Shell, Logs, Stats and Traffic here:
 * one id, one locale key under detail.tabs and one case in DetailBody.
 */
export const DETAIL_TABS = ["overview"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

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

/**
 * One resource or Part, opened in place over the list. The header names it
 * and its status; lifecycle buttons arrive with the lifecycle actions.
 */
export function ResourceDetail({
  resource,
  rows,
  onOpen,
  onClose,
}: {
  /** Null when the resource is gone from the list. */
  resource: Resource | null;
  rows: readonly Resource[];
  onOpen: (uuid: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DetailTab>("overview");
  let body: ReactNode;
  if (!resource) {
    body = <EmptyState icon={Box} title={t("detail.missing")} />;
  } else {
    switch (tab) {
      case "overview":
        body = (
          <OverviewTab t={t} resource={resource} rows={rows} onOpen={onOpen} />
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
      toolbar={
        <TabStrip
          tabs={DETAIL_TABS.map((id) => ({
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
