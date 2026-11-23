import { useCallback, useEffect, useRef, useState } from "react";
import { Webhook, WebhookOff } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, NoticePanel, PANEL, cn } from "@termix-ssh/plugin-sdk/ui";
import type { Api, Connection, WebhookStatus } from "../api";
import { useConfirmFor } from "../confirm";
import { describeFailure, FormError } from "./ConnectionForm";

type Done = "configured" | "declined" | "disabled" | "notSet";

/**
 * "Set up webhook" in a connection's settings (#92): reads the team's
 * webhook, sets it up with one click, asks before replacing someone else's
 * and turns ours off. The parent keys it by the connection's id and
 * revision, so a changed target starts over; a request generation keeps
 * only the newest read, and nothing answered after the view moved on is
 * shown. No answer ever holds the URL or its token.
 */
export function WebhookSetup({
  api,
  connection,
}: {
  api: Api;
  connection: Pick<Connection, "id" | "revision">;
}) {
  const { t } = useTranslation();
  const W = "connections.webhook";
  const target = `webhook:${connection.id}:${connection.revision}`;
  const { confirm, still } = useConfirmFor(target);
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reads = useRef(0);

  const load = useCallback(async () => {
    const generation = ++reads.current;
    try {
      const fresh = await api.webhookStatus(connection.id);
      if (generation !== reads.current || !still(target)) return;
      setStatus(fresh);
      setLoadFailed(false);
    } catch (err) {
      if (generation !== reads.current || !still(target)) return;
      setLoadFailed(true);
      setError(describeFailure(t, err));
    }
  }, [api, connection.id, still, target, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one change; its outcome lands only while the view is on target. */
  async function act(work: () => Promise<Done | null>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const outcome = await work();
      if (!still(target)) return;
      setDone(outcome);
      await load();
    } catch (err) {
      if (still(target)) setError(describeFailure(t, err));
    } finally {
      if (still(target)) setBusy(false);
    }
  }

  const setup = () =>
    act(async () => {
      const first = await api.setupWebhook(connection.id);
      if (first.outcome === "configured") return "configured";
      const yes = await confirm({
        title: t(`${W}.replace.title`),
        description: t(`${W}.replace.description`, { current: first.current }),
        confirmLabel: t(`${W}.replace.confirm`),
        cancelLabel: t(`${W}.cancel`),
        destructive: true,
      });
      if (!yes) return still(target) ? "declined" : null;
      await api.replaceWebhook(connection.id);
      return "configured";
    });

  const disable = () =>
    act(async () => {
      const yes = await confirm({
        title: t(`${W}.disable.title`),
        description: t(`${W}.disable.description`),
        confirmLabel: t(`${W}.disable.confirm`),
        cancelLabel: t(`${W}.cancel`),
        destructive: true,
      });
      if (!yes) return null;
      const answer = await api.disableWebhook(connection.id);
      return answer.outcome === "disabled" ? "disabled" : "notSet";
    });

  return (
    <div className={cn(PANEL.body, "flex flex-col gap-3")}>
      <div className="flex flex-col gap-1 text-[12px]">
        <span className="font-medium text-foreground">{t(`${W}.title`)}</span>
        <p className="text-muted-foreground">{t(`${W}.description`)}</p>
      </div>
      <NoticePanel tone="warning" title={t(`${W}.privateWarning`)} />
      {status?.basePrivate && status.base && (
        <NoticePanel
          tone="destructive"
          title={t(`${W}.basePrivate`, { base: status.base })}
        />
      )}
      {status && !status.base && (
        <NoticePanel tone="warning" title={t(`${W}.noBase`)} />
      )}
      <p className="text-[12px] text-muted-foreground">
        {status
          ? t(`${W}.state.${status.state}`, { current: status.current ?? "" })
          : loadFailed
            ? t(`${W}.loadFailed`)
            : t(`${W}.loading`)}
      </p>
      {status && status.state === "ours" && !status.enabled && (
        <p className="text-[12px] text-muted-foreground">
          {t(`${W}.disabledNote`)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void setup()}>
          <Webhook className="size-3.5" />
          {busy ? t(`${W}.working`) : t(`${W}.setup`)}
        </Button>
        {status?.state === "ours" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void disable()}
          >
            <WebhookOff className="size-3.5" />
            {t(`${W}.disable.action`)}
          </Button>
        )}
      </div>
      {done && <NoticePanel tone="default" title={t(`${W}.${done}`)} />}
      <FormError message={error} />
    </div>
  );
}
