import { useMemo, useState, type ReactNode } from "react";
import { Boxes, CornerDownRight, Server, X } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  DataTable,
  DataTableRow,
  EmptyState,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  PanelSearch,
  PanelShell,
  RefreshButton,
  Segmented,
  StatusBadge,
  ToolbarBand,
  useIsMobile,
} from "@termix-ssh/plugin-sdk/ui";
import type { Resource } from "../api";
import {
  countResources,
  RESOURCE_HEALTHS,
  resourceHealth,
} from "../../shared/resource-health";
import {
  filterGroups,
  formatTime,
  groupResources,
  HEALTH_TONE,
  healthLabel,
  kindLabel,
  placeLabel,
  serverLabel,
  type HealthFilter,
  type KindFilter,
} from "./resource-model";
import type { ResourcesState } from "./useResources";

type T = (key: string, options?: Record<string, unknown>) => string;

function Status({ t, r }: { t: T; r: Resource }) {
  return (
    <span title={r.status}>
      <StatusBadge tone={HEALTH_TONE[resourceHealth(r.status)]}>
        {healthLabel(t, r.status)}
      </StatusBadge>
    </span>
  );
}

function Domains({ r }: { r: Resource }) {
  if (!r.fqdns.length) return null;
  return (
    <span className="flex flex-col">
      {r.fqdns.map((d) => (
        <span key={d} className="truncate">
          {d}
        </span>
      ))}
    </span>
  );
}

function TableRow({
  t,
  r,
  part,
  onOpen,
}: {
  t: T;
  r: Resource;
  part: boolean;
  onOpen: (uuid: string) => void;
}) {
  return (
    <DataTableRow
      data-name={r.name}
      data-parent={r.parentUuid ?? undefined}
      onClick={() => onOpen(r.uuid)}
      className="text-xs"
    >
      <td className="px-3 py-1.5">
        <span
          className={
            part
              ? "flex items-center gap-1.5 pl-4 text-muted-foreground"
              : "font-medium"
          }
        >
          {part && <CornerDownRight className="size-3 shrink-0" />}
          {r.name}
        </span>
      </td>
      <td className="px-3 py-1.5 text-muted-foreground">
        {kindLabel(t, r.kind)}
      </td>
      <td className="px-3 py-1.5">
        <Status t={t} r={r} />
      </td>
      <td className="px-3 py-1.5">{serverLabel(r)}</td>
      <td className="px-3 py-1.5">{placeLabel(t, r)}</td>
      <td className="max-w-64 px-3 py-1.5">
        <Domains r={r} />
      </td>
      <td className="px-3 py-1.5 text-muted-foreground">
        {formatTime(r.lastDeployAt)}
      </td>
    </DataTableRow>
  );
}

function PhoneRow({
  t,
  r,
  part,
  stripe,
  onOpen,
}: {
  t: T;
  r: Resource;
  part: boolean;
  stripe: number;
  onOpen: (uuid: string) => void;
}) {
  const meta = [
    kindLabel(t, r.kind),
    serverLabel(r),
    placeLabel(t, r),
    r.fqdns[0],
    formatTime(r.lastDeployAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ListRow
      data-name={r.name}
      stripe={stripe}
      title={r.name}
      meta={meta}
      tone={
        HEALTH_TONE[resourceHealth(r.status)] === "warn" ? "warning" : "none"
      }
      leading={part ? <CornerDownRight className="size-3" /> : undefined}
      badges={<Status t={t} r={r} />}
      onClick={() => onOpen(r.uuid)}
      className={part ? "pl-4" : undefined}
    />
  );
}

/**
 * The Resources section: every application, service and database of the
 * connection, each service followed by its Parts, with search and filters.
 * A phone gets a list instead of the table. `server` (from a Linked host's
 * Coolify action) keeps one server's resources until cleared.
 */
export function ResourcesView({
  resources,
  picker,
  health,
  onHealth,
  onOpen,
  server = null,
  onClearServer,
}: {
  resources: ResourcesState;
  picker?: ReactNode;
  health: HealthFilter;
  onHealth: (next: HealthFilter) => void;
  onOpen: (uuid: string) => void;
  server?: string | null;
  onClearServer?: () => void;
}) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const { list, loading, error, reload } = resources;
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");

  const groups = useMemo(() => groupResources(list?.rows ?? []), [list]);
  const visible = useMemo(
    () => filterGroups(groups, { search, kind, health, server }),
    [groups, search, kind, health, server],
  );
  const serverName =
    list?.rows.find((r) => r.serverUuid === server && r.serverName)
      ?.serverName ?? server;
  // The health counts follow the server filter, so they match the list.
  const counts = useMemo(
    () =>
      countResources(
        (list?.rows ?? []).filter((r) => !server || r.serverUuid === server),
      ),
    [list, server],
  );
  const rows = visible.flatMap((g) => [
    { r: g.resource, part: false },
    ...g.parts.map((p) => ({ r: p, part: true })),
  ]);

  const kinds: { value: KindFilter; label: string }[] = [
    { value: "all", label: t("resources.filters.allKinds") },
    { value: "application", label: t("resources.filters.applications") },
    { value: "service", label: t("resources.filters.services") },
    { value: "database", label: t("resources.filters.databases") },
  ];
  const healths: { value: HealthFilter; label: string; count?: number }[] = [
    { value: "all", label: t("resources.filters.allHealth") },
    ...RESOURCE_HEALTHS.map((h) => ({
      value: h,
      label: t(`resources.health.${h}`),
      count: counts[h],
    })),
  ];

  let body: ReactNode;
  if (list === null) {
    body = error ? null : <LoadingState label={t("resources.loading")} />;
  } else if (!groups.length) {
    body = (
      <EmptyState
        icon={Boxes}
        title={t("resources.empty.title")}
        hint={t("resources.empty.hint")}
      />
    );
  } else if (!rows.length) {
    body = (
      <EmptyState
        icon={Boxes}
        title={t("resources.noMatch.title")}
        hint={t("resources.noMatch.hint")}
      />
    );
  } else if (mobile) {
    body = (
      <PanelList>
        {rows.map(({ r, part }, i) => (
          <PhoneRow
            key={r.uuid}
            t={t}
            r={r}
            part={part}
            stripe={i}
            onOpen={onOpen}
          />
        ))}
      </PanelList>
    );
  } else {
    body = (
      <DataTable containerClassName="flex-1">
        <thead>
          <tr className="text-left text-[11px] text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">
              {t("resources.columns.name")}
            </th>
            <th className="px-3 py-1.5 font-medium">
              {t("resources.columns.type")}
            </th>
            <th className="px-3 py-1.5 font-medium">
              {t("resources.columns.status")}
            </th>
            <th className="px-3 py-1.5 font-medium">
              {t("resources.columns.server")}
            </th>
            <th className="px-3 py-1.5 font-medium">
              {t("resources.columns.place")}
            </th>
            <th className="px-3 py-1.5 font-medium">
              {t("resources.columns.domains")}
            </th>
            <th className="px-3 py-1.5 font-medium">
              {t("resources.columns.lastDeploy")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, part }) => (
            <TableRow key={r.uuid} t={t} r={r} part={part} onOpen={onOpen} />
          ))}
        </tbody>
      </DataTable>
    );
  }

  return (
    <PanelShell
      icon={<Boxes className="size-4" />}
      title={t("resources.title")}
      scroll={false}
      actions={
        <>
          {picker}
          <RefreshButton
            onClick={() => void reload(true)}
            loading={loading}
            label={t("resources.refresh")}
          />
        </>
      }
      toolbar={
        <PanelSearch
          value={search}
          onChange={setSearch}
          placeholder={t("resources.search")}
          fill
        />
      }
    >
      <ToolbarBand>
        {server && (
          <span className="flex items-center gap-1 text-xs">
            <Server className="size-3.5 shrink-0" />
            {t("resources.serverFilter.label", { server: serverName })}
            {onClearServer && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("resources.serverFilter.clear")}
                title={t("resources.serverFilter.clear")}
                onClick={onClearServer}
              >
                <X className="size-3" />
              </Button>
            )}
          </span>
        )}
        <Segmented<KindFilter>
          value={kind}
          onChange={setKind}
          options={kinds}
        />
        <Segmented<HealthFilter>
          value={health}
          onChange={onHealth}
          options={healths}
        />
      </ToolbarBand>
      {error && <NoticePanel tone="destructive" title={error} />}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{body}</div>
    </PanelShell>
  );
}
