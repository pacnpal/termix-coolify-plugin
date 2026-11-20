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
import { createApi, type Resource } from "../api";
import { useCompanions } from "../companions";
import { linkOf } from "../linked";
import { ForwardControl } from "./ContainerCompanions";

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
 * resources show.
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
  const [sections, setSections] = useState<Section[] | null>(null);

  useEffect(() => {
    if (unlinked) return;
    let live = true;
    void (async () => {
      try {
        const all = await api.listConnections();
        const chosen = link
          ? all.filter((c) => c.id === link.connectionId)
          : all;
        const loaded = await Promise.all(
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
        if (live) setSections(loaded.filter((s) => s.rows.length > 0));
      } catch {
        if (live) setSections([]);
      }
    })();
    return () => {
      live = false;
    };
    // The link is read from the host; its two fields are what matter.
  }, [api, unlinked, link?.connectionId, link?.serverUuid]);

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
          {section.rows.map((r) => (
            <div
              key={`${section.connectionId}:${r.uuid}:${section.revision}`}
              role="group"
              aria-label={r.name}
              className="flex flex-col gap-1 rounded-md border p-2"
            >
              <span className="text-sm font-medium">{r.name}</span>
              <ForwardControl
                api={api}
                connectionId={section.connectionId}
                resource={r}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
