import { useEffect, useMemo, useState } from "react";
import { Boxes, Cloud, Lock, RefreshCw, Settings2, Unlink } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
  type HostSectionProps,
  type ShellApi,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  NoticePanel,
  StatusBadge,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, failureOf } from "../api";
import { forgetPreview, linkOf, useLinkedRow, type HostLink } from "../linked";
import { describeFailure } from "./ConnectionForm";
import { HostCompanions } from "./HostCompanions";
import { ServerUpdates } from "./ServerUpdates";

/** Opens the Coolify tab on a section for one Linked host's connection. */
export function openCoolify(
  shell: Pick<ShellApi, "openSingletonTab">,
  section: "sync" | "resources",
  link: HostLink,
): void {
  shell.openSingletonTab("coolify", {
    data: {
      section,
      connectionId: link.connectionId,
      serverUuid: link.serverUuid,
    },
  });
}

/** The Coolify card on a Linked host's page. */
export function HostSection({ host, shell }: HostSectionProps) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const confirm = useConfirm();
  const canConfigure = usePermission("configure");
  const link = linkOf(host);
  const row = useLinkedRow(link);
  const [connectionName, setConnectionName] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectionId = link?.connectionId ?? 0;
  useEffect(() => {
    // A revision read for another connection never keys this one's card.
    setRevision(null);
    if (!connectionId) return;
    let live = true;
    api
      .getConnection(connectionId)
      .then((c) => {
        if (!live) return;
        setConnectionName(c?.name ?? null);
        setRevision(c?.revision ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, connectionId]);

  if (!link || unlinked) {
    return (
      <NoticePanel
        title={
          unlinked ? t("hostSection.unlinked") : t("hostSection.notLinked")
        }
      />
    );
  }

  async function unlink() {
    if (!link) return;
    const ok = await confirm({
      title: t("unlinkConfirm.title", { name: host.name ?? host.ip }),
      description: t("unlinkConfirm.description"),
      confirmLabel: t("unlinkConfirm.confirm"),
      destructive: false,
    });
    if (!ok) return;
    try {
      await api.unlinkServer(link.connectionId, link.serverUuid, false);
      forgetPreview(link.connectionId);
      setUnlinked(true);
    } catch (err) {
      setError(
        failureOf(err)
          ? describeFailure(t, err)
          : t("hostSection.unlinkFailed"),
      );
    }
  }

  const reachable = row ? row.server.reachable : null;
  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <p>
        {t("hostSection.linked", {
          server: row?.server.name ?? link.serverUuid,
          connection: connectionName ?? t("hostSection.unknownConnection"),
        })}{" "}
        {row?.status === "gone" ? (
          <StatusBadge tone="warn">{t("sync.status.gone")}</StatusBadge>
        ) : reachable === null ? null : (
          <StatusBadge tone={reachable ? "ok" : "bad"}>
            {reachable ? t("sync.status.linked") : t("hostDot.unreachable")}
          </StatusBadge>
        )}
      </p>
      <p className="text-muted-foreground flex items-start gap-2 text-xs">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        {t("hostSection.locked")}
      </p>
      {row?.tunnel && (
        <div className="flex flex-col gap-2">
          <p className="flex items-start gap-2">
            <Cloud className="mt-0.5 size-3.5 shrink-0" />
            {t("hostSection.tunnel")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("hostSection.tunnelReadOnly")}
          </p>
          {shell.editHost && (
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => shell.editHost?.(Number(host.id))}
              >
                <Settings2 className="size-3.5" />
                {t("hostSection.openTunnelSettings")}
              </Button>
            </div>
          )}
        </div>
      )}
      <HostCompanions link={link} shell={shell} revision={revision} />
      {error && <NoticePanel tone="destructive" title={error} />}
      <ServerUpdates link={link} revision={revision} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => openCoolify(shell, "resources", link)}
        >
          <Boxes className="size-3.5" />
          {t("hostSection.resources")}
        </Button>
        {canConfigure && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openCoolify(shell, "sync", link)}
          >
            <RefreshCw className="size-3.5" />
            {t("hostSection.sync")}
          </Button>
        )}
        {canConfigure && (
          <Button size="sm" variant="outline" onClick={() => void unlink()}>
            <Unlink className="size-3.5" />
            {t("hostSection.unlink")}
          </Button>
        )}
      </div>
    </div>
  );
}
