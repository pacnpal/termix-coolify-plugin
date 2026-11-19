import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe, Pencil, Rocket, Stethoscope, Trash2 } from "lucide-react";
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
  PanelList,
  PanelShell,
  RefreshButton,
  StatusBadge,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { createApi, type Api, type Connection } from "../api";
import {
  ConnectionFields,
  FormError,
  ProbeChecklist,
  describeFailure,
  useConnectionForm,
} from "./ConnectionForm";
import { McpPanel } from "./McpPanel";
import { StatusPagesView } from "./StatusPagesView";

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
  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={connection ? t("connections.edit") : t("connections.add")}
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
        hasCfAccess={connection?.cfAccess ?? false}
      />
      {form.result && <ProbeChecklist connection={form.result} />}
    </InlineView>
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
  return parts.join(" · ");
}

/** The Connections section: the list, add, edit, check again and remove. */
export function ConnectionsView() {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const confirm = useConfirm();
  const canConfigure = usePermission("configure");
  const canUseMcp = usePermission("mcp");
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [publishing, setPublishing] = useState<Connection | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listConnections();
      setRows(Array.isArray(list) ? list : []);
      setError(null);
    } catch {
      setError(t("connections.loadFailed"));
      setRows((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = (saved: Connection) =>
    setRows((prev) => {
      const list = prev ?? [];
      return list.some((c) => c.id === saved.id)
        ? list.map((c) => (c.id === saved.id ? saved : c))
        : [...list, saved];
    });

  async function probe(c: Connection) {
    try {
      upsert((await api.probeConnection(c.id)).connection);
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
                  {canConfigure && c.access === "owner" && (
                    <ListRowAction
                      label={t("statusPages.open")}
                      onClick={() => setPublishing(c)}
                    >
                      <Globe className="size-3.5" />
                    </ListRowAction>
                  )}
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
