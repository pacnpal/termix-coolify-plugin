import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Boxes, LayoutDashboard, Plug, Rocket, Server } from "lucide-react";
import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  LoadingState,
  NoticePanel,
  PanelFrame,
  PanelShell,
  SideNav,
  ToolbarSelect,
  type SideNavEntry,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Api, type Connection } from "../api";
import type { ResourceHealth } from "../../shared/resource-health";
import { ConnectionsView, syncable } from "./ConnectionsView";
import { OverviewView } from "./OverviewView";
import { ResourceDetail } from "./ResourceDetail";
import { ResourcesView } from "./ResourcesView";
import { SyncView } from "./SyncView";
import type { HealthFilter } from "./resource-model";
import { useResources } from "./useResources";

/** The sections, in SideNav order. Servers is host sync for one connection. */
export type Section = "overview" | "resources" | "servers" | "connections";

const SECTIONS: readonly string[] = [
  "overview",
  "resources",
  "servers",
  "connections",
];

/** What the tab was opened for, from its data. */
interface OpenRequest {
  section: Section;
  /** A connection id, or null for the first syncable one (the import menu). */
  connectionId: number | null;
}

/**
 * Reads the tab's data. "sync" (from a Linked host or the import menu) opens
 * the Servers section, where host sync lives.
 */
function requestOf(
  data: Record<string, unknown> | undefined,
): OpenRequest | null {
  const raw = data?.section === "sync" ? "servers" : data?.section;
  if (typeof raw !== "string" || !SECTIONS.includes(raw)) return null;
  const id = Number(data?.connectionId);
  return {
    section: raw as Section,
    connectionId: Number.isSafeInteger(id) && id > 0 ? id : null,
  };
}

/**
 * The Servers section: host sync for the selected connection. Only the
 * connection's owner can sync it, and a scoped token can't read servers.
 */
function ServersSection({
  api,
  connection,
  canConfigure,
  picker,
}: {
  api: Api;
  connection: Connection;
  canConfigure: boolean;
  picker: ReactNode;
}) {
  const { t } = useTranslation();
  if (canConfigure && syncable(connection)) {
    // Keyed so a different connection starts with fresh choices.
    return (
      <SyncView
        key={connection.id}
        api={api}
        connection={connection}
        actions={picker}
      />
    );
  }
  let reason = t("sync.notOwner");
  if (!canConfigure) reason = t("sync.needsConfigure");
  else if (connection.scoped) reason = t("sync.scopedToken");
  return (
    <PanelShell
      icon={<Server className="size-4" />}
      title={t("nav.servers")}
      actions={picker}
    >
      <NoticePanel title={reason} />
    </PanelShell>
  );
}

/**
 * The Coolify tab: a SideNav of sections over one selected connection. With
 * no connection yet it opens on Connections. On a phone the SideNav becomes a
 * select above the section.
 */
export function CoolifyTab({ tab }: TabProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const canConfigure = usePermission("configure");
  const api = useMemo(() => createApi(client), [client]);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [health, setHealth] = useState<HealthFilter>("all");
  const [openUuid, setOpenUuid] = useState<string | null>(null);

  const [loadFailed, setLoadFailed] = useState(false);

  /** A failed reload keeps the list it had and says so; an empty answer is kept. */
  const loadConnections = useCallback(async () => {
    try {
      const answer = await api.listConnections();
      const list = Array.isArray(answer) ? answer : [];
      setConnections(list);
      setLoadFailed(false);
      setSection((prev) => prev ?? (list.length ? "overview" : "connections"));
    } catch {
      setLoadFailed(true);
      setSection((prev) => prev ?? "connections");
    }
  }, [api]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // A Linked host or the import menu asks for a section and a connection.
  // Reopening the singleton tab with new data asks again.
  const asked = requestOf(tab?.data);
  const askedSection = asked?.section ?? null;
  const askedId = asked?.connectionId ?? null;
  useEffect(() => {
    if (askedSection === null) return;
    setSection(askedSection);
    setOpenUuid(null);
    if (askedId !== null) setSelectedId(askedId);
  }, [askedSection, askedId]);

  // "Import from Coolify" names no connection: take the first syncable one.
  useEffect(() => {
    if (askedSection !== "servers" || askedId !== null || !connections) return;
    const first = connections.find(syncable);
    if (first) setSelectedId(first.id);
  }, [askedSection, askedId, connections]);

  const connection =
    connections?.find((c) => c.id === selectedId) ?? connections?.[0] ?? null;
  // Keyed by the revision too, so a changed address or token reloads.
  const resources = useResources(
    api,
    connection?.id ?? null,
    connection?.revision ?? null,
  );

  /** A saved connection replaces its row; a new target reloads resources. */
  const saved = useCallback((next: Connection) => {
    setConnections((prev) =>
      prev?.some((c) => c.id === next.id)
        ? prev.map((c) => (c.id === next.id ? next : c))
        : [...(prev ?? []), next],
    );
  }, []);

  function select(next: string) {
    setSection(next as Section);
    setOpenUuid(null);
    // Pick up connections added or removed in the Connections section.
    if (next !== "connections") void loadConnections();
  }

  /** Sync servers on a connection's row opens Servers on that connection. */
  const syncFrom = useCallback(
    (c: Connection) => {
      setSelectedId(c.id);
      setOpenUuid(null);
      setSection("servers");
      void loadConnections();
    },
    [loadConnections],
  );

  // Host sync writes hosts, so only configure sees the Servers section.
  const entries: SideNavEntry[] = [
    { id: "overview", label: t("nav.overview"), icon: LayoutDashboard },
    { id: "resources", label: t("nav.resources"), icon: Boxes },
    ...(canConfigure
      ? [{ id: "servers", label: t("nav.servers"), icon: Server }]
      : []),
    { id: "connections", label: t("nav.connections"), icon: Plug },
  ];

  const picker =
    connections && connections.length > 1 && connection ? (
      <ToolbarSelect
        value={String(connection.id)}
        onChange={(id) => {
          setSelectedId(Number(id));
          setOpenUuid(null);
        }}
        options={connections.map((c) => ({
          value: String(c.id),
          label: c.name,
        }))}
        label={t("picker.label")}
      />
    ) : null;

  let body;
  if (section === null) {
    body = <LoadingState label={t("connections.loading")} />;
  } else if (section === "connections") {
    body = (
      <ConnectionsView
        onSaved={saved}
        onSync={canConfigure ? syncFrom : undefined}
      />
    );
  } else if (!connection) {
    body = (
      <EmptyState
        icon={Rocket}
        title={t("tab.noConnection.title")}
        hint={
          section === "servers"
            ? t("sync.noConnections")
            : t("tab.noConnection.hint")
        }
      />
    );
  } else if (section === "servers") {
    body = (
      <ServersSection
        api={api}
        connection={connection}
        canConfigure={canConfigure}
        picker={picker}
      />
    );
  } else if (section === "overview") {
    body = (
      <OverviewView
        resources={resources}
        picker={picker}
        onShowResources={(h: ResourceHealth) => {
          setHealth(h);
          setSection("resources");
        }}
      />
    );
  } else {
    body = (
      <ResourcesView
        resources={resources}
        picker={picker}
        health={health}
        onHealth={setHealth}
        onOpen={setOpenUuid}
      />
    );
  }

  const rows = resources.list?.rows ?? [];
  return (
    <PanelFrame>
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        {section !== null && (
          <SideNav
            entries={entries}
            active={section}
            onSelect={select}
            label={t("nav.label")}
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {loadFailed && section !== "connections" && (
            <NoticePanel
              tone="destructive"
              title={t("connections.loadFailed")}
            />
          )}
          {body}
        </div>
      </div>
      {openUuid !== null && section === "resources" && (
        <ResourceDetail
          resource={rows.find((r) => r.uuid === openUuid) ?? null}
          rows={rows}
          onOpen={setOpenUuid}
          onClose={() => setOpenUuid(null)}
        />
      )}
    </PanelFrame>
  );
}
