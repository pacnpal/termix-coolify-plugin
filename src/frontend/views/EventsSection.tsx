import { useState, type ReactNode } from "react";
import { History, TriangleAlert } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
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
  ToolbarSelect,
} from "@termix-ssh/plugin-sdk/ui";
import type { Api, EventRow, Resource } from "../api";
import { formatTime } from "./resource-model";
import { EVENT_KIND_IDS, useEventLog } from "./useEventLog";

type T = (key: string, options?: Record<string, unknown>) => string;

/** What a row opens: its deployment's build log, its resource or its server. */
export type EventSubject =
  | { open: "deployment"; resourceUuid: string; deploymentUuid: string }
  | { open: "resource"; uuid: string }
  | { open: "server"; uuid: string };

/** A select's "everything" value; ToolbarSelect needs a string. */
const ALL = "*";

/** Server kinds name a server even when a resource uuid came along. */
const SERVER_KINDS = new Set(["server-unreachable", "high-disk"]);

/**
 * The subject a row links to, or null for a team-wide row. A deployment
 * row opens its build log only with operate (`canOpenLog`), as everywhere
 * else; otherwise it opens its resource.
 */
export function subjectOf(
  row: EventRow,
  canOpenLog: boolean,
): EventSubject | null {
  if (!SERVER_KINDS.has(row.kind) && row.resourceUuid) {
    if (canOpenLog && row.deploymentUuid) {
      return {
        open: "deployment",
        resourceUuid: row.resourceUuid,
        deploymentUuid: row.deploymentUuid,
      };
    }
    return { open: "resource", uuid: row.resourceUuid };
  }
  return row.serverUuid ? { open: "server", uuid: row.serverUuid } : null;
}

const TONE = {
  info: "none",
  warning: "warning",
  critical: "destructive",
} as const;

function kindLabel(t: T, row: EventRow): string {
  return (EVENT_KIND_IDS as readonly string[]).includes(row.kind)
    ? t(`eventLog.kinds.${row.kind}`)
    : row.title;
}

/** The subject's name, its status, when and where from, for a row's meta. */
function eventMeta(t: T, row: EventRow): string {
  return [
    row.name,
    row.status,
    formatTime(row.createdAt),
    t(`eventLog.source.${row.source}`),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The Events section: the selected connection's event log, newest first,
 * filtered by kind and by resource, a page at a time. It reads again every
 * EVENTS_POLL_MS while shown; a row opens its subject. CoolifyTab keys it by
 * connection and revision, so a changed target starts empty.
 */
export function EventsSection({
  api,
  connectionId,
  revision,
  resources,
  canOpenLog,
  isVisible,
  onOpen,
  picker,
}: {
  api: Api;
  connectionId: number;
  revision: string | null;
  /** The connection's resources, for the resource filter. */
  resources: readonly Resource[];
  canOpenLog: boolean;
  isVisible: boolean;
  onOpen: (subject: EventSubject) => void;
  picker?: ReactNode;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<string>(ALL);
  const [uuid, setUuid] = useState<string>(ALL);
  const log = useEventLog(
    api,
    connectionId,
    revision,
    { kind: kind === ALL ? null : kind, uuid: uuid === ALL ? null : uuid },
    isVisible,
  );
  const filtered = kind !== ALL || uuid !== ALL;
  const { rows, error, loading } = log;

  let body;
  if (rows === null) {
    body = error ? (
      <div className="p-4">
        <NoticePanel
          icon={TriangleAlert}
          tone="destructive"
          title={error}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void log.reload()}
            >
              {t("eventLog.retry")}
            </Button>
          }
        />
      </div>
    ) : (
      <LoadingState label={t("eventLog.loading")} />
    );
  } else if (!rows.length) {
    body = (
      <>
        {error && <NoticePanel tone="destructive" title={error} />}
        <EmptyState
          icon={History}
          title={filtered ? t("eventLog.emptyFiltered") : t("eventLog.empty")}
          hint={filtered ? undefined : t("eventLog.emptyHint")}
        />
      </>
    );
  } else {
    body = (
      <div className="flex flex-col">
        {error && <NoticePanel tone="destructive" title={error} />}
        <PanelList>
          {rows.map((row, i) => {
            const subject = subjectOf(row, canOpenLog);
            return (
              <ListRow
                key={row.id}
                data-event-id={row.id}
                stripe={i}
                tone={TONE[row.severity]}
                title={kindLabel(t, row)}
                meta={eventMeta(t, row)}
                badges={
                  row.severity === "info" ? undefined : (
                    <ListBadge
                      tone={
                        row.severity === "critical" ? "destructive" : "warning"
                      }
                    >
                      {t(`eventLog.severity.${row.severity}`)}
                    </ListBadge>
                  )
                }
                onClick={subject ? () => onOpen(subject) : undefined}
              />
            );
          })}
        </PanelList>
        {log.more && (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void log.older()}
            >
              {t("eventLog.older")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <PanelShell
      icon={<History className="size-4" />}
      title={t("eventLog.title")}
      actions={
        <>
          {picker}
          <ToolbarSelect
            value={kind}
            onChange={setKind}
            label={t("eventLog.kindFilter")}
            options={[
              { value: ALL, label: t("eventLog.allKinds") },
              ...EVENT_KIND_IDS.map((k) => ({
                value: k,
                label: t(`eventLog.kinds.${k}`),
              })),
            ]}
          />
          <ToolbarSelect
            value={uuid}
            onChange={setUuid}
            label={t("eventLog.resourceFilter")}
            options={[
              { value: ALL, label: t("eventLog.allResources") },
              ...resources
                .filter((r) => !r.parentUuid)
                .map((r) => ({ value: r.uuid, label: r.name })),
            ]}
          />
          <RefreshButton
            onClick={() => void log.reload()}
            loading={loading}
            label={t("eventLog.refresh")}
          />
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </PanelShell>
  );
}
