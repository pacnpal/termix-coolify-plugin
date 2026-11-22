import { useMemo, type ReactNode } from "react";
import { Activity, CircleCheck, Rocket } from "lucide-react";
import type { PanelProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  ListBadge,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  PanelShell,
  RefreshButton,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  type AttentionConnection,
  type QueueDeployment,
} from "../api";
import { DeploymentStatus } from "./BuildLogView";
import { describeFailure } from "./ConnectionForm";
import { syncable } from "./ConnectionsView";
import { formatTime } from "./resource-model";
import { PANEL_POLL_MS, useAttention } from "./useAttention";

const TAB_ID = "coolify";

/** One row of the panel, with where in the coolify tab it opens. */
interface Item {
  key: string;
  title: string;
  meta: string;
  badge: ReactNode;
  data: Record<string, unknown>;
}

function Section({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: Item[];
  onOpen: (item: Item) => void;
}) {
  if (!items.length) return null;
  return (
    <>
      <h3 className="px-3 pt-3 text-xs font-medium uppercase text-muted-foreground">
        {title}
      </h3>
      <PanelList>
        {items.map((item, i) => (
          <ListRow
            key={item.key}
            stripe={i}
            title={item.title}
            meta={item.meta}
            badges={item.badge}
            onClick={() => onOpen(item)}
          />
        ))}
      </PanelList>
    </>
  );
}

/**
 * The slim sidebar panel: deployments in progress and attention items
 * (recent failed deployments, degraded resources, unreachable servers)
 * across every connection the user can view. It reads only GET /attention,
 * the same cached read as the rail badge, and polls while it is shown. Each
 * row opens its place in the coolify tab: a deployment's build log, a
 * resource's detail, or a connection's Servers (Overview for anyone who
 * can't sync it).
 */
export function ActivityPanel({ active, shell }: PanelProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const canView = usePermission("view");
  const canConfigure = usePermission("configure");
  const { attention, loading, failed, reload } = useAttention(
    api,
    active && canView,
    PANEL_POLL_MS,
  );
  const several = (attention?.connections.length ?? 0) > 1;

  const open = (data: Record<string, unknown>) =>
    shell.openSingletonTab(TAB_ID, { data });

  const meta = (c: AttentionConnection, ...parts: (string | null)[]) =>
    [...parts, several ? c.name : null].filter(Boolean).join(" · ");

  const deploymentItem = (
    c: AttentionConnection,
    d: QueueDeployment,
  ): Item => ({
    key: `${c.id}:deployment:${d.uuid}`,
    title: d.commitMessage ?? d.commit ?? d.uuid,
    meta: meta(c, d.resourceName, formatTime(d.createdAt)),
    badge: <DeploymentStatus t={t} status={d.status} />,
    data: {
      section: "deployments",
      connectionId: c.id,
      resourceUuid: d.resourceUuid,
      deploymentUuid: d.uuid,
    },
  });

  const connections = attention?.connections ?? [];
  const inProgress = connections.flatMap((c) =>
    c.running.map((d) => deploymentItem(c, d)),
  );
  const needsLook = connections.flatMap((c) => [
    ...c.failed.map((d) => deploymentItem(c, d)),
    ...c.degraded.map((r): Item => ({
      key: `${c.id}:resource:${r.uuid}`,
      title: r.name,
      meta: meta(
        c,
        [r.projectName, r.environmentName].filter(Boolean).join(" / "),
        r.serverName,
      ),
      badge: (
        <ListBadge tone="warning">{t("activityPanel.degraded")}</ListBadge>
      ),
      data: { section: "resources", connectionId: c.id, uuid: r.uuid },
    })),
    ...c.unreachable.map((s): Item => ({
      key: `${c.id}:server:${s.uuid}`,
      title: s.name,
      meta: meta(c, t("activityPanel.server")),
      badge: (
        <ListBadge tone="destructive">
          {t("activityPanel.unreachable")}
        </ListBadge>
      ),
      data: {
        section: canConfigure && syncable(c) ? "servers" : "overview",
        connectionId: c.id,
      },
    })),
  ]);
  const errors = connections.filter((c) => c.error);

  let body: ReactNode;
  if (!canView) {
    body = <NoticePanel title={t("activityPanel.noView")} />;
  } else if (attention === null) {
    body = failed ? (
      <NoticePanel tone="destructive" title={t("activityPanel.failed")} />
    ) : (
      <LoadingState label={t("activityPanel.loading")} />
    );
  } else if (!connections.length) {
    body = (
      <EmptyState
        icon={Rocket}
        title={t("activityPanel.noConnections.title")}
        hint={t("activityPanel.noConnections.hint")}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => open({ section: "connections" })}
          >
            {t("activityPanel.openTab")}
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col">
        {failed && (
          <NoticePanel tone="destructive" title={t("activityPanel.failed")} />
        )}
        {errors.map((c) => (
          <NoticePanel
            key={c.id}
            tone="destructive"
            title={t("activityPanel.readFailed", {
              name: c.name,
              reason: describeFailure(t, { response: { data: c.error } }),
            })}
          />
        ))}
        <Section
          title={t("activityPanel.inProgress")}
          items={inProgress}
          onOpen={(item) => open(item.data)}
        />
        <Section
          title={t("activityPanel.attention")}
          items={needsLook}
          onOpen={(item) => open(item.data)}
        />
        {!inProgress.length && !needsLook.length && !errors.length && (
          <EmptyState
            icon={CircleCheck}
            title={t("activityPanel.empty.title")}
            hint={t("activityPanel.empty.hint")}
          />
        )}
      </div>
    );
  }

  const updated = formatTime(attention?.fetchedAt ?? null);
  return (
    <PanelShell
      icon={<Activity className="size-4" />}
      title={t("activityPanel.title")}
      status={
        updated ? t("activityPanel.updated", { time: updated }) : undefined
      }
      actions={
        canView ? (
          <RefreshButton
            onClick={() => void reload(true)}
            loading={loading}
            label={t("activityPanel.refresh")}
          />
        ) : undefined
      }
    >
      {body}
    </PanelShell>
  );
}
