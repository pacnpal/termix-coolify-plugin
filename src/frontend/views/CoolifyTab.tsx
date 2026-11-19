import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, LayoutDashboard, Plug, Rocket } from "lucide-react";
import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  LoadingState,
  NoticePanel,
  PanelFrame,
  SideNav,
  ToolbarSelect,
  type SideNavEntry,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Connection } from "../api";
import type { ResourceHealth } from "../../shared/resource-health";
import { ConnectionsView } from "./ConnectionsView";
import { OverviewView } from "./OverviewView";
import { ResourceDetail } from "./ResourceDetail";
import { ResourcesView } from "./ResourcesView";
import type { HealthFilter } from "./resource-model";
import { useResources } from "./useResources";

/** The sections, in SideNav order. Servers (host sync) adds its own here. */
export type Section = "overview" | "resources" | "connections";

/**
 * The Coolify tab: a SideNav of sections over one selected connection. With
 * no connection yet it opens on Connections. On a phone the SideNav becomes a
 * select above the section.
 */
export function CoolifyTab(_props: TabProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
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

  let body;
  if (section === null) {
    body = <LoadingState label={t("connections.loading")} />;
  } else if (section === "connections") {
    body = <ConnectionsView onSaved={saved} />;
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
