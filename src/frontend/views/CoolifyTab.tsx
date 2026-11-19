import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, LayoutDashboard, Plug, Rocket } from "lucide-react";
import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  LoadingState,
  PanelFrame,
  SideNav,
  ToolbarSelect,
  type SideNavEntry,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Connection, type Resource } from "../api";
import type { ResourceHealth } from "../../shared/resource-health";
import { ConnectionsView, type SyncTarget } from "./ConnectionsView";
import { OverviewView } from "./OverviewView";
import { ResourceDetail } from "./ResourceDetail";
import { ResourcesView } from "./ResourcesView";
import type { HealthFilter } from "./resource-model";
import { useResources } from "./useResources";

/** The sections, in SideNav order. Servers (host sync) adds its own here. */
export type Section = "overview" | "resources" | "connections";

/** Access levels that may start, stop, restart and deploy. */
const OPERATE_ACCESS: ReadonlySet<string> = new Set([
  "owner",
  "operate",
  "configure",
]);

/** What a pick in the Resources list does, when the palette asked. */
interface PickIntent {
  /** "shell": the picked resource opens in a coolify-shell tab. */
  open: "shell" | null;
  /** The resource view to open on, like "logs"; unknown ones fall back. */
  detailTab: string | null;
}

const NO_INTENT: PickIntent = { open: null, detailTab: null };

/** What the tab was opened for, from its data. */
interface TabTarget extends PickIntent {
  section: Section | null;
  connectionId: number | null;
  syncTarget: SyncTarget;
}

/**
 * Reads the tab's data: `{ section: "sync", connectionId? }` opens the sync
 * preview of one connection, or of the only one there is ("any", from the
 * import menu); `{ section: "resources", connectionId? }` opens that
 * connection's Resources, where `open: "shell"` makes the next pick open a
 * shell and `tab` names the view the next picked resource opens on.
 */
function targetOf(props: TabProps): TabTarget {
  const data = props.tab?.data ?? {};
  const id = Number(data.connectionId);
  const connectionId = Number.isSafeInteger(id) && id > 0 ? id : null;
  if (data.section === "sync") {
    return {
      section: "connections",
      connectionId,
      syncTarget: connectionId ?? "any",
      ...NO_INTENT,
    };
  }
  if (data.section === "resources") {
    return {
      section: "resources",
      connectionId,
      syncTarget: null,
      open: data.open === "shell" ? "shell" : null,
      detailTab: typeof data.tab === "string" ? data.tab : null,
    };
  }
  return {
    section: null,
    connectionId: null,
    syncTarget: null,
    ...NO_INTENT,
  };
}

/**
 * The Coolify tab: a SideNav of sections over one selected connection. With
 * no connection yet it opens on Connections. On a phone the SideNav becomes a
 * select above the section.
 */
export function CoolifyTab(props: TabProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const target = targetOf(props);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [section, setSection] = useState<Section | null>(target.section);
  const [selectedId, setSelectedId] = useState<number | null>(
    target.connectionId,
  );
  const [health, setHealth] = useState<HealthFilter>("all");
  const [openUuid, setOpenUuid] = useState<string | null>(null);
  const [intent, setIntent] = useState<PickIntent>({
    open: target.open,
    detailTab: target.detailTab,
  });
  const canOperate = usePermission("operate");

  const loadConnections = useCallback(async () => {
    let list: Connection[] = [];
    try {
      const answer = await api.listConnections();
      list = Array.isArray(answer) ? answer : [];
    } catch {
      // The Connections section shows the failure; other sections stay empty.
    }
    setConnections(list);
    setSection((prev) => prev ?? (list.length ? "overview" : "connections"));
  }, [api]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const connection =
    connections?.find((c) => c.id === selectedId) ?? connections?.[0] ?? null;
  const resources = useResources(api, connection?.id ?? null);

  function select(next: string) {
    setSection(next as Section);
    setOpenUuid(null);
    setIntent(NO_INTENT);
    // Pick up connections added or removed in the Connections section.
    if (next !== "connections") void loadConnections();
  }

  const entries: SideNavEntry[] = [
    { id: "overview", label: t("nav.overview"), icon: LayoutDashboard },
    { id: "resources", label: t("nav.resources"), icon: Boxes },
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

  const rows = resources.list?.rows ?? [];

  function openShell(resource: Resource, console: "shell" | "db") {
    if (!connection) return;
    props.shell.openTab(null, "coolify-shell", {
      label:
        console === "db"
          ? t("shellTab.consoleLabel", { name: resource.name })
          : t("shellTab.shellLabel", { name: resource.name }),
      forceNewTab: true,
      data: { connectionId: connection.id, uuid: resource.uuid, console },
    });
  }

  /** A pick in the Resources list: a shell once when asked, else the detail. */
  function pick(uuid: string) {
    const resource = rows.find((r) => r.uuid === uuid);
    if (intent.open === "shell" && canOperate && resource) {
      setIntent({ ...intent, open: null });
      openShell(resource, "shell");
      return;
    }
    setOpenUuid(uuid);
  }

  let body;
  if (section === "connections") {
    body = <ConnectionsView syncTarget={target.syncTarget} />;
  } else if (section === null || connections === null) {
    body = <LoadingState label={t("connections.loading")} />;
  } else if (!connection) {
    body = (
      <EmptyState
        icon={Rocket}
        title={t("tab.noConnection.title")}
        hint={t("tab.noConnection.hint")}
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
        onOpen={pick}
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
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
          canOperate={canOperate && OPERATE_ACCESS.has(connection.access)}
          onChanged={() => void resources.reload(true)}
          onShell={openShell}
          initialTab={intent.detailTab}
        />
      )}
    </PanelFrame>
  );
}
