import { useEffect, useMemo, useState } from "react";
import { Network } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  GroupHeading,
  LoadingState,
  NoticePanel,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Resource, type TunnelAnswer } from "../api";
import { useCompanions } from "../companions";
import { linkOf } from "../linked";
import { ForwardControl } from "./ContainerCompanions";
import { OPERATE_ACCESS } from "./CoolifyTab";

interface Section {
  connectionId: number;
  /** The connection's target: a changed one starts each forward anew. */
  revision: string;
  name: string;
  rows: Resource[];
}

/**
 * The Coolify view inside the Tunnels tab (extension point tunnels.views):
 * each resource with a port to forward through its Linked host, listening on
 * the Termix server. On a host's Tunnels tab, only that Coolify server's
 * resources show; on a host that isn't a Linked host, none do.
 */
export function TunnelsCoolifyView({
  host,
}: {
  host?: PluginHostRecord | null;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const canOperate = usePermission("operate");
  const map = useCompanions();
  const link = linkOf(host ?? null);
  // A host that isn't a Linked host has no Coolify resources: only the
  // hostless tab lists every connection's.
  const unlinked = !!host && !link;
  // What the sections were loaded for: they show only while it is current.
  const scope = unlinked
    ? "unlinked"
    : link
      ? `${link.connectionId}:${link.serverUuid}`
      : "all";
  const [loaded, setLoaded] = useState<{
    scope: string;
    sections: Section[];
  } | null>(null);
  // Open forwards by row key (connection, uuid and revision), kept here so a
  // row's control can unmount and come back without losing its forward.
  const [forwards, setForwards] = useState<Record<string, TunnelAnswer>>({});

  useEffect(() => {
    setLoaded(null);
    if (unlinked) return;
    // A request generation: only this run's answer for this scope lands.
    let live = true;
    void (async () => {
      let sections: Section[] = [];
      try {
        const all = await api.listConnections();
        // Only connections the actor may operate: forwarding needs an
        // operate (or higher) grant there, not just the global permission.
        const chosen = all.filter(
          (c) =>
            OPERATE_ACCESS.has(c.access) &&
            (!link || c.id === link.connectionId),
        );
        const read = await Promise.all(
          chosen.map(async (c) => {
            const list = await api.listResources(c.id).catch(() => null);
            const rows = (list?.rows ?? []).filter(
              (r) =>
                r.kind !== "service" &&
                (!link || r.serverUuid === link.serverUuid),
            );
            return {
              connectionId: c.id,
              revision: c.revision,
              name: c.name,
              rows,
            };
          }),
        );
        sections = read.filter((s) => s.rows.length > 0);
      } catch {
        sections = [];
      }
      if (live) setLoaded({ scope, sections });
    })();
    return () => {
      live = false;
    };
    // The scope names the link's two fields, which are what matter.
  }, [api, scope]);

  if (!canOperate) return null;
  if (unlinked) {
    return (
      <EmptyState
        icon={Network}
        title={t("containerCompanions.notCoolifyHost")}
      />
    );
  }
  if (map && !map.tunnels) {
    return (
      <NoticePanel
        icon={Network}
        title={t("containerCompanions.tunnelsMissing")}
      />
    );
  }
  const sections = loaded?.scope === scope ? loaded.sections : null;
  if (!map || !sections) return <LoadingState />;
  if (!sections.length) {
    return (
      <EmptyState icon={Network} title={t("containerCompanions.noResources")} />
    );
  }
  return (
    <div className="flex flex-col gap-4 p-3">
      <p className="text-sm text-muted-foreground">
        {t("containerCompanions.localNote")}
      </p>
      {sections.map((section) => (
        <div key={section.connectionId} className="flex flex-col gap-2">
          <GroupHeading title={section.name} count={section.rows.length} />
          {section.rows.map((r) => {
            const key = `${section.connectionId}:${r.uuid}:${section.revision}`;
            return (
              <div
                key={key}
                role="group"
                aria-label={r.name}
                className="flex flex-col gap-1 rounded-md border p-2"
              >
                <span className="text-sm font-medium">{r.name}</span>
                <ForwardControl
                  api={api}
                  connectionId={section.connectionId}
                  resource={r}
                  open={forwards[key] ?? null}
                  onOpen={(forward) =>
                    setForwards((all) => {
                      const next = { ...all };
                      if (forward) next[key] = forward;
                      else delete next[key];
                      return next;
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
