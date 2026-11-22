import { useEffect, useMemo, useState } from "react";
import { Rocket, RotateCw, ScrollText, SquareTerminal } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTabs,
  useTranslation,
  type CompanionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  EmptyState,
  ListRowAction,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  PanelShell,
  StatusBadge,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Connection, type Resource } from "../api";
import { linkOf, type HostLink } from "../linked";
import { resourceHealth } from "../../shared/resource-health";
import { OPERATE_ACCESS } from "./CoolifyTab";
import { LogsView } from "./LogsView";
import { useLifecycle } from "./ResourceActions";
import { useResources } from "./useResources";
import { openShellTab } from "./ShellTab";
import {
  groupResources,
  HEALTH_TONE,
  healthLabel,
  kindLabel,
} from "./resource-model";

const isPart = (r: Resource) =>
  r.kind === "service-application" || r.kind === "service-database";

/**
 * The Coolify panel beside a terminal. On a Linked host it lists the
 * resources on that host's Coolify server; on any other host it draws
 * nothing and asks nothing. Everything below is keyed by the link, so a
 * terminal that moves to another host starts empty and the old host's
 * answers land nowhere.
 */
export function TerminalCompanion({ host, isVisible }: CompanionProps) {
  const canView = usePermission("view");
  const link = linkOf(host);
  if (!link || !canView) return null;
  return (
    <ServerResources
      key={`${link.connectionId}:${link.serverUuid}`}
      link={link}
      isVisible={isVisible}
    />
  );
}

function ServerResources({
  link,
  isVisible,
}: {
  link: HostLink;
  isVisible: boolean;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const tabs = useTabs();
  const confirm = useConfirm();
  const mayOperate = usePermission("operate");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [logsOf, setLogsOf] = useState<string | null>(null);

  // The connection says how this user may use it (owner or grant level) and
  // its revision, which keys the shared resource list.
  useEffect(() => {
    let live = true;
    api
      .getConnection(link.connectionId)
      .then((c) => live && setConnection(c))
      .catch(() => live && setConnectionFailed(true));
    return () => {
      live = false;
    };
  }, [api, link.connectionId]);

  const resources = useResources(
    api,
    connection?.id ?? null,
    connection?.revision ?? null,
  );
  const lifecycle = useLifecycle(
    link.connectionId,
    () => void resources.reload(true),
  );
  // The same rule as the resource detail's canOperate.
  const canOperate =
    mayOperate && !!connection && OPERATE_ACCESS.has(connection.access);

  const rows = useMemo(
    () =>
      groupResources(
        (resources.list?.rows ?? []).filter(
          (r) => r.serverUuid === link.serverUuid,
        ),
      ).flatMap((g) => [g.resource, ...g.parts]),
    [resources.list, link.serverUuid],
  );

  async function confirmThen(resource: Resource, verb: "restart" | "deploy") {
    const key = `terminalCompanion.${verb}Confirm`;
    const ok = await confirm({
      title: t(`${key}.title`, { name: resource.name }),
      description: t(`${key}.description`),
      confirmLabel: t(`${key}.confirm`),
      destructive: false,
    });
    if (ok) await lifecycle.run(resource, verb);
  }

  if (connectionFailed) {
    return (
      <NoticePanel
        tone="destructive"
        title={t("terminalCompanion.loadFailed")}
      />
    );
  }

  const open = logsOf ? rows.find((r) => r.uuid === logsOf) : undefined;
  if (open && connection && canOperate) {
    return (
      <PanelShell
        icon={<ScrollText className="size-4" />}
        title={open.name}
        leading={
          <BackButton
            label={t("terminalCompanion.back")}
            onClick={() => setLogsOf(null)}
          />
        }
        scroll={false}
      >
        <LogsView
          key={`${connection.id}:${open.uuid}:${connection.revision ?? ""}`}
          connectionId={connection.id}
          resource={open}
          isVisible={isVisible}
        />
      </PanelShell>
    );
  }

  if (resources.error) {
    return <NoticePanel tone="destructive" title={resources.error} />;
  }
  if (!resources.list) {
    return <LoadingState label={t("terminalCompanion.loading")} />;
  }

  return (
    <PanelList
      empty={<EmptyState icon={Rocket} title={t("terminalCompanion.empty")} />}
    >
      {rows.map((r, i) => (
        <ListRow
          key={r.uuid}
          stripe={i}
          title={r.name}
          className={isPart(r) ? "pl-4" : undefined}
          meta={kindLabel(t, r.kind)}
          badges={
            <StatusBadge tone={HEALTH_TONE[resourceHealth(r.status)]}>
              {healthLabel(t, r.status)}
            </StatusBadge>
          }
          trailing={
            canOperate && connection ? (
              <div className="flex items-center gap-0.5">
                <ListRowAction
                  label={t("terminalCompanion.shell", { name: r.name })}
                  aria-label={t("terminalCompanion.shell", { name: r.name })}
                  onClick={() => openShellTab(tabs, t, connection, r, "shell")}
                >
                  <SquareTerminal className="size-3.5" />
                </ListRowAction>
                <ListRowAction
                  label={t("terminalCompanion.logs", { name: r.name })}
                  aria-label={t("terminalCompanion.logs", { name: r.name })}
                  onClick={() => setLogsOf(r.uuid)}
                >
                  <ScrollText className="size-3.5" />
                </ListRowAction>
                <ListRowAction
                  label={t("terminalCompanion.restart", { name: r.name })}
                  aria-label={t("terminalCompanion.restart", { name: r.name })}
                  disabled={lifecycle.busy !== null}
                  onClick={() => void confirmThen(r, "restart")}
                >
                  <RotateCw className="size-3.5" />
                </ListRowAction>
                {!isPart(r) && (
                  <ListRowAction
                    label={t("terminalCompanion.deploy", { name: r.name })}
                    aria-label={t("terminalCompanion.deploy", { name: r.name })}
                    disabled={lifecycle.busy !== null}
                    onClick={() => void confirmThen(r, "deploy")}
                  >
                    <Rocket className="size-3.5" />
                  </ListRowAction>
                )}
              </div>
            ) : undefined
          }
        />
      ))}
    </PanelList>
  );
}
