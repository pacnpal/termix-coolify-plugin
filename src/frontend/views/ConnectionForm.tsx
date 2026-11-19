import { useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  GroupHeading,
  NoticePanel,
  PANEL,
  SecretField,
  StatusDot,
  SwitchRow,
  TextAreaField,
  TextField,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import {
  failureOf,
  type Api,
  type Connection,
  type ConnectionInput,
  type ConnectionPatch,
} from "../api";

/** Causes the backend sends that have a fix to suggest (locales `fixes`). */
const FIXABLE = new Set([
  "unreachable",
  "unauthorized",
  "api-disabled",
  "forbidden-ability",
  "access-redirect",
  "not-coolify",
  "unsupported-version",
]);

/** Plugin refusals that are not Coolify causes (locales `connections.errors`). */
const PLUGIN_ERRORS = new Set(["invalid-input", "forbidden", "not-found"]);

type T = ReturnType<typeof useTranslation>["t"];

/** A failed call as one line: the translated cause, and its fix when there is one. */
export function describeFailure(t: T, err: unknown): string {
  const failure = failureOf(err);
  if (!failure) return t("connections.errors.saveFailed");
  if (PLUGIN_ERRORS.has(failure.cause)) {
    return t(`connections.errors.${failure.cause}`, {
      message: failure.error,
    });
  }
  const cause = t(`causes.${failure.cause}`);
  return FIXABLE.has(failure.cause)
    ? `${cause} ${t(`fixes.${failure.cause}`)}`
    : cause;
}

interface FormState {
  name: string;
  baseUrl: string;
  token: string;
  cfAccessId: string;
  cfAccessSecret: string;
  allowPrivate: boolean;
  caCert: string;
}

function initialState(connection: Connection | null): FormState {
  return {
    name: connection?.name ?? "",
    baseUrl: connection?.baseUrl ?? "",
    token: "",
    cfAccessId: "",
    cfAccessSecret: "",
    allowPrivate: connection?.allowPrivate ?? false,
    caCert: connection?.caCert ?? "",
  };
}

/**
 * The add and edit form's state and save. On edit, an empty token or
 * Cloudflare Access field is left out of the request, so the stored value is
 * kept. After a create the form edits the saved connection, so saving again
 * (to retry a failed check, say) changes it instead of adding a duplicate.
 * Edits made while a save is pending stay, and keep the form dirty.
 */
export function useConnectionForm(
  api: Api,
  connection: Connection | null,
  onSaved: (saved: Connection) => void,
) {
  const { t } = useTranslation();
  const [state, setState] = useState<FormState>(() => initialState(connection));
  const [current, setCurrent] = useState<Connection | null>(connection);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Connection | null>(null);
  const [dirty, setDirty] = useState(false);
  // Counts edits, so a save knows whether anything changed while it ran.
  const revision = useRef(0);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    revision.current += 1;
    setState((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  async function save(): Promise<Connection | null> {
    const name = state.name.trim();
    const baseUrl = state.baseUrl.trim();
    const token = state.token.trim();
    if (!name || !baseUrl || (!current && !token)) {
      setError(t("connections.form.required"));
      return null;
    }
    const sent = {
      revision: revision.current,
      token: state.token,
      cfAccessId: state.cfAccessId,
      cfAccessSecret: state.cfAccessSecret,
    };
    setSaving(true);
    setError(null);
    try {
      let saved: Connection;
      if (current) {
        const patch: ConnectionPatch = {
          name,
          baseUrl,
          allowPrivate: state.allowPrivate,
          caCert: state.caCert.trim() || null,
        };
        if (token) patch.token = token;
        if (state.cfAccessId.trim()) patch.cfAccessId = state.cfAccessId.trim();
        if (state.cfAccessSecret.trim()) {
          patch.cfAccessSecret = state.cfAccessSecret.trim();
        }
        saved = await api.updateConnection(current.id, patch);
        // An update that changes nothing Coolify sees doesn't check again, so
        // a saved failure would stay stuck after Coolify is fixed: retrying it
        // asks for a fresh probe instead.
        if (
          current.lastError &&
          saved.lastCheckedAt === current.lastCheckedAt
        ) {
          saved = (await api.probeConnection(saved.id)).connection;
        }
      } else {
        const input: ConnectionInput = {
          name,
          baseUrl,
          token,
          allowPrivate: state.allowPrivate,
        };
        if (state.cfAccessId.trim()) input.cfAccessId = state.cfAccessId.trim();
        if (state.cfAccessSecret.trim()) {
          input.cfAccessSecret = state.cfAccessSecret.trim();
        }
        if (state.caCert.trim()) input.caCert = state.caCert.trim();
        saved = await api.createConnection(input);
      }
      // Secrets leave the form state once sent, unless retyped meanwhile.
      setState((prev) => ({
        ...prev,
        token: prev.token === sent.token ? "" : prev.token,
        cfAccessId: prev.cfAccessId === sent.cfAccessId ? "" : prev.cfAccessId,
        cfAccessSecret:
          prev.cfAccessSecret === sent.cfAccessSecret
            ? ""
            : prev.cfAccessSecret,
      }));
      setDirty(revision.current !== sent.revision);
      setCurrent(saved);
      setResult(saved);
      onSaved(saved);
      return saved;
    } catch (err) {
      setError(describeFailure(t, err));
      return null;
    } finally {
      setSaving(false);
    }
  }

  return {
    state,
    set,
    save,
    saving,
    error,
    result,
    dirty,
    /** The saved connection the form edits, or null while adding. */
    current,
    editing: !!current,
  };
}

export type ConnectionFormController = ReturnType<typeof useConnectionForm>;

export function ConnectionFields({
  form,
  hasCfAccess,
}: {
  form: ConnectionFormController;
  hasCfAccess: boolean;
}) {
  const { t } = useTranslation();
  const { state, set, editing } = form;
  const [advanced, setAdvanced] = useState(
    state.allowPrivate || !!state.caCert || hasCfAccess,
  );
  return (
    <div className={cn(PANEL.body, "flex flex-col gap-3")}>
      <TextField
        label={t("connections.form.name")}
        placeholder={t("connections.form.namePlaceholder")}
        value={state.name}
        onChange={(v) => set("name", v)}
      />
      <TextField
        label={t("connections.form.baseUrl")}
        placeholder={t("connections.form.baseUrlPlaceholder")}
        value={state.baseUrl}
        onChange={(v) => set("baseUrl", v)}
        mono
      />
      <SecretField
        label={t("connections.form.token")}
        placeholder={
          editing
            ? t("connections.form.tokenKeep")
            : t("connections.form.tokenPlaceholder")
        }
        value={state.token}
        onChange={(v) => set("token", v)}
        hint={t("connections.form.abilitiesHint")}
      />
      <SwitchRow
        label={t("connections.form.advanced")}
        checked={advanced}
        onChange={setAdvanced}
      />
      {advanced && (
        <>
          <SecretField
            label={t("connections.form.cfAccessId")}
            placeholder={hasCfAccess ? t("connections.form.cfAccessKeep") : ""}
            value={state.cfAccessId}
            onChange={(v) => set("cfAccessId", v)}
            hint={t("connections.form.cfAccessHint")}
          />
          <SecretField
            label={t("connections.form.cfAccessSecret")}
            placeholder={hasCfAccess ? t("connections.form.cfAccessKeep") : ""}
            value={state.cfAccessSecret}
            onChange={(v) => set("cfAccessSecret", v)}
          />
          <SwitchRow
            label={t("connections.form.allowPrivate")}
            description={t("connections.form.allowPrivateHint")}
            checked={state.allowPrivate}
            onChange={(v) => set("allowPrivate", v)}
          />
          <TextAreaField
            label={t("connections.form.caCert")}
            hint={t("connections.form.caCertHint")}
            value={state.caCert}
            onChange={(v) => set("caCert", v)}
            rows={4}
            mono
          />
        </>
      )}
    </div>
  );
}

/** The probe's checklist: each step, with the cause and the fix when it failed. */
export function ProbeChecklist({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      <GroupHeading title={t("connections.probe.title")} />
      {connection.scoped && (
        <NoticePanel tone="warning" title={t("connections.badges.scoped")}>
          {t("connections.probe.scoped")}
        </NoticePanel>
      )}
      <ul className={cn(PANEL.body, "flex flex-col gap-2 text-[12px]")}>
        {connection.steps.map((step) => (
          <li key={step.id} className="flex items-start gap-2">
            <StatusDot
              tone={step.ok ? "ok" : step.skipped ? "idle" : "bad"}
              className="mt-1"
            />
            <div className="flex flex-col">
              <span>{t(`connections.probe.steps.${step.id}`)}</span>
              {step.skipped && (
                <span className="text-muted-foreground">
                  {t(`connections.probe.skipped.${step.skipped}`)}
                </span>
              )}
              {step.cause && (
                <span className="text-muted-foreground">
                  {t(`causes.${step.cause}`)}
                  {FIXABLE.has(step.cause) && step.cause !== "forbidden-ability"
                    ? ` ${t(`fixes.${step.cause}`)}`
                    : ""}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <NoticePanel tone="destructive" title={message} />;
}
