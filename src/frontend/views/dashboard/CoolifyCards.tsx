import { useEffect, useMemo, useRef, useState } from "react";
import { Rocket, Shield, ShieldCheck, ShieldQuestion } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  StatTile,
  StatusBadge,
  TileWall,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  type Api,
  type Connection,
  type Resource,
  type VulnerabilitySummary,
} from "../../api";
import {
  CARD_POLL_MS,
  readCardConfig,
  type CardConfig,
  type CardKind,
} from "../../../shared/dashboard";
import {
  RESOURCE_HEALTHS,
  resourceHealth,
} from "../../../shared/resource-health";
import { useConfirmFor } from "../../confirm";
import { OPERATE_ACCESS } from "../CoolifyTab";
import { QueueList } from "../DeploymentsSection";
import { useLifecycle } from "../ResourceActions";
import { HEALTH_TONE, healthLabel, kindLabel } from "../resource-model";
import { useCardRead, type CardState } from "./useCardRead";

type T = ReturnType<typeof useTranslation>["t"];

export interface CardViewProps {
  /** Which card: fixed per homepage widget, from the entry on the dashboard. */
  kind: CardKind;
  /** The card's saved settings. */
  config?: Record<string, unknown>;
  /** Saves them; absent where the card can't save its own settings. */
  setConfig?: (config: Record<string, unknown>) => void;
  /** Reads and polls only while true. */
  active: boolean;
  /** The dashboard is being arranged: show the settings. */
  editMode?: boolean;
}

const isPart = (r: Resource) => r.parentUuid !== null;

/** A card's target is chosen once it has a connection (and a resource). */
function isChosen(config: CardConfig): boolean {
  return (
    config.connectionId !== null &&
    (config.card !== "resource" || config.uuid !== null)
  );
}

/**
 * One Coolify card, on the dashboard or the homepage. It needs coolify.view;
 * until a connection (and for the resource card a resource) is chosen it
 * shows its settings where it can save them, and otherwise says to pick one.
 * The body is keyed by the target, so a new choice starts from loading.
 */
export function CardView(props: CardViewProps) {
  const { t } = useTranslation();
  const canView = usePermission("view");
  const config: CardConfig = {
    ...readCardConfig(props.config, props.kind),
    card: props.kind,
  };
  if (!canView) {
    return <NoticePanel title={t("dashboard.noPermission")} />;
  }
  if (props.setConfig && (!isChosen(config) || props.editMode)) {
    return <CardSettings config={config} onChange={props.setConfig} />;
  }
  if (!isChosen(config)) {
    return <EmptyState icon={Rocket} title={t("dashboard.pickHint")} />;
  }
  const key = `${config.card}:${config.connectionId}:${config.uuid ?? ""}`;
  const body = {
    connectionId: config.connectionId as number,
    targetKey: key,
    active: props.active,
  };
  switch (config.card) {
    case "overview":
      return <OverviewBody key={key} {...body} />;
    case "resource":
      return <ResourceBody key={key} {...body} uuid={config.uuid as string} />;
    case "deployments":
      return <DeploymentsBody key={key} {...body} />;
    case "vulnerabilities":
      return <VulnerabilitiesBody key={key} {...body} />;
  }
}

interface BodyProps {
  connectionId: number;
  targetKey: string;
  active: boolean;
}

function useApi(): Api {
  const client = usePluginApi();
  return useMemo(() => createApi(client), [client]);
}

/** Loading, no access and error, or the card's own drawing once ready. */
function Shown<D>({
  state,
  t,
  children,
}: {
  state: CardState<D>;
  t: T;
  children: (connection: Connection, data: D) => React.ReactNode;
}) {
  switch (state.kind) {
    case "loading":
      return <LoadingState compact label={t("dashboard.loading")} />;
    case "no-access":
      return <NoticePanel title={t("dashboard.noAccess")} />;
    case "error":
      return <NoticePanel tone="destructive" title={state.message} />;
    case "ready":
      return <>{children(state.connection, state.data)}</>;
  }
}

function OverviewBody({ connectionId, targetKey, active }: BodyProps) {
  const { t } = useTranslation();
  const api = useApi();
  const { state } = useCardRead(
    api,
    targetKey,
    connectionId,
    (c, refresh) => api.connectionOverview(c.id, { refresh }),
    CARD_POLL_MS.overview,
    active,
  );
  return (
    <Shown state={state} t={t}>
      {(_c, data) =>
        data.total === 0 ? (
          <EmptyState icon={Rocket} title={t("dashboard.overview.empty")} />
        ) : (
          <div className="flex flex-col">
            <TileWall gridClassName="grid-cols-2">
              {RESOURCE_HEALTHS.map((health) => (
                <StatTile
                  key={health}
                  label={t(`overview.tiles.${health}`)}
                  value={data.counts[health]}
                  tone={
                    health === "degraded" && data.counts.degraded > 0
                      ? "warn"
                      : "default"
                  }
                />
              ))}
            </TileWall>
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {data.servers
                ? t("dashboard.overview.servers", {
                    total: data.servers.total,
                    unreachable: data.servers.unreachable,
                  })
                : t("dashboard.overview.noServers")}
            </p>
          </div>
        )
      }
    </Shown>
  );
}

function ResourceBody({
  connectionId,
  targetKey,
  active,
  uuid,
}: BodyProps & { uuid: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const mayOperate = usePermission("operate");
  const { state, reload } = useCardRead(
    api,
    targetKey,
    connectionId,
    async (c, refresh) =>
      (await api.listResources(c.id, { refresh })).rows.find(
        (r) => r.uuid === uuid,
      ) ?? null,
    CARD_POLL_MS.resource,
    active,
  );
  return (
    <Shown state={state} t={t}>
      {(connection, resource) =>
        resource ? (
          <PanelList>
            <ListRow
              title={resource.name}
              meta={[kindLabel(t, resource.kind), resource.serverName]
                .filter(Boolean)
                .join(" · ")}
              badges={
                <StatusBadge
                  tone={HEALTH_TONE[resourceHealth(resource.status)]}
                >
                  {healthLabel(t, resource.status)}
                </StatusBadge>
              }
              trailing={
                // The resource detail's rule: coolify.operate and an owner,
                // operate or configure grant. A Part deploys with its service.
                mayOperate &&
                OPERATE_ACCESS.has(connection.access) &&
                !isPart(resource) ? (
                  <DeployButton
                    connection={connection}
                    resource={resource}
                    onChanged={() => void reload(true)}
                  />
                ) : undefined
              }
            />
          </PanelList>
        ) : (
          <EmptyState icon={Rocket} title={t("dashboard.resource.gone")} />
        )
      }
    </Shown>
  );
}

/**
 * Deploy, with the same confirm as the terminal companion. The confirm is
 * keyed by connection, resource and revision, and the card body by its
 * target: a yes given after the card moved on, or closed, deploys nothing.
 */
function DeployButton({
  connection,
  resource,
  onChanged,
}: {
  connection: Connection;
  resource: Resource;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const target = `${connection.id}:${resource.uuid}:${connection.revision}`;
  const { confirm } = useConfirmFor(target);
  const lifecycle = useLifecycle(connection.id, onChanged, target);
  async function deploy() {
    const ok = await confirm({
      title: t("dashboard.resource.deployConfirm.title", {
        name: resource.name,
      }),
      description: t("dashboard.resource.deployConfirm.description"),
      confirmLabel: t("dashboard.resource.deployConfirm.confirm"),
      destructive: false,
    });
    if (!ok) return;
    await lifecycle.run(resource, "deploy");
  }
  return (
    <Button
      size="sm"
      disabled={lifecycle.busy !== null}
      onClick={() => void deploy()}
    >
      <Rocket className="size-3.5" />
      {t("dashboard.resource.deploy")}
    </Button>
  );
}

function DeploymentsBody({ connectionId, targetKey, active }: BodyProps) {
  const { t } = useTranslation();
  const api = useApi();
  const { state } = useCardRead(
    api,
    targetKey,
    connectionId,
    (c, refresh) => api.deploymentQueue(c.id, { refresh }),
    CARD_POLL_MS.deployments,
    active,
  );
  return (
    <Shown state={state} t={t}>
      {(_c, queue) =>
        queue.running.length ? (
          <QueueList rows={queue.running} />
        ) : (
          <EmptyState icon={Rocket} title={t("dashboard.deployments.empty")} />
        )
      }
    </Shown>
  );
}

function VulnerabilitiesBody({ connectionId, targetKey, active }: BodyProps) {
  const { t } = useTranslation();
  const api = useApi();
  const { state } = useCardRead(
    api,
    targetKey,
    connectionId,
    (c, refresh) => api.vulnerabilitySummary(c.id, { refresh }),
    CARD_POLL_MS.vulnerabilities,
    active,
  );
  return (
    <Shown state={state} t={t}>
      {(connection, data) => (
        <div className="flex flex-col">
          <VulnerabilityCounts data={data} t={t} />
          <div className="px-3 py-2">
            {/* The connection's own address: Coolify shows the scan details. */}
            <a
              href={connection.baseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs underline"
            >
              {t("dashboard.vulnerabilities.open")}
            </a>
          </div>
        </div>
      )}
    </Shown>
  );
}

/**
 * What the counts say. Only completed scans count as scanned: a resource
 * Coolify hasn't checked yet (or needs to check again) is said to be
 * unscanned, never clean. The check mark is for every resource scanned and
 * none with known vulnerabilities; with nothing scanned there is no clean
 * state at all.
 */
function VulnerabilityCounts({
  data,
  t,
}: {
  data: VulnerabilitySummary;
  t: T;
}) {
  const { statuses } = data;
  const unscanned = statuses.checkNeeded + statuses.notChecked;
  const scanned = statuses.ok + data.affected;
  const lines = [
    scanned > 0 && t("dashboard.vulnerabilities.scanned", { count: scanned }),
    unscanned > 0 &&
      t("dashboard.vulnerabilities.unscanned", { count: unscanned }),
  ].filter((line): line is string => typeof line === "string");
  if (data.affected > 0) {
    return (
      <TileWall gridClassName="grid-cols-1">
        <StatTile
          label={t("dashboard.vulnerabilities.affected")}
          value={data.affected}
          tone={data.problems.critical > 0 ? "bad" : "warn"}
          hint={t("dashboard.vulnerabilities.severity", {
            critical: data.problems.critical,
            high: data.problems.high,
          })}
        >
          {unscanned > 0 && <span className="text-xs">{lines.at(-1)}</span>}
        </StatTile>
      </TileWall>
    );
  }
  let icon = ShieldCheck;
  if (scanned === 0) icon = ShieldQuestion;
  else if (unscanned > 0) icon = Shield;
  return (
    <>
      <EmptyState
        icon={icon}
        title={t(
          scanned === 0
            ? "dashboard.vulnerabilities.noneScanned"
            : "dashboard.vulnerabilities.empty",
        )}
      />
      <p className="px-3 text-center text-xs text-muted-foreground">
        {lines.join(" · ")}
      </p>
    </>
  );
}

/**
 * Picks the card's connection, and for the resource card one of that
 * connection's resources (Parts left out: they deploy with their service).
 * Each list keeps only its newest answer.
 */
export function CardSettings({
  config,
  onChange,
}: {
  config: CardConfig;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.listConnections().then(
      (list) => live && setConnections(list),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const save = (next: Partial<CardConfig>) =>
    onChange({ ...config, ...next, card: config.card });

  let list;
  if (failed) {
    list = (
      <NoticePanel tone="destructive" title={t("dashboard.settings.failed")} />
    );
  } else if (!connections) {
    list = <LoadingState compact label={t("dashboard.loading")} />;
  } else if (!connections.length) {
    list = <EmptyState icon={Rocket} title={t("dashboard.settings.none")} />;
  } else {
    list = (
      <PanelList>
        {connections.map((c, i) => (
          <ListRow
            key={c.id}
            stripe={i}
            title={c.name}
            meta={c.teamName ?? undefined}
            selected={c.id === config.connectionId}
            onClick={() =>
              save({
                connectionId: c.id,
                uuid: c.id === config.connectionId ? config.uuid : null,
              })
            }
          />
        ))}
      </PanelList>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="px-3 pt-2 text-xs text-muted-foreground">
        {t("dashboard.settings.connection")}
      </p>
      {list}
      {config.card === "resource" && config.connectionId !== null && (
        <ResourcePicker
          key={config.connectionId}
          api={api}
          connectionId={config.connectionId}
          selected={config.uuid}
          onPick={(uuid) => save({ uuid })}
        />
      )}
    </div>
  );
}

function ResourcePicker({
  api,
  connectionId,
  selected,
  onPick,
}: {
  api: Api;
  connectionId: number;
  selected: string | null;
  onPick: (uuid: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Resource[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reads = useRef(0);
  useEffect(() => {
    const mine = ++reads.current;
    api.listResources(connectionId).then(
      (list) => mine === reads.current && setRows(list.rows),
      () => mine === reads.current && setFailed(true),
    );
    return () => {
      reads.current += 1;
    };
  }, [api, connectionId]);

  let list;
  if (failed) {
    list = (
      <NoticePanel tone="destructive" title={t("dashboard.settings.failed")} />
    );
  } else if (!rows) {
    list = <LoadingState compact label={t("dashboard.loading")} />;
  } else {
    const shown = rows.filter((r) => !isPart(r));
    list = shown.length ? (
      <PanelList>
        {shown.map((r, i) => (
          <ListRow
            key={r.uuid}
            stripe={i}
            title={r.name}
            meta={kindLabel(t, r.kind)}
            selected={r.uuid === selected}
            onClick={() => onPick(r.uuid)}
          />
        ))}
      </PanelList>
    ) : (
      <EmptyState icon={Rocket} title={t("dashboard.settings.noResources")} />
    );
  }
  return (
    <>
      <p className="px-3 pt-2 text-xs text-muted-foreground">
        {t("dashboard.settings.resource")}
      </p>
      {list}
    </>
  );
}
