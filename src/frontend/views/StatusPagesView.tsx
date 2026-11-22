import { useCallback, useEffect, useState } from "react";
import { Copy, Globe, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Checkbox,
  EmptyState,
  InlineView,
  ListRow,
  ListRowAction,
  LoadingState,
  NoticePanel,
  PANEL,
  PanelList,
  SectionCard,
  TextField,
  cn,
  copyToClipboard,
} from "@termix-ssh/plugin-sdk/ui";
import type {
  Api,
  Connection,
  Resource,
  StatusPage,
  StatusPageLink,
} from "../api";
import { useConfirmFor } from "../confirm";
import { describeFailure } from "./ConnectionForm";

/** The link right after create or rotate. It lives only in this state, once. */
function ShownOnce({
  link,
  onDone,
}: {
  link: StatusPageLink;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <NoticePanel tone="warning" title={t("statusPages.created.title")}>
      <div className="flex flex-col gap-2 text-[12px]">
        <p>{t("statusPages.created.description")}</p>
        <code className="break-all border border-border bg-background px-2 py-1">
          {link.url}
        </code>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void copyToClipboard(link.url).then((ok) => setCopied(ok))
            }
          >
            <Copy className="size-3.5" />
            {copied
              ? t("statusPages.created.copied")
              : t("statusPages.created.copy")}
          </Button>
          <Button size="sm" onClick={onDone}>
            {t("statusPages.created.done")}
          </Button>
        </div>
      </div>
    </NoticePanel>
  );
}

function NewPageForm({
  resources,
  saving,
  onCreate,
}: {
  resources: Resource[] | null;
  saving: boolean;
  onCreate: (title: string, uuids: string[]) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  function toggle(uuid: string, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(uuid);
      else next.delete(uuid);
      return next;
    });
  }

  async function submit() {
    if (!title.trim()) return setProblem(t("statusPages.form.needsTitle"));
    // In list order, whatever order they were ticked in.
    const uuids = (resources ?? [])
      .map((r) => r.uuid)
      .filter((uuid) => chosen.has(uuid));
    if (!uuids.length) return setProblem(t("statusPages.form.needsResources"));
    setProblem(null);
    if (await onCreate(title.trim(), uuids)) {
      setTitle("");
      setChosen(new Set());
    }
  }

  return (
    <SectionCard
      title={t("statusPages.form.heading")}
      icon={<Globe className="size-4" />}
    >
      <div className={cn(PANEL.section, "flex flex-col gap-3 text-[12px]")}>
        {problem && <NoticePanel tone="destructive" title={problem} />}
        <TextField
          label={t("statusPages.form.title")}
          placeholder={t("statusPages.form.titlePlaceholder")}
          value={title}
          onChange={setTitle}
        />
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t("statusPages.form.resources")}</span>
          {resources === null ? (
            <LoadingState compact label={t("statusPages.loading")} />
          ) : resources.length === 0 ? (
            <p className="text-muted-foreground">
              {t("statusPages.form.noResources")}
            </p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {resources.map((r) => (
                <li
                  key={r.uuid}
                  className={cn(
                    "flex items-center gap-2",
                    r.parentUuid && "pl-5",
                  )}
                >
                  <Checkbox
                    id={`status-page-${r.uuid}`}
                    aria-label={r.name}
                    checked={chosen.has(r.uuid)}
                    onCheckedChange={(on) => toggle(r.uuid, on === true)}
                  />
                  <label htmlFor={`status-page-${r.uuid}`}>{r.name}</label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            {saving
              ? t("statusPages.form.creating")
              : t("statusPages.form.create")}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

/**
 * A connection's public status pages, under Connections: the list, publish,
 * a new link (rotate) and revoke. A link is shown once, right after it is
 * made, and never kept.
 */
export function StatusPagesView({
  api,
  connection,
  onClose,
}: {
  api: Api;
  connection: Connection;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Rotate and revoke act on this connection's pages: a confirm answered after
  // the view moved to another connection or target, or closed, runs nothing.
  const { confirm } = useConfirmFor(`${connection.id}\n${connection.revision}`);
  const [pages, setPages] = useState<StatusPage[] | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState<StatusPageLink | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listStatusPages(connection.id);
      setPages(list.pages);
      setAllowed(list.allowed);
      setError(null);
    } catch {
      setPages((prev) => prev ?? []);
      setError(t("statusPages.loadFailed"));
    }
  }, [api, connection.id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let live = true;
    api
      .listResources(connection.id)
      .then((list) => {
        if (live) setResources(list.rows);
      })
      .catch(() => {
        if (live) setResources([]);
      });
    return () => {
      live = false;
    };
  }, [api, connection.id]);

  async function create(title: string, uuids: string[]): Promise<boolean> {
    setSaving(true);
    try {
      setLink(
        await api.createStatusPage(connection.id, { title, resources: uuids }),
      );
      await load();
      return true;
    } catch (err) {
      setError(describeFailure(t, err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function rotate(page: StatusPage) {
    const ok = await confirm({
      title: t("statusPages.rotate.title", { name: page.title }),
      description: t("statusPages.rotate.description"),
      confirmLabel: t("statusPages.rotate.confirm"),
      cancelLabel: t("statusPages.cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      setLink(await api.rotateStatusPage(page.id));
    } catch (err) {
      setError(describeFailure(t, err));
    }
  }

  async function revoke(page: StatusPage) {
    const ok = await confirm({
      title: t("statusPages.revoke.title", { name: page.title }),
      description: t("statusPages.revoke.description"),
      confirmLabel: t("statusPages.revoke.confirm"),
      cancelLabel: t("statusPages.cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.revokeStatusPage(page.id);
      setPages((prev) => (prev ?? []).filter((p) => p.id !== page.id));
      if (link?.id === page.id) setLink(null);
    } catch (err) {
      setError(describeFailure(t, err));
    }
  }

  function meta(page: StatusPage): string {
    const date = page.createdAt
      ? new Date(page.createdAt).toLocaleDateString()
      : "";
    return t("statusPages.meta", { count: page.resources.length, date });
  }

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("statusPages.title", { name: connection.name })}
      icon={<Globe className="size-4" />}
    >
      <div className={cn(PANEL.body, "flex flex-col gap-3")}>
        <p className="text-[12px] text-muted-foreground">
          {t("statusPages.description")}
        </p>
        {!allowed && (
          <NoticePanel tone="warning" title={t("statusPages.off")} />
        )}
        {error && <NoticePanel tone="destructive" title={error} />}
        {link && <ShownOnce link={link} onDone={() => setLink(null)} />}
        {pages === null ? (
          <LoadingState label={t("statusPages.loading")} />
        ) : (
          <PanelList
            empty={<EmptyState icon={Globe} title={t("statusPages.empty")} />}
          >
            {pages.map((page, i) => (
              <ListRow
                key={page.id}
                stripe={i}
                title={page.title}
                meta={meta(page)}
                actions={
                  <>
                    {allowed && (
                      <ListRowAction
                        label={t("statusPages.rotate.action")}
                        onClick={() => void rotate(page)}
                      >
                        <RefreshCw className="size-3.5" />
                      </ListRowAction>
                    )}
                    <ListRowAction
                      label={t("statusPages.revoke.action")}
                      tone="destructive"
                      onClick={() => void revoke(page)}
                    >
                      <Trash2 className="size-3.5" />
                    </ListRowAction>
                  </>
                }
              />
            ))}
          </PanelList>
        )}
        {allowed && (
          <NewPageForm
            resources={resources}
            saving={saving}
            onCreate={create}
          />
        )}
      </div>
    </InlineView>
  );
}
