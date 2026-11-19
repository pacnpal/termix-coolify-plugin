import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { PackageCheck, Power, RefreshCw } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Input,
  Label,
  LoadingState,
  NoticePanel,
  StatusBadge,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  failureOf,
  type PatchItem,
  type PatchStatus,
  type ServerUpdates as UpdatesAnswer,
  type UpdatesVia,
} from "../api";
import type { HostLink } from "../linked";

type T = ReturnType<typeof useTranslation>["t"];

const KNOWN_ERRORS = new Set([
  "not-linked",
  "host-forbidden",
  "confirm-required",
  "name-mismatch",
  "needs-sudo",
  "unsupported-os",
  "ssh-failed",
  "companion-failed",
  "forbidden",
]);

function errorText(t: T, err: unknown): string {
  const failure = failureOf(err);
  if (failure && KNOWN_ERRORS.has(failure.cause)) {
    return t(`updates.errors.${failure.cause}`);
  }
  if (failure?.cause) return t(`causes.${failure.cause}`);
  return t("updates.errors.failed");
}

function when(t: T, iso: string | null): string {
  if (!iso) return t("updates.never");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function summaryOf(t: T, status: PatchStatus): string {
  return status.security === null
    ? t("updates.summaryUnknownSecurity", { count: status.updates })
    : t("updates.summary", {
        count: status.updates,
        security: status.security,
      });
}

const items = (status: PatchStatus | null): PatchItem[] =>
  Array.isArray(status?.items) ? status.items : [];

function RiskBadges({ item }: { item: PatchItem }) {
  const { t } = useTranslation();
  return (
    <>
      {item.risk === "docker" && (
        <StatusBadge tone="warn">{t("updates.risk.docker")}</StatusBadge>
      )}
      {item.risk === "kernel" && (
        <StatusBadge tone="info">{t("updates.risk.kernel")}</StatusBadge>
      )}
      {item.risk === "system" && (
        <StatusBadge tone="info">{t("updates.risk.system")}</StatusBadge>
      )}
      {item.security && (
        <StatusBadge tone="bad">{t("updates.risk.security")}</StatusBadge>
      )}
    </>
  );
}

/** The packages an install would change, Docker restarts called out. */
function InstallConfirm({
  server,
  status,
  busy,
  onConfirm,
  onCancel,
}: {
  server: string;
  status: PatchStatus;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const list = items(status);
  const docker = list.some((i) => i.risk === "docker");
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="border-border flex flex-col gap-2 rounded-md border p-3"
    >
      <p id={titleId} className="font-medium">
        {t("updates.installConfirm.title", {
          count: status.updates,
          server,
        })}
      </p>
      {docker && (
        <NoticePanel
          tone="warning"
          title={t("updates.installConfirm.dockerWarning")}
        />
      )}
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs">
        {list.map((item) => (
          <li
            key={item.package}
            data-package={item.package}
            data-risk={item.risk === "docker" ? "docker" : undefined}
            className={
              item.risk === "docker"
                ? "bg-warning/10 flex flex-wrap items-center gap-2 rounded px-1 font-medium"
                : "flex flex-wrap items-center gap-2 px-1"
            }
          >
            <span className="font-mono">{item.package}</span>
            <span className="text-muted-foreground">
              {item.currentVersion} → {item.newVersion}
            </span>
            <RiskBadges item={item} />
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? t("updates.installing") : t("updates.installConfirm.confirm")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          {t("updates.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Reboot asks for the server's exact name and says what goes down. */
function RebootConfirm({
  server,
  busy,
  onConfirm,
  onCancel,
}: {
  server: string;
  busy: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const matches = typed === server && server !== "";
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="border-destructive/50 flex flex-col gap-2 rounded-md border p-3"
    >
      <p id={titleId} className="font-medium">
        {t("updates.rebootConfirm.title", { server })}
      </p>
      <NoticePanel
        tone="destructive"
        title={t("updates.rebootConfirm.warning", { server })}
      />
      <Label htmlFor={inputId}>
        {t("updates.rebootConfirm.typeName", { server })}
      </Label>
      <Input
        id={inputId}
        value={typed}
        autoComplete="off"
        onChange={(e) => setTyped(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={!matches || busy}
          onClick={() => {
            if (matches) onConfirm(typed);
          }}
        >
          {busy ? t("updates.rebooting") : t("updates.rebootConfirm.confirm")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          {t("updates.cancel")}
        </Button>
      </div>
    </div>
  );
}

type Busy = "check" | "install" | "reboot" | null;

/**
 * A Linked host's pending package updates: Coolify's last check, or the
 * plugin's own when newer, with Check now, Install updates and Reboot.
 */
export function ServerUpdates({ link }: { link: HostLink }) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const canOperate = usePermission("operate");
  const canAdminister = usePermission("administer");
  const [data, setData] = useState<UpdatesAnswer | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [asking, setAsking] = useState<"install" | "reboot" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { connectionId, serverUuid } = link;
  const load = useCallback(async () => {
    try {
      const answer = await api.serverUpdates(connectionId, serverUuid);
      setData(answer && typeof answer === "object" ? answer : null);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [api, connectionId, serverUuid]);

  useEffect(() => {
    void load();
  }, [load]);

  const serverName = data?.server?.name ?? "";
  const latest: PatchStatus | null = data?.fresh ?? data?.coolify ?? null;
  const via: UpdatesVia | "coolify" | null = data?.fresh
    ? (data.via ?? null)
    : data?.coolify
      ? "coolify"
      : null;
  const dockerCount = items(latest).filter((i) => i.risk === "docker").length;

  async function check() {
    setBusy("check");
    setError(null);
    setNotice(null);
    try {
      const result = await api.checkServerUpdates(connectionId, serverUuid);
      setData((prev) =>
        prev ? { ...prev, fresh: result.fresh, via: result.via } : prev,
      );
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    setBusy("install");
    setError(null);
    try {
      const result = await api.installServerUpdates(connectionId, serverUuid);
      setAsking(null);
      setNotice(
        result.pending
          ? t("updates.pending")
          : t(`updates.installed.${result.via}`, { summary: result.summary }),
      );
      await load();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }

  async function reboot(name: string) {
    setBusy("reboot");
    setError(null);
    try {
      await api.rebootServer(connectionId, serverUuid, name);
      setAsking(null);
      setNotice(t("updates.rebootStarted", { server: serverName }));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="coolify-updates" className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-medium">
        <PackageCheck className="size-3.5" />
        {t("updates.title")}
      </p>
      {loadFailed && <p className="text-xs">{t("updates.loadFailed")}</p>}
      {!data && !loadFailed && (
        <LoadingState compact label={t("updates.loading")} />
      )}
      {data && !latest && (
        <p className="text-muted-foreground text-xs">{t("updates.none")}</p>
      )}
      {latest && (
        <div className="flex flex-col gap-1 text-xs">
          <p className="flex flex-wrap items-center gap-2">
            <span>
              {latest.updates === 0
                ? t("updates.upToDate")
                : summaryOf(t, latest)}
            </span>
            {latest.rebootRequired && (
              <StatusBadge tone="warn">
                {t("updates.rebootRequired")}
              </StatusBadge>
            )}
            {dockerCount > 0 && (
              <StatusBadge tone="warn">
                {t("updates.dockerRisk", { count: dockerCount })}
              </StatusBadge>
            )}
          </p>
          {via && (
            <p className="text-muted-foreground">
              {t(`updates.source.${via}`, {
                when: when(t, latest.checkedAt),
              })}
            </p>
          )}
          {latest.error && (
            <p>{t("updates.checkError", { error: latest.error })}</p>
          )}
          {data?.fresh && data.coolify && (
            <p className="text-muted-foreground">
              {t("updates.coolifyRecord", {
                when: when(t, data.coolify.checkedAt),
                summary: summaryOf(t, data.coolify),
              })}
            </p>
          )}
        </div>
      )}
      {notice && <NoticePanel title={notice} />}
      {error && <NoticePanel tone="destructive" title={error} />}
      {data && asking === "install" && latest && (
        <InstallConfirm
          server={serverName}
          status={latest}
          busy={busy === "install"}
          onConfirm={() => void install()}
          onCancel={() => setAsking(null)}
        />
      )}
      {data && asking === "reboot" && (
        <RebootConfirm
          server={serverName}
          busy={busy === "reboot"}
          onConfirm={(name) => void reboot(name)}
          onCancel={() => setAsking(null)}
        />
      )}
      {data && !asking && (canOperate || canAdminister) && (
        <div className="flex flex-wrap gap-2">
          {canOperate && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void check()}
            >
              <RefreshCw className="size-3.5" />
              {busy === "check" ? t("updates.checking") : t("updates.check")}
            </Button>
          )}
          {canOperate && latest && latest.updates > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => setAsking("install")}
            >
              {t("updates.install")}
            </Button>
          )}
          {canAdminister && serverName && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => setAsking("reboot")}
            >
              <Power className="size-3.5" />
              {t("updates.reboot")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
