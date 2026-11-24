import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Globe,
  Pencil,
  RefreshCw,
  Rocket,
  Stethoscope,
  Trash2,
} from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  EmptyState,
  FormFooter,
  InlineView,
  ListBadge,
  ListRow,
  ListRowAction,
  LoadingState,
  NoticePanel,
  PANEL,
  PanelList,
  PanelShell,
  RefreshButton,
  StatusBadge,
  SwitchRow,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Api, type Connection } from "../api";
import { useConfirmFor } from "../confirm";
import {
  ConnectionFields,
  FormError,
  ProbeChecklist,
  describeFailure,
  useConnectionForm,
} from "./ConnectionForm";
import { AlertPrefsView } from "./AlertPrefsView";
import { McpPanel } from "./McpPanel";
import { StatusPagesView } from "./StatusPagesView";
import { WebhookSetup } from "./WebhookSetup";

function ConnectionEditor({
  api,
  connection,
  onClose,
  onSaved,
}: {
  api: Api;
  connection: Connection | null;
  onClose: () => void;
  onSaved: (saved: Connection) => void;
}) {
  const { t } = useTranslation();
  const form = useConnectionForm(api, connection, onSaved);
  // The row as last saved here: a create gives the panels below a
  // connection, and a new target their new revision.
  const saved = form.current;
  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={form.editing ? t("connections.edit") : t("connections.add")}
      icon={<Rocket className="size-4" />}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void form.save()}
          saveLabel={
            form.saving
              ? t("connections.form.saving")
              : t("connections.form.save")
          }
          saving={form.saving}
          dirty={form.dirty}
        />
      }
    >
      <FormError message={form.error} />
      <ConnectionFields
        form={form}
        hasCfAccess={form.current?.cfAccess ?? false}
      />
      {saved && saved.access === "owner" && (
        <>
          <WebhookSetup
            key={`${saved.id}:${saved.revision}`}
            api={api}
            connection={saved}
          />
          <PollSwitch api={api} connection={saved} onSaved={onSaved} />
          <ExecSwitch api={api} connection={saved} onSaved={onSaved} />
        </>
      )}
      {form.result && <ProbeChecklist connection={form.result} />}
    </InlineView>
  );
}

/**
 * The owner's opt-in to coolify.exec for one saved connection. It saves on
 * its own, apart from the form, and always shows what turning it on allows.
 */
function ExecSwitch({
  api,
  connection,
  onSaved,
}: {
  api: Api;
  connection: Connection;
  onSaved: (saved: Connection) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(connection.execEnabled === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.setExec(connection.id, next);
      setEnabled(saved.execEnabled === true);
      onSaved(saved);
    } catch {
      setError(t("connections.exec.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn(PANEL.body, "flex flex-col gap-3")}>
      <SwitchRow
        label={t("connections.exec.label")}
        description={t("connections.exec.description")}
        checked={enabled}
        disabled={saving}
        onChange={(v) => void change(v)}
      />
      <NoticePanel tone="warning" title={t("connections.exec.warning")} />
      <FormError message={error} />
    </div>
  );
}

/**
 * The owner's choice to keep polling Coolify once the team's webhook has
 * delivered. It saves on its own, apart from the form.
 */
function PollSwitch({
  api,
  connection,
  onSaved,
}: {
  api: Api;
  connection: Connection;
  onSaved: (saved: Connection) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(connection.pollEnabled === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.setPoll(connection.id, next);
      setEnabled(saved.pollEnabled === true);
      onSaved(saved);
    } catch {
      setError(t("connections.poll.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn(PANEL.body, "flex flex-col gap-3")}>
      <SwitchRow
        label={t("connections.poll.label")}
        description={t("connections.poll.description")}
        checked={enabled}
        disabled={saving}
        onChange={(v) => void change(v)}
      />
      <FormError message={error} />
    </div>
  );
}

function metaLine(
  t: (key: string, o?: Record<string, unknown>) => string,
  c: Connection,
) {
  const parts = [
    c.baseUrl,
    c.version
      ? t("connections.meta.version", { version: c.version })
      : t("connections.meta.unknownVersion"),
  ];
  if (c.teamName) parts.push(t("connections.meta.team", { team: c.teamName }));
  if (c.lastError) parts.push(t(`causes.${c.lastError}`));
  if (c.pollError) {
    parts.push(
      t("connections.poll.error", { cause: t(`causes.${c.pollError}`) }),
    );
  }
  return parts.join(" · ");
}

/** Whether the actor can sync this connection's servers into hosts. */
export function syncable(c: Pick<Connection, "access" | "scoped">): boolean {
  return c.access === "owner" && !c.scoped;
}

/**
 * The Connections section: the list, add, edit, check again, remove, and
 * Sync servers, which hands the connection to the tab's Servers section.
 */
export function ConnectionsView({
  onSaved,
  onSync,
}: {
  /** Told about each saved connection, so the tab can drop stale resources. */
  onSaved?: (saved: Connection) => void;
  /** Opens host sync for a connection; without it there is no Sync action. */
  onSync?: (connection: Connection) => void;
} = {}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  // The list isn't for one target: a remove names its own connection, and a
  // confirm answered after the list closed removes nothing.
  const { confirm } = useConfirmFor("connections");
  const canConfigure = usePermission("configure");
  const canUseMcp = usePermission("mcp");
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [publishing, setPublishing] = useState<Connection | null>(null);
  const [alerting, setAlerting] = useState<Connection | null>(null);

  // Request generations: a list answer is applied only when it is the latest
  // load and no change (save, probe, removal) landed after it was asked for.
  const loads = useRef(0);
  const changes = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loads.current;
    const changesBefore = changes.current;
    const current = () =>
      generation === loads.current && changesBefore === changes.current;
    setLoading(true);
    try {
      const list = await api.listConnections();
      if (current()) setRows(Array.isArray(list) ? list : []);
      setError(null);
    } catch {
      if (current()) {
        setError(t("connections.loadFailed"));
        setRows((prev) => prev ?? []);
      }
    } finally {
      if (generation === loads.current) setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = (saved: Connection) => {
    changes.current += 1;
    onSaved?.(saved);
    setRows((prev) => {
      const list = prev ?? [];
      return list.some((c) => c.id === saved.id)
        ? list.map((c) => (c.id === saved.id ? saved : c))
        : [...list, saved];
    });
  };

  /** Updates a row that is still listed; a removed one stays removed. */
  const replace = (fresh: Connection) => {
    changes.current += 1;
    setRows((prev) => (prev ?? []).map((c) => (c.id === fresh.id ? fresh : c)));
  };

  async function probe(c: Connection) {
    try {
      replace((await api.probeConnection(c.id)).connection);
    } catch (err) {
      setError(describeFailure(t, err));
    }
  }

  async function remove(c: Connection) {
    const ok = await confirm({
      title: t("connections.delete.title", { name: c.name }),
      description: t("connections.delete.description"),
      confirmLabel: t("connections.delete.confirm"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteConnection(c.id);
      changes.current += 1;
      setRows((prev) => (prev ?? []).filter((r) => r.id !== c.id));
    } catch (err) {
      setError(describeFailure(t, err));
    }
  }

  const add = canConfigure ? (
    <AddButton label={t("connections.add")} onClick={() => setEditing("new")} />
  ) : null;

  return (
    <PanelShell
      icon={<Rocket className="size-4" />}
      title={t("connections.title")}
      actions={
        <>
          <RefreshButton
            onClick={() => void load()}
            loading={loading}
            label={t("connections.refresh")}
          />
          {add}
        </>
      }
    >
      {error && <NoticePanel tone="destructive" title={error} />}
      {rows === null ? (
        <LoadingState label={t("connections.loading")} />
      ) : (
        <PanelList
          empty={
            <EmptyState
              icon={Rocket}
              title={t("connections.empty.title")}
              hint={t("connections.empty.hint")}
              action={add}
            />
          }
        >
          {rows.map((c, i) => (
            <ListRow
              key={c.id}
              stripe={i}
              title={c.name}
              meta={metaLine(t, c)}
              tone={c.lastError ? "destructive" : "success"}
              badges={
                <>
                  <StatusBadge tone={c.lastError ? "bad" : "ok"}>
                    {c.lastError
                      ? t("connections.badges.error")
                      : t("connections.badges.ok")}
                  </StatusBadge>
                  {c.scoped && (
                    <ListBadge tone="warning">
                      {t("connections.badges.scoped")}
                    </ListBadge>
                  )}
                </>
              }
              actions={
                <>
                  {canConfigure && c.access === "owner" && (
                    <ListRowAction
                      label={t("connections.actions.edit")}
                      onClick={() => setEditing(c)}
                    >
                      <Pencil className="size-3.5" />
                    </ListRowAction>
                  )}
                  {onSync && canConfigure && syncable(c) && (
                    <ListRowAction
                      label={t("connections.actions.sync")}
                      onClick={() => onSync(c)}
                    >
                      <RefreshCw className="size-3.5" />
                    </ListRowAction>
                  )}
                  {canConfigure && c.access === "owner" && (
                    <ListRowAction
                      label={t("statusPages.open")}
                      onClick={() => setPublishing(c)}
                    >
                      <Globe className="size-3.5" />
                    </ListRowAction>
                  )}
                  <ListRowAction
                    label={t("alerts.prefs.open")}
                    onClick={() => setAlerting(c)}
                  >
                    <Bell className="size-3.5" />
                  </ListRowAction>
                  <ListRowAction
                    label={t("connections.actions.probe")}
                    onClick={() => void probe(c)}
                  >
                    <Stethoscope className="size-3.5" />
                  </ListRowAction>
                  {canConfigure && c.access === "owner" && (
                    <ListRowAction
                      label={t("connections.actions.delete")}
                      tone="destructive"
                      onClick={() => void remove(c)}
                    >
                      <Trash2 className="size-3.5" />
                    </ListRowAction>
                  )}
                </>
              }
            />
          ))}
        </PanelList>
      )}
      {canUseMcp && <McpPanel api={api} />}
      {publishing && (
        <StatusPagesView
          api={api}
          connection={publishing}
          onClose={() => setPublishing(null)}
        />
      )}
      {alerting && (
        <AlertPrefsView
          key={alerting.id}
          api={api}
          connection={alerting}
          onClose={() => setAlerting(null)}
        />
      )}
      {editing !== null && (
        <ConnectionEditor
          api={api}
          connection={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={upsert}
        />
      )}
    </PanelShell>
  );
}
