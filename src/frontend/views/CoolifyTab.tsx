import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Boxes,
  Braces,
  LayoutDashboard,
  Plug,
  Rocket,
  Server,
} from "lucide-react";
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
import { createApi, type Api, type Connection, type Resource } from "../api";
import type { ResourceHealth } from "../../shared/resource-health";
import { ApiConsoleView } from "./ApiConsoleView";
import { ConnectionsView, syncable } from "./ConnectionsView";
import { OverviewView } from "./OverviewView";
import { ResourceDetail } from "./ResourceDetail";
import { ResourcesView } from "./ResourcesView";
import { SyncView } from "./SyncView";
import type { HealthFilter } from "./resource-model";
import { useResources } from "./useResources";

/**
 * The sections, in SideNav order. Servers is host sync for one connection;
 * the API console picks its own connection.
 */
export type Section =
  "overview" | "resources" | "servers" | "connections" | "api";

const SECTIONS: readonly string[] = [
  "overview",
  "resources",
  "servers",
  "connections",
  "api",
];

/** What a pick in the Resources list does, when the palette asked. */
interface PickIntent {
  /** "shell": the next picked resource opens in a coolify-shell tab. */
  open: "shell" | null;
  /** The resource view to open on, like "logs"; unknown ones fall back. */
  detailTab: string | null;
}

const NO_INTENT: PickIntent = { open: null, detailTab: null };

/** What the tab was opened for, from its data. */
interface OpenRequest extends PickIntent {
  section: Section;
  /** A connection id, or null for the first syncable one (the import menu). */
  connectionId: number | null;
  /** On Resources: one Coolify server's resources only (a Linked host). */
  serverUuid: string | null;
}

const SERVER_UUID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Reads the tab's data. "sync" (from a Linked host, the import menu or the
 * palette) opens the Servers section, where host sync lives. On Resources,
 * `open: "shell"` makes the next pick open a shell and `tab` names the view
 * the next picked resource opens on (the palette's Open shell and Logs).
 * `serverUuid` with a connection (a Linked host's Coolify action or menu)
 * filters Resources to that server until the filter is cleared.
 */
function requestOf(
  data: Record<string, unknown> | undefined,
): OpenRequest | null {
  const raw = data?.section === "sync" ? "servers" : data?.section;
  if (typeof raw !== "string" || !SECTIONS.includes(raw)) return null;
  const id = Number(data?.connectionId);
  const connectionId = Number.isSafeInteger(id) && id > 0 ? id : null;
  const server = data?.serverUuid;
  return {
    section: raw as Section,
    connectionId,
    serverUuid:
      raw === "resources" &&
      connectionId !== null &&
      typeof server === "string" &&
      SERVER_UUID.test(server)
        ? server
        : null,
    open: raw === "resources" && data?.open === "shell" ? "shell" : null,
    detailTab:
      raw === "resources" && typeof data?.tab === "string" ? data.tab : null,
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

/** Access levels that may start, stop, restart and deploy. */
export const OPERATE_ACCESS: ReadonlySet<string> = new Set([
  "owner",
  "operate",
  "configure",
]);

/**
 * The Coolify tab: a SideNav of sections over one selected connection. With
 * no connection yet it opens on Connections. On a phone the SideNav becomes a
 * select above the section.
 */
export function CoolifyTab({ tab, shell, isVisible }: TabProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const canConfigure = usePermission("configure");
  const canOperate = usePermission("operate");
  const api = useMemo(() => createApi(client), [client]);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [health, setHealth] = useState<HealthFilter>("all");
  const [server, setServer] = useState<string | null>(null);
  const [openUuid, setOpenUuid] = useState<string | null>(null);
  const [intent, setIntent] = useState<PickIntent>(NO_INTENT);

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
  // Each opening hands the tab a new data object, so the request is tracked
  // by that object: the same action again, after the user moved on, applies
  // again even with the same section and connection.
  const data = tab?.data;
  // A request naming no connection (the import menu) waits for the list.
  const pickFirst = useRef(false);
  useEffect(() => {
    const asked = requestOf(data);
    if (!asked) return;
    setSection(asked.section);
    setOpenUuid(null);
    setIntent({ open: asked.open, detailTab: asked.detailTab });
    setServer(asked.serverUuid);
    if (asked.connectionId !== null) setSelectedId(asked.connectionId);
    pickFirst.current =
      asked.section === "servers" && asked.connectionId === null;
  }, [data]);

  // "Import from Coolify" names no connection: take the first syncable one,
  // once per request, so a later pick in the header sticks.
  useEffect(() => {
    if (!pickFirst.current || !connections) return;
    pickFirst.current = false;
    const first = connections.find(syncable);
    if (first) setSelectedId(first.id);
  }, [data, connections]);

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
    setIntent(NO_INTENT);
    // Pick up connections added or removed in the Connections section.
    if (next !== "connections") void loadConnections();
  }

  /** Sync servers on a connection's row opens Servers on that connection. */
  const syncFrom = useCallback(
    (c: Connection) => {
      setSelectedId(c.id);
      setOpenUuid(null);
      setServer(null);
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
    { id: "api", label: t("apiConsole.title"), icon: Braces },
  ];

  const picker =
    connections && connections.length > 1 && connection ? (
      <ToolbarSelect
        value={String(connection.id)}
        onChange={(id) => {
          setSelectedId(Number(id));
          setOpenUuid(null);
          // A server belongs to one connection.
          setServer(null);
        }}
        options={connections.map((c) => ({
          value: String(c.id),
          label: c.name,
        }))}
        label={t("picker.label")}
      />
    ) : null;

  const rows = resources.list?.rows ?? [];
  // The same rule as the detail view's Shell button.
  const mayOperate =
    canOperate && !!connection && OPERATE_ACCESS.has(connection.access);

  function openShell(resource: Resource, console: "shell" | "db") {
    if (!connection) return;
    shell.openTab(null, "coolify-shell", {
      label:
        console === "db"
          ? t("shellTab.consoleLabel", { name: resource.name })
          : t("shellTab.shellLabel", { name: resource.name }),
      forceNewTab: true,
      data: {
        connectionId: connection.id,
        uuid: resource.uuid,
        console,
        // The target it was opened for: a new one asks for containers again.
        ...(connection.revision ? { revision: connection.revision } : {}),
      },
    });
  }

  /** A pick in the Resources list: a shell once when asked, else the detail. */
  function pick(uuid: string) {
    const resource = rows.find((r) => r.uuid === uuid);
    if (intent.open === "shell" && mayOperate && resource) {
      setIntent({ ...intent, open: null });
      openShell(resource, "shell");
      return;
    }
    setOpenUuid(uuid);
  }

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
  } else if (section === "api") {
    body = <ApiConsoleView />;
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
          // The Overview counts every server, so its list shows them all.
          setHealth(h);
          setServer(null);
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
        onOpen={pick}
        server={server}
        onClearServer={() => setServer(null)}
      />
    );
  }

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
      {openUuid !== null && section === "resources" && connection && (
        <ResourceDetail
          resource={rows.find((r) => r.uuid === openUuid) ?? null}
          rows={rows}
          onOpen={setOpenUuid}
          onClose={() => {
            setOpenUuid(null);
            setIntent(NO_INTENT);
          }}
          connectionId={connection.id}
          revision={connection.revision ?? null}
          canOperate={canOperate && OPERATE_ACCESS.has(connection.access)}
          onChanged={() => void resources.reload(true)}
          isVisible={isVisible}
          onShell={openShell}
          initialTab={intent.detailTab}
        />
      )}
    </PanelFrame>
  );
}
