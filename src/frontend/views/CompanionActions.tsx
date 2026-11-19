import { useEffect, useMemo, useState } from "react";
import { Database, Globe, Search, Trash2, Activity } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
  type ShellApi,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  NoticePanel,
  SelectField,
  StatusBadge,
  TextField,
  useConfirm,
  type StatusTone,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  type DbLoginAnswer,
  type DnsRecord,
  type LogSearchAnswer,
  type UptimeMonitor,
} from "../api";
import { useCompanions } from "../companions";

/** The parts of a Coolify resource the companion actions need. */
export interface CompanionResource {
  uuid: string;
  name: string;
  kind: string;
  /** The resource's domains as Coolify lists them, usually URLs. */
  fqdns: string[];
}

type Shell = Pick<ShellApi, "openSingletonTab">;

/** The host names of a resource's domains. */
export function domainsOf(fqdns: string[]): string[] {
  const names = new Set<string>();
  for (const entry of fqdns) {
    const text = entry.trim();
    if (!text) continue;
    try {
      const url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`,
      );
      if (url.hostname) names.add(url.hostname.toLowerCase());
    } catch {
      // Not a domain.
    }
  }
  return [...names];
}

const MONITOR_TONE: Record<UptimeMonitor["status"], StatusTone> = {
  up: "ok",
  down: "bad",
  paused: "warn",
  pending: "info",
  unknown: "idle",
};

function DnsRecords({
  connectionId,
  resource,
  canConfigure,
}: {
  connectionId: number;
  resource: CompanionResource;
  canConfigure: boolean;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const confirm = useConfirm();
  const domains = domainsOf(resource.fqdns);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [fqdn, setFqdn] = useState(domains[0] ?? "");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listDnsRecords(connectionId, resource.uuid)
      .then((rows) => live && setRecords(rows))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid]);

  async function create() {
    setError(null);
    try {
      const made = await api.createDnsRecord(connectionId, resource.uuid, {
        fqdn,
        ...(content.trim() ? { content: content.trim() } : {}),
      });
      setRecords((rows) => [...rows, made]);
      setOpen(false);
      setContent("");
    } catch {
      setError(t("companions.dns.failed"));
    }
  }

  async function remove(record: DnsRecord) {
    const ok = await confirm({
      title: t("companions.dns.removeConfirm.title", { fqdn: record.fqdn }),
      description: t("companions.dns.removeConfirm.description"),
      confirmLabel: t("companions.dns.removeConfirm.confirm"),
      destructive: true,
    });
    if (!ok) return;
    const id = record.id;
    setError(null);
    try {
      await api.removeDnsRecord(connectionId, resource.uuid, id);
      setRecords((rows) => rows.filter((r) => r.id !== id));
    } catch {
      setError(t("companions.dns.removeFailed"));
    }
  }

  if (!domains.length && !records.length) return null;
  return (
    <div className="flex flex-col gap-2" data-companion="dns">
      {records.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {records.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="font-mono">
                {t("companions.dns.record", {
                  fqdn: r.fqdn,
                  type: r.type,
                  content: r.content,
                })}
              </span>
              {canConfigure && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(r)}
                >
                  <Trash2 className="size-3.5" />
                  {t("companions.dns.remove")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canConfigure && domains.length > 0 && !open && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Globe className="size-3.5" />
          {t("companions.dns.create")}
        </Button>
      )}
      {open && (
        <div className="flex flex-col gap-2">
          <SelectField
            label={t("companions.dns.domain")}
            value={fqdn}
            options={domains.map((d) => ({ value: d, label: d }))}
            onChange={setFqdn}
          />
          <TextField
            label={t("companions.dns.content")}
            hint={t("companions.dns.contentHint")}
            value={content}
            onChange={setContent}
            mono
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void create()}>
              {t("companions.dns.submit")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("companions.cancel")}
            </Button>
          </div>
        </div>
      )}
      {error && <NoticePanel tone="destructive" title={error} />}
    </div>
  );
}

function UptimeStatus({
  connectionId,
  resource,
  shell,
}: {
  connectionId: number;
  resource: CompanionResource;
  shell: Shell;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [monitors, setMonitors] = useState<UptimeMonitor[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .uptime(connectionId, resource.uuid)
      .then((a) => live && setMonitors(a?.monitors ?? []))
      .catch(() => live && setMonitors([]));
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid]);

  return (
    <div className="flex flex-col gap-1 text-xs" data-companion="uptime">
      <p className="font-medium">{t("companions.uptime.title")}</p>
      {monitors && monitors.length === 0 && (
        <p className="text-muted-foreground">{t("companions.uptime.none")}</p>
      )}
      {monitors?.map((m) => (
        <p key={m.id} className="flex items-center gap-2">
          <StatusBadge tone={MONITOR_TONE[m.status]}>
            {t(`companions.uptime.status.${m.status}`)}
          </StatusBadge>
          <span>{m.name}</span>
        </p>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => shell.openSingletonTab("uptime")}
        >
          <Activity className="size-3.5" />
          {t("companions.uptime.open")}
        </Button>
      </div>
      <p className="text-muted-foreground">{t("companions.uptime.why")}</p>
    </div>
  );
}

function LogSearch({
  connectionId,
  resource,
}: {
  connectionId: number;
  resource: CompanionResource;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [answer, setAnswer] = useState<LogSearchAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setError(null);
    try {
      setAnswer(await api.logSearch(connectionId, resource.uuid));
    } catch {
      setError(t("companions.logs.failed"));
    }
  }

  return (
    <div className="flex flex-col gap-2" data-companion="log-search">
      <div>
        <Button size="sm" variant="outline" onClick={() => void search()}>
          <Search className="size-3.5" />
          {t("companions.logs.search")}
        </Button>
      </div>
      {answer && (
        <div className="flex flex-col gap-1 text-xs">
          <p className="text-muted-foreground">{t("companions.logs.source")}</p>
          {answer.results.length === 0 ? (
            <p>{t("companions.logs.none")}</p>
          ) : (
            <pre className="max-h-64 overflow-auto font-mono whitespace-pre-wrap">
              {answer.results
                .map((r) =>
                  [r.time, r.host, r.message].filter(Boolean).join("  "),
                )
                .join("\n")}
            </pre>
          )}
        </div>
      )}
      {error && <NoticePanel tone="destructive" title={error} />}
    </div>
  );
}

function DatabaseLogin({
  connectionId,
  resource,
  shell,
}: {
  connectionId: number;
  resource: CompanionResource;
  shell: Shell;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [answer, setAnswer] = useState<DbLoginAnswer | null>(null);

  useEffect(() => {
    let live = true;
    api
      .dbLogin(connectionId, resource.uuid)
      .then((a) => live && setAnswer(a))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid]);

  if (!answer) return null;
  return (
    <div className="flex flex-col gap-1 text-xs" data-companion="databases">
      <p>
        {answer.saved
          ? t("companions.databases.saved")
          : t("companions.databases.notSaved")}
      </p>
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => shell.openSingletonTab("databases")}
        >
          <Database className="size-3.5" />
          {t("companions.databases.open")}
        </Button>
      </div>
    </div>
  );
}

/**
 * What companion plugins add to a Coolify resource: Create DNS record,
 * Uptime status with a link to Uptime, Search logs across servers and, for a
 * database, whether Databases has a saved login. Each part shows only while
 * its plugin runs, and only to people whose permission allows its action.
 */
export function CompanionActions({
  connectionId,
  resource,
  shell,
}: {
  connectionId: number;
  resource: CompanionResource;
  shell: Shell;
}) {
  const map = useCompanions();
  const canOperate = usePermission("operate");
  const canConfigure = usePermission("configure");
  if (!map) return null;
  const isDatabase =
    resource.kind === "database" || resource.kind === "service-database";
  const parts = [
    map.dns && (
      <DnsRecords
        key="dns"
        connectionId={connectionId}
        resource={resource}
        canConfigure={canConfigure}
      />
    ),
    map.uptime && resource.fqdns.length > 0 && (
      <UptimeStatus
        key="uptime"
        connectionId={connectionId}
        resource={resource}
        shell={shell}
      />
    ),
    map.logSearch && canOperate && (
      <LogSearch key="logs" connectionId={connectionId} resource={resource} />
    ),
    map.databases && isDatabase && (
      <DatabaseLogin
        key="databases"
        connectionId={connectionId}
        resource={resource}
        shell={shell}
      />
    ),
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="flex flex-col gap-3">{parts}</div>;
}
