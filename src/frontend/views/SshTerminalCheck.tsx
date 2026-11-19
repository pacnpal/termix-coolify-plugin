import { useEffect, useMemo, useRef, useState } from "react";
import { Puzzle } from "lucide-react";
import {
  usePluginApi,
  useTabs,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, StatusDot } from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Connection, type SyncRow } from "../api";

/** Sync causes that SSH Terminal fixes: turn it on, or update it. */
export const SSH_TERMINAL_CAUSES = new Set([
  "needs-ssh-terminal",
  "ssh-terminal-too-old",
]);

/** Opens Termix's own Plugins tab, where SSH Terminal is turned on or updated. */
export function OpenPluginsButton() {
  const { t } = useTranslation();
  const tabs = useTabs();
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => tabs.openSingletonTab("plugins")}
    >
      <Puzzle className="size-3.5" />
      {t("sync.openPlugins")}
    </Button>
  );
}

/**
 * One checklist line for connection setup, shown only when the Coolify
 * instance has tunnelled servers: whether SSH Terminal can carry them. It
 * reads the sync preview, which changes nothing. Scoped tokens can't list
 * servers, so they get no line. The rows belong to the connection's target
 * (revision) and its latest check: a new address, token or probe loads them
 * again, and only the newest request may set them.
 */
export function SshTerminalCheck({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [rows, setRows] = useState<SyncRow[] | null>(null);
  const requests = useRef(0);
  const { id, scoped, revision, lastCheckedAt } = connection;

  useEffect(() => {
    const generation = ++requests.current;
    const latest = () => generation === requests.current;
    setRows(null);
    if (scoped) return;
    api
      .syncPreview(id)
      .then((next) => {
        if (latest()) setRows(Array.isArray(next) ? next : []);
      })
      .catch(() => undefined);
  }, [api, id, scoped, revision, lastCheckedAt]);

  const tunnelled = (rows ?? []).filter((row) => row.tunnel);
  if (!tunnelled.length) return null;
  const blocked = tunnelled.find(
    (row) => row.cause && SSH_TERMINAL_CAUSES.has(row.cause),
  );
  return (
    <li className="flex items-start gap-2">
      <StatusDot tone={blocked ? "bad" : "ok"} className="mt-1" />
      <div className="flex flex-col gap-1">
        <span>{t("connections.probe.steps.sshTerminal")}</span>
        {blocked?.cause && (
          <>
            <span className="text-muted-foreground">
              {t(`sync.causes.${blocked.cause}`)}
            </span>
            <div>
              <OpenPluginsButton />
            </div>
          </>
        )}
      </div>
    </li>
  );
}
