import { useEffect, useRef, useState } from "react";
import { Bell, Send } from "lucide-react";
import { invokeAction, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  FormFooter,
  InlineView,
  LoadingState,
  NoticePanel,
  PANEL,
  SwitchRow,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import type { AlertPrefs, Api, Connection } from "../api";

/** The Alerts hub's own page of delivery channels (manifest `uses`). */
export const OPEN_CHANNELS_ACTION = "alerts.openChannels";

/**
 * Your own alert kinds for one connection: a switch per event kind, saved
 * apart from the connection form, and a link to the Alerts hub's delivery
 * channels. Keyed by the connection by its parent, so a different
 * connection starts empty; answers that arrive after a newer request, or
 * after the view closed, are dropped.
 */
export function AlertPrefsView({
  api,
  connection,
  onClose,
}: {
  api: Api;
  connection: Pick<Connection, "id" | "name">;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Request generations: only the newest request's answer lands, and
  // nothing lands once the view is gone.
  const requests = useRef(0);
  const live = useRef(true);
  const id = connection.id;

  useEffect(() => {
    live.current = true;
    const generation = ++requests.current;
    const current = () => live.current && generation === requests.current;
    api.alertPrefs(id).then(
      (answer) => {
        if (!current()) return;
        setPrefs(answer);
        setPicked(new Set(answer.kinds));
      },
      () => {
        if (current()) setLoadFailed(true);
      },
    );
    return () => {
      live.current = false;
    };
  }, [api, id]);

  const dirty =
    prefs !== null &&
    (picked.size !== prefs.kinds.length ||
      prefs.kinds.some((kind) => !picked.has(kind)));

  async function store(kinds: string[] | null) {
    const generation = ++requests.current;
    const current = () => live.current && generation === requests.current;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const answer = await api.setAlertPrefs(id, kinds);
      if (!current()) return;
      setPrefs(answer);
      setPicked(new Set(answer.kinds));
      setSaved(true);
    } catch {
      if (current()) setError(t("alerts.prefs.saveFailed"));
    } finally {
      if (current()) setSaving(false);
    }
  }

  function toggle(kind: string, on: boolean) {
    setSaved(false);
    setPicked((before) => {
      const next = new Set(before);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }

  async function openChannels() {
    setError(null);
    try {
      await invokeAction(OPEN_CHANNELS_ACTION);
    } catch {
      setError(t("alerts.prefs.channelsFailed"));
    }
  }

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("alerts.prefs.title", { name: connection.name })}
      icon={<Bell className="size-4" />}
      footer={
        prefs ? (
          <FormFooter
            onCancel={onClose}
            onSave={() =>
              void store(prefs.available.filter((kind) => picked.has(kind)))
            }
            saveLabel={
              saving ? t("alerts.prefs.saving") : t("alerts.prefs.save")
            }
            saving={saving}
            dirty={dirty}
          />
        ) : undefined
      }
    >
      <div className={cn(PANEL.body, "flex flex-col gap-3")}>
        <p className="text-[12px] text-muted-foreground">
          {t("alerts.prefs.description")}
        </p>
        {loadFailed && (
          <NoticePanel
            tone="destructive"
            title={t("alerts.prefs.loadFailed")}
          />
        )}
        {error && <NoticePanel tone="destructive" title={error} />}
        {!prefs && !loadFailed && (
          <LoadingState label={t("alerts.prefs.loading")} />
        )}
        {prefs && (
          <>
            {prefs.isDefault && !dirty && (
              <p className="text-[12px]">{t("alerts.prefs.usingDefaults")}</p>
            )}
            {saved && !dirty && (
              <p className="text-[12px] text-muted-foreground">
                {t("alerts.prefs.saved")}
              </p>
            )}
            <div className="flex flex-col gap-1">
              {prefs.available.map((kind) => (
                <SwitchRow
                  key={kind}
                  label={t(`alerts.kinds.${kind}`)}
                  description={
                    prefs.defaults.includes(kind)
                      ? t("alerts.prefs.default")
                      : undefined
                  }
                  checked={picked.has(kind)}
                  disabled={saving}
                  onChange={(on) => toggle(kind, on)}
                />
              ))}
            </div>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={saving || (prefs.isDefault && !dirty)}
                onClick={() => void store(null)}
              >
                {t("alerts.prefs.reset")}
              </Button>
            </div>
          </>
        )}
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-[12px] text-muted-foreground">
            {t("alerts.prefs.channelsHint")}
          </p>
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void openChannels()}
            >
              <Send className="size-3.5" />
              {t("alerts.prefs.channels")}
            </Button>
          </div>
        </div>
      </div>
    </InlineView>
  );
}
