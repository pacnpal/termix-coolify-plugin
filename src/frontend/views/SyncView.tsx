import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server } from "lucide-react";
import {
  listCredentials,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Checkbox,
  EmptyState,
  ListBadge,
  ListRow,
  LoadingState,
  NoticePanel,
  PanelList,
  PanelShell,
  RefreshButton,
  SelectField,
  StatusBadge,
  TextField,
  useConfirm,
  type StatusTone,
} from "@termix-ssh/plugin-sdk/ui";
import {
  failureOf,
  type Api,
  type Connection,
  type SyncChoice,
  type SyncResult,
  type SyncRow,
} from "../api";
import { describeFailure } from "./ConnectionForm";
import { OpenPluginsButton, SSH_TERMINAL_CAUSES } from "./SshTerminalCheck";

type T = ReturnType<typeof useTranslation>["t"];

interface Draft {
  include: boolean;
  address: string;
  credentialId: string;
}

const STATUS_TONE: Record<SyncRow["status"], StatusTone> = {
  new: "info",
  linked: "ok",
  blocked: "warn",
  gone: "idle",
};

const RESULT_TONE: Record<SyncResult["status"], StatusTone> = {
  created: "ok",
  updated: "ok",
  blocked: "warn",
  skipped: "idle",
  gone: "idle",
  failed: "bad",
};

function draftOf(row: SyncRow): Draft {
  return {
    include: row.status === "new" || row.status === "linked",
    address: row.addressOverride ?? "",
    credentialId: row.credentialId ? String(row.credentialId) : "",
  };
}

/** Whether a row can be included with what has been entered so far. */
function ready(row: SyncRow, draft: Draft): boolean {
  if (row.status === "gone") return false;
  if (row.cause && SSH_TERMINAL_CAUSES.has(row.cause)) return false;
  switch (row.cause) {
    case "needs-address":
      return draft.address.trim() !== "";
    case "needs-credential":
      return draft.credentialId !== "";
    default:
      return true;
  }
}

/** The choices to send: one per server still in Coolify. */
function choicesOf(
  rows: SyncRow[],
  drafts: Record<string, Draft>,
): SyncChoice[] {
  return rows
    .filter((row) => row.status !== "gone")
    .map((row) => {
      const draft = drafts[row.server.uuid] ?? draftOf(row);
      const choice: SyncChoice = {
        uuid: row.server.uuid,
        include: draft.include && ready(row, draft),
      };
      const address = draft.address.trim();
      if (address !== (row.addressOverride ?? "")) {
        choice.addressOverride = address || null;
      }
      const credential = draft.credentialId ? Number(draft.credentialId) : null;
      if (credential !== row.credentialId && credential !== null) {
        choice.credentialId = credential;
      }
      return choice;
    });
}

/** A failed call's cause, or the given fallback when it carries none. */
function failureText(t: T, err: unknown, fallback: string): string {
  return failureOf(err) ? describeFailure(t, err) : t(fallback);
}

function causeText(t: T, cause: string): string {
  const key = `sync.causes.${cause}`;
  const text = t(key);
  return text === key ? t(`causes.${cause}`) : text;
}

function metaOf(row: SyncRow): string {
  const { ip, port, user } = row.server;
  return ip ? `${user}@${ip}:${port}` : row.server.uuid;
}

function SyncRowView({
  row,
  draft,
  credentials,
  onDraft,
  onUnlink,
  stripe,
}: {
  row: SyncRow;
  draft: Draft;
  credentials: { value: string; label: string }[];
  onDraft: (next: Draft) => void;
  onUnlink: (removeHost: boolean) => void;
  stripe: number;
}) {
  const { t } = useTranslation();
  const canInclude = ready(row, draft);
  const gone = row.status === "gone";
  return (
    <div data-sync-row={row.server.uuid}>
      <ListRow
        stripe={stripe}
        icon={<Server className="size-4" />}
        title={row.server.name}
        meta={metaOf(row)}
        tone={gone ? "muted" : row.status === "blocked" ? "warning" : "success"}
        badges={
          <>
            <StatusBadge tone={STATUS_TONE[row.status]}>
              {t(`sync.status.${row.status}`)}
            </StatusBadge>
            {row.tunnel && (
              <ListBadge tone="warning">{t("sync.badges.tunnel")}</ListBadge>
            )}
            {row.server.isCoolifyHost && (
              <ListBadge tone="brand">{t("sync.badges.coolifyHost")}</ListBadge>
            )}
            {!gone && (
              <ListBadge tone="muted">
                {row.mode === "coolify"
                  ? t("sync.badges.keyFromCoolify")
                  : t("sync.badges.termixCredential")}
              </ListBadge>
            )}
          </>
        }
        trailing={
          gone ? undefined : (
            <Checkbox
              aria-label={t("sync.include")}
              checked={draft.include && canInclude}
              disabled={!canInclude}
              onCheckedChange={(value) =>
                onDraft({ ...draft, include: value === true })
              }
            />
          )
        }
      />
      <div className="flex flex-col gap-2 px-4 pb-3">
        {row.cause && (
          <p className="text-muted-foreground text-xs">
            {causeText(t, row.cause)}
          </p>
        )}
        {row.cause && SSH_TERMINAL_CAUSES.has(row.cause) && (
          <div>
            <OpenPluginsButton />
          </div>
        )}
        {row.cause === "needs-address" || row.addressOverride ? (
          <TextField
            label={t("sync.address")}
            value={draft.address}
            placeholder={row.suggestedAddress ?? ""}
            hint={t("sync.addressHint", { ip: row.server.ip })}
            mono
            onChange={(value) =>
              onDraft({
                ...draft,
                address: value,
                include: value.trim() !== "",
              })
            }
            aside={
              row.suggestedAddress ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onDraft({
                      ...draft,
                      address: row.suggestedAddress ?? "",
                      include: true,
                    })
                  }
                >
                  {t("sync.useSuggested", { address: row.suggestedAddress })}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {row.cause === "needs-credential" && (
          <SelectField
            label={t("sync.credential")}
            value={draft.credentialId}
            placeholder={t("sync.credentialPlaceholder")}
            hint={t("sync.credentialHint")}
            options={credentials}
            onChange={(value) =>
              onDraft({ ...draft, credentialId: value, include: value !== "" })
            }
          />
        )}
        {gone && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onUnlink(false)}>
              {t("sync.keepHost")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onUnlink(true)}
            >
              {t("sync.removeHost")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultsView({ results }: { results: SyncResult[] }) {
  const { t } = useTranslation();
  return (
    <NoticePanel title={t("sync.results.title")}>
      <ul className="flex flex-col gap-1 text-sm">
        {results.map((r) => (
          <li key={r.uuid}>
            <span className="font-medium">{r.name}</span>{" "}
            <StatusBadge tone={RESULT_TONE[r.status]}>
              {t(`sync.resultStatus.${r.status}`)}
            </StatusBadge>
            {r.cause && (
              <span className="text-muted-foreground">
                {" "}
                {causeText(t, r.cause)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </NoticePanel>
  );
}

/**
 * The host sync preview and confirm flow for one connection: every Coolify
 * server, what it becomes, and what each blocked one still needs.
 */
export function SyncView({
  api,
  connection,
  actions,
}: {
  api: Api;
  connection: Connection;
  /** Extra toolbar buttons, like Back. */
  actions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [rows, setRows] = useState<SyncRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [credentials, setCredentials] = useState<
    { value: string; label: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SyncResult[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.syncPreview(connection.id);
      setRows(next);
      setDrafts((prev) => {
        const out: Record<string, Draft> = {};
        for (const row of next) {
          out[row.server.uuid] = prev[row.server.uuid] ?? draftOf(row);
        }
        return out;
      });
      setError(null);
    } catch (err) {
      setError(failureText(t, err, "sync.loadFailed"));
      setRows((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [api, connection.id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Credentials are read only when a server needs one picked.
  const needsCredential = (rows ?? []).some(
    (row) => row.cause === "needs-credential",
  );
  useEffect(() => {
    if (!needsCredential) return;
    let live = true;
    listCredentials()
      .then((list) => {
        if (!live) return;
        setCredentials(
          (Array.isArray(list) ? list : []).map((c) => ({
            value: String(c.id),
            label: c.name,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [needsCredential]);

  async function apply() {
    if (!rows) return;
    setApplying(true);
    try {
      setResults(await api.syncApply(connection.id, choicesOf(rows, drafts)));
      setError(null);
      setDrafts({});
      await load();
    } catch (err) {
      setError(failureText(t, err, "sync.applyFailed"));
    } finally {
      setApplying(false);
    }
  }

  async function unlink(row: SyncRow, removeHost: boolean) {
    if (removeHost) {
      const ok = await confirm({
        title: t("sync.removeConfirm.title", { name: row.server.name }),
        description: t("sync.removeConfirm.description"),
        confirmLabel: t("sync.removeConfirm.confirm"),
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await api.unlinkServer(connection.id, row.server.uuid, removeHost);
      await load();
    } catch (err) {
      setError(failureText(t, err, "sync.unlinkFailed"));
    }
  }

  const included = rows
    ? choicesOf(rows, drafts).filter((c) => c.include).length
    : 0;

  return (
    <PanelShell
      icon={<RefreshCw className="size-4" />}
      title={t("sync.title", { name: connection.name })}
      actions={
        <>
          {actions}
          <RefreshButton
            onClick={() => void load()}
            loading={loading}
            label={t("sync.refresh")}
          />
          <Button
            size="sm"
            disabled={applying || included === 0}
            onClick={() => void apply()}
          >
            {applying ? t("sync.applying") : t("sync.apply")}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground px-4 py-2 text-sm">
        {t("sync.intro")}
      </p>
      {error && <NoticePanel tone="destructive" title={error} />}
      {results && <ResultsView results={results} />}
      {rows === null ? (
        <LoadingState label={t("sync.loading")} />
      ) : (
        <PanelList empty={<EmptyState icon={Server} title={t("sync.empty")} />}>
          {rows.map((row, i) => (
            <SyncRowView
              key={row.server.uuid}
              row={row}
              stripe={i}
              draft={drafts[row.server.uuid] ?? draftOf(row)}
              credentials={credentials}
              onDraft={(next) =>
                setDrafts((prev) => ({ ...prev, [row.server.uuid]: next }))
              }
              onUnlink={(removeHost) => void unlink(row, removeHost)}
            />
          ))}
        </PanelList>
      )}
    </PanelShell>
  );
}
