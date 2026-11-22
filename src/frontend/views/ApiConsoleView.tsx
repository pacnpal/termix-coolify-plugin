import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Braces, Eye, EyeOff } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  FormFooter,
  GroupHeading,
  InlineView,
  ListBadge,
  ListRow,
  LoadingState,
  NoticePanel,
  PANEL,
  PanelList,
  PanelSearch,
  PanelShell,
  RefreshButton,
  SwitchRow,
  TextField,
  ToolbarSelect,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type Api,
  type ApiCallAnswer,
  type ApiOperation,
  type Connection,
  type JsonPointer,
} from "../api";
import { useConfirmFor } from "../confirm";

type T = (key: string, options?: Record<string, unknown>) => string;

const METHOD_TONE = {
  GET: "muted",
  POST: "brand",
  PATCH: "warning",
  PUT: "warning",
  DELETE: "destructive",
} as const;

function describe(t: T, err: unknown): string {
  const failure = failureOf(err);
  if (failure?.cause) {
    const text = t(`causes.${failure.cause}`);
    if (text && text !== `causes.${failure.cause}`) return text;
  }
  return t("apiConsole.failed");
}

/** A form value in the type the spec gives; empty is left out. */
function convert(raw: string, type: string, name: string, t: T): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  const kinds = type.split("|");
  if (kinds.includes("object") || kinds.includes("array")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(t("apiConsole.invalidJson", { field: name }));
    }
  }
  if (kinds.includes("integer") || kinds.includes("number")) {
    const value = Number(text);
    if (Number.isFinite(value)) return value;
  }
  if (kinds.includes("boolean") && (text === "true" || text === "false")) {
    return text === "true";
  }
  return raw;
}

function pointerKey(pointer: JsonPointer): string {
  return JSON.stringify(pointer);
}

function useHeld() {
  const view = usePermission("view");
  const operate = usePermission("operate");
  const configure = usePermission("configure");
  const administer = usePermission("administer");
  return useCallback(
    (permission: string) => {
      switch (permission.replace(/^coolify\./, "")) {
        case "view":
          return view;
        case "operate":
          return operate;
        case "configure":
          return configure;
        case "administer":
          return administer;
        default:
          return false;
      }
    },
    [view, operate, configure, administer],
  );
}

/** The masked values of an answer, each revealed on its own and never kept. */
function MaskedValues({
  answer,
  canReveal,
  reason,
  onReveal,
}: {
  answer: ApiCallAnswer;
  canReveal: boolean;
  reason: string | null;
  onReveal: (pointer: JsonPointer) => Promise<string>;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<{ key: string; value: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Every reveal and hide starts a new generation; only the current
  // reveal's answer is shown, so a late one never shows a secret.
  const generation = useRef(0);
  // The answer the reveals were last reset for. Nothing is shown for the
  // first one yet, so its first effect resets nothing: a Reveal clicked
  // before that effect runs (the button is on screen from the first commit)
  // must not be dropped.
  const resetFor = useRef(answer);

  useEffect(() => {
    if (resetFor.current === answer) return;
    resetFor.current = answer;
    generation.current++;
    setShown(null);
  }, [answer]);

  if (!answer.masked.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <GroupHeading title={t("apiConsole.masked")} />
      <p className="text-[12px] text-muted-foreground">
        {t("apiConsole.maskedHint")}
      </p>
      {reason && <NoticePanel title={reason} />}
      {error && <NoticePanel tone="destructive" title={error} />}
      {answer.masked.map((pointer) => {
        const key = pointerKey(pointer);
        const open = shown?.key === key;
        return (
          <div
            key={key}
            className="flex items-center gap-2 border border-border px-2 py-1 text-[12px]"
          >
            <code className="shrink-0 text-muted-foreground">
              {pointer.join(".")}
            </code>
            <code className="min-w-0 flex-1 truncate">
              {open ? shown.value : "••••••••"}
            </code>
            {canReveal && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const mine = ++generation.current;
                  if (open) {
                    setShown(null);
                    return;
                  }
                  setError(null);
                  setShown(null);
                  onReveal(pointer)
                    .then((value) => {
                      if (generation.current === mine) setShown({ key, value });
                    })
                    .catch(() => {
                      if (generation.current === mine) {
                        setError(t("apiConsole.revealFailed"));
                      }
                    });
                }}
              >
                {open ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
                {open ? t("apiConsole.hide") : t("apiConsole.reveal")}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The generated form for one operation, its run and its answer. */
function OperationRunner({
  api,
  connection,
  op,
  onClose,
}: {
  api: Api;
  connection: Connection;
  op: ApiOperation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // What a run acts on: an answer to a confirm opened for another
  // connection, target or operation, or after the runner closed, runs nothing.
  const { confirm } = useConfirmFor(
    `${connection.id}\n${connection.revision}\n${op.id}`,
  );
  const held = useHeld();
  const [values, setValues] = useState<Record<string, string>>({});
  // Nullable fields set to send JSON null (apart from leaving them out).
  const [nulls, setNulls] = useState<Record<string, boolean>>({});
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ApiCallAnswer | null>(null);
  const [sentParams, setSentParams] = useState<Record<string, unknown>>({});

  const allowed = held(op.permission);
  const isDelete = op.method === "DELETE";
  const typedOk = !isDelete || typed === op.id;
  const sensitive = connection.abilities.sensitive || connection.abilities.root;
  const configureAccess =
    connection.access === "owner" || connection.access === "configure";
  const canConfigure = held("coolify.configure");
  const canReveal =
    op.method === "GET" && canConfigure && configureAccess && sensitive;
  const revealReason =
    op.method !== "GET" || canReveal
      ? null
      : !canConfigure || !configureAccess
        ? t("apiConsole.revealNeedsConfigure")
        : t("apiConsole.revealNeedsSensitive");

  const set = (key: string, value: string) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  function build(): { params: Record<string, unknown>; body?: unknown } {
    const params: Record<string, unknown> = {};
    for (const param of op.params) {
      const value = nulls[`p:${param.name}`]
        ? null
        : convert(values[`p:${param.name}`] ?? "", param.type, param.name, t);
      if (value !== undefined) params[param.name] = value;
    }
    if (!op.body) return { params };
    const body: Record<string, unknown> = {};
    for (const field of op.body) {
      const value = nulls[`b:${field.name}`]
        ? null
        : convert(values[`b:${field.name}`] ?? "", field.type, field.name, t);
      if (value !== undefined) body[field.name] = value;
    }
    return Object.keys(body).length ? { params, body } : { params };
  }

  async function run() {
    setError(null);
    let request: { params: Record<string, unknown>; body?: unknown };
    try {
      request = build();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    const extra: { confirmed?: boolean; confirmText?: string } = {};
    if (op.method !== "GET" || op.sensitive === true) {
      if (isDelete) {
        if (!typedOk) return;
        extra.confirmed = true;
        extra.confirmText = typed;
      } else {
        const ok = await confirm({
          title: t("apiConsole.confirmTitle", { operation: op.id }),
          description: t(
            op.method === "GET"
              ? "apiConsole.confirmSensitive"
              : "apiConsole.confirmDescription",
            {
              method: op.method,
              path: op.path,
            },
          ),
          confirmLabel: t("apiConsole.confirmLabel"),
          destructive: false,
        });
        if (!ok) return;
        extra.confirmed = true;
      }
    }
    setRunning(true);
    setAnswer(null);
    try {
      const result = await api.callApi(connection.id, {
        operationId: op.id,
        ...request,
        ...extra,
      });
      setSentParams(request.params);
      setAnswer({
        ...result,
        masked: Array.isArray(result.masked) ? result.masked : [],
      });
    } catch (err) {
      setError(describe(t, err));
    } finally {
      setRunning(false);
    }
  }

  const fields = [
    ...op.params.map((p) => ({ key: `p:${p.name}`, ...p, where: p.in })),
    ...(op.body ?? []).map((f) => ({
      key: `b:${f.name}`,
      ...f,
      where: "body",
    })),
  ];

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={op.id}
      icon={<Braces className="size-4" />}
      status={`${op.method} ${op.path}`}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void run()}
          saveLabel={running ? t("apiConsole.running") : t("apiConsole.run")}
          saving={running}
          disabled={!allowed || !typedOk || running}
        />
      }
    >
      <div className={`${PANEL.body} flex flex-col gap-3`}>
        {op.summary && (
          <p className="text-[12px] text-muted-foreground">{op.summary}</p>
        )}
        {!allowed && (
          <NoticePanel
            tone="destructive"
            title={t("apiConsole.needsPermission")}
          />
        )}
        {fields.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {t("apiConsole.noInputs")}
          </p>
        ) : (
          fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1">
              <TextField
                label={`${field.name} (${field.where}, ${field.type}${field.required ? `, ${t("apiConsole.required")}` : ""})`}
                placeholder={field.name}
                hint={field.description}
                value={values[field.key] ?? ""}
                onChange={(value) => set(field.key, value)}
                disabled={nulls[field.key] === true}
                mono
              />
              {field.nullable && (
                <SwitchRow
                  label={t("apiConsole.sendNull", { field: field.name })}
                  checked={nulls[field.key] === true}
                  onChange={(on) =>
                    setNulls((prev) => ({ ...prev, [field.key]: on }))
                  }
                />
              )}
            </div>
          ))
        )}
        {isDelete && allowed && (
          <TextField
            label={t("apiConsole.typeToConfirm", { operation: op.id })}
            placeholder={t("apiConsole.typeToConfirmPlaceholder")}
            value={typed}
            onChange={setTyped}
            mono
          />
        )}
        {error && <NoticePanel tone="destructive" title={error} />}
        {running && <LoadingState compact label={t("apiConsole.waiting")} />}
        {answer && (
          <div className="flex flex-col gap-2">
            <GroupHeading title={t("apiConsole.result")} />
            <pre
              data-testid="api-answer"
              className="overflow-x-auto border border-border bg-background p-2 text-[11px]"
            >
              {JSON.stringify(answer.data, null, 2)}
            </pre>
            <MaskedValues
              answer={answer}
              canReveal={canReveal}
              reason={revealReason}
              onReveal={(pointer) =>
                api.revealApiValue(connection.id, {
                  operationId: op.id,
                  params: sentParams,
                  pointer,
                })
              }
            />
          </div>
        )}
      </div>
    </InlineView>
  );
}

/**
 * The API console: every Coolify operation the user may call on a
 * connection, as a generated form. The backend lists only what the user's
 * permission, grant, token and Coolify version allow, and checks every call
 * again.
 */
export function ApiConsoleView() {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [ops, setOps] = useState<ApiOperation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ApiOperation | null>(null);

  // Only the newest load of each list may change state: an answer for a
  // connection the user switched away from, or an older refresh, is dropped.
  const connectionsRequest = useRef(0);
  const opsRequest = useRef(0);

  const loadConnections = useCallback(async () => {
    const mine = ++connectionsRequest.current;
    setLoading(true);
    try {
      const list = await api.listConnections();
      if (connectionsRequest.current !== mine) return;
      const rows = Array.isArray(list) ? list : [];
      setConnections(rows);
      setError(null);
      setConnectionId((current) => current ?? rows[0]?.id ?? null);
    } catch {
      if (connectionsRequest.current !== mine) return;
      setConnections([]);
      setError(t("apiConsole.loadFailed"));
    } finally {
      if (connectionsRequest.current === mine) setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void loadConnections();
    return () => {
      connectionsRequest.current++;
    };
  }, [loadConnections]);

  const loadOps = useCallback(async () => {
    if (connectionId === null) return;
    const mine = ++opsRequest.current;
    setLoading(true);
    try {
      const list = await api.listApiOperations(connectionId);
      if (opsRequest.current !== mine) return;
      setOps(list);
      setError(null);
    } catch (err) {
      if (opsRequest.current !== mine) return;
      setOps([]);
      setError(describe(t, err));
    } finally {
      if (opsRequest.current === mine) setLoading(false);
    }
  }, [api, connectionId, t]);

  useEffect(() => {
    setOps(null);
    setOpen(null);
    void loadOps();
    return () => {
      opsRequest.current++;
    };
  }, [loadOps]);

  const connection = connections?.find((c) => c.id === connectionId) ?? null;
  const needle = query.trim().toLowerCase();
  const shown = (ops ?? []).filter(
    (op) =>
      !needle ||
      op.id.toLowerCase().includes(needle) ||
      op.path.toLowerCase().includes(needle) ||
      op.summary.toLowerCase().includes(needle),
  );

  return (
    <PanelShell
      icon={<Braces className="size-4" />}
      title={t("apiConsole.title")}
      actions={
        <RefreshButton
          onClick={() =>
            // Without a connection (the list failed), load the list again.
            void (connectionId === null ? loadConnections() : loadOps())
          }
          loading={loading}
          label={t("connections.refresh")}
        />
      }
      toolbar={
        <>
          <PanelSearch
            value={query}
            onChange={setQuery}
            placeholder={t("apiConsole.search")}
          />
          {connections && connections.length > 1 && (
            <ToolbarSelect
              label={t("apiConsole.connection")}
              value={String(connectionId ?? "")}
              onChange={(value) => setConnectionId(Number(value))}
              options={connections.map((c) => ({
                value: String(c.id),
                label: c.name,
              }))}
            />
          )}
        </>
      }
    >
      <p className={`${PANEL.body} text-[12px] text-muted-foreground`}>
        {t("apiConsole.description")}
      </p>
      {error && <NoticePanel tone="destructive" title={error} />}
      {connections === null ? (
        <LoadingState label={t("apiConsole.loading")} />
      ) : connections.length === 0 ? (
        <EmptyState icon={Braces} title={t("apiConsole.noConnections")} />
      ) : ops === null ? (
        <LoadingState label={t("apiConsole.loading")} />
      ) : (
        <PanelList
          empty={<EmptyState icon={Braces} title={t("apiConsole.empty")} />}
        >
          {shown.map((op, i) => (
            <ListRow
              key={op.id}
              stripe={i}
              title={op.id}
              meta={`${op.path}${op.summary ? ` · ${op.summary}` : ""}`}
              tone={op.method === "DELETE" ? "destructive" : "none"}
              badges={
                <ListBadge tone={METHOD_TONE[op.method]}>{op.method}</ListBadge>
              }
              onClick={() => setOpen(op)}
            />
          ))}
        </PanelList>
      )}
      {open && connection && (
        <OperationRunner
          key={`${connection.id}:${open.id}`}
          api={api}
          connection={connection}
          op={open}
          onClose={() => setOpen(null)}
        />
      )}
    </PanelShell>
  );
}
