import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useConfirmFor } from "../confirm";

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

/**
 * One view's answer, kept with the target it was read for (connection,
 * resource uuid and revision) and guarded by a request generation: a new
 * target or a newer request drops every answer still on its way, and another
 * target's answer is never shown.
 */
export function useTargetAnswer<T>(target: string) {
  const [state, setState] = useState<{ target: string; value: T | null }>({
    target,
    value: null,
  });
  const generation = useRef(0);
  const current = useRef(target);
  if (current.current !== target) {
    current.current = target;
    generation.current += 1;
  }
  /** Starts a request; the answer it returns lands only while it is the newest. */
  const begin = useCallback(() => {
    const mine = ++generation.current;
    const forTarget = current.current;
    return (value: T | null) => {
      if (mine === generation.current && forTarget === current.current) {
        setState({ target: forTarget, value });
      }
    };
  }, []);
  return [state.target === target ? state.value : null, begin] as const;
}

/** The key every companion view's state is read for. */
function targetOf(
  connectionId: number,
  resource: CompanionResource,
  revision: string | null | undefined,
): string {
  return `${connectionId}:${resource.uuid}:${revision ?? ""}`;
}

function DnsRecords({
  connectionId,
  resource,
  canConfigure,
  target,
}: {
  connectionId: number;
  resource: CompanionResource;
  canConfigure: boolean;
  target: string;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const domains = domainsOf(resource.fqdns);
  // Everything here belongs to one target: rows, form and errors read from
  // another connection, resource or revision are never shown or acted on. A
  // new target remounts this view; a confirm the old one opened then answers
  // into an unmounted view and runs nothing.
  const { confirm, still } = useConfirmFor(target);
  // The generation of the list read; a change since it began drops it.
  const listRead = useRef(0);
  const [records, setRecords] = useState<{
    target: string;
    rows: DnsRecord[];
  }>({ target, rows: [] });
  const rows = records.target === target ? records.rows : [];
  const [open, setOpen] = useState(false);
  const firstDomain = domains[0] ?? "";
  const [fqdn, setFqdn] = useState(firstDomain);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  // What the form and rows were last reset for. The state above starts out
  // reset for the first render's target, so the first effect resets nothing:
  // a click that lands before it runs (the button is on screen from the
  // first commit) must not be undone.
  const resetFor = useRef(`${target}\n${firstDomain}`);

  useEffect(() => {
    let live = true;
    const key = `${target}\n${firstDomain}`;
    if (resetFor.current !== key) {
      resetFor.current = key;
      setRecords({ target, rows: [] });
      setOpen(false);
      setFqdn(firstDomain);
      setContent("");
      setError(null);
    }
    // A create or remove that lands first bumps listRead, so this older
    // answer can't undo it.
    const mine = ++listRead.current;
    api
      .listDnsRecords(connectionId, resource.uuid)
      .then(
        (list) =>
          live &&
          mine === listRead.current &&
          setRecords({ target, rows: list }),
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, connectionId, resource.uuid, target, firstDomain]);

  /** Keeps a change only while the view still shows the target it was for. */
  function update(forTarget: string, fn: (rows: DnsRecord[]) => DnsRecord[]) {
    listRead.current += 1;
    setRecords((prev) =>
      prev.target === forTarget
        ? { target: forTarget, rows: fn(prev.rows) }
        : prev,
    );
  }

  /**
   * Reads the list again after a create or remove. Only the newest read
   * lands, so an older answer (the first read, still out when the change
   * landed) is dropped and can't lose a record: this one has them all.
   */
  function reload(forTarget: string) {
    const mine = ++listRead.current;
    api
      .listDnsRecords(connectionId, resource.uuid)
      .then((list) => {
        if (still(forTarget) && mine === listRead.current) {
          setRecords({ target: forTarget, rows: list });
        }
      })
      .catch(() => undefined);
  }

  async function create() {
    const forTarget = target;
    setError(null);
    try {
      const made = await api.createDnsRecord(connectionId, resource.uuid, {
        fqdn,
        ...(content.trim() ? { content: content.trim() } : {}),
      });
      update(forTarget, (list) => [...list, made]);
      reload(forTarget);
      if (!still(forTarget)) return;
      setOpen(false);
      setContent("");
    } catch {
      if (still(forTarget)) setError(t("companions.dns.failed"));
    }
  }

  async function remove(record: DnsRecord) {
    const forTarget = target;
    const ok = await confirm({
      title: t("companions.dns.removeConfirm.title", { fqdn: record.fqdn }),
      description: t("companions.dns.removeConfirm.description"),
      confirmLabel: t("companions.dns.removeConfirm.confirm"),
      destructive: true,
    });
    // The view moved to another resource while the confirm was open: what
    // was confirmed is no longer what is shown, so nothing runs.
    if (!ok) return;
    const id = record.id;
    setError(null);
    try {
      await api.removeDnsRecord(connectionId, resource.uuid, id);
      update(forTarget, (list) => list.filter((r) => r.id !== id));
      reload(forTarget);
    } catch {
      if (still(forTarget)) {
        setError(t("companions.dns.removeFailed"));
      }
    }
  }

  if (!domains.length && !rows.length) return null;
  return (
    <div className="flex flex-col gap-2" data-companion="dns">
      {rows.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {rows.map((r) => (
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
  target,
}: {
  connectionId: number;
  resource: CompanionResource;
  shell: Shell;
  target: string;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [read, begin] = useTargetAnswer<
    { monitors: UptimeMonitor[] } | { failed: true }
  >(target);

  useEffect(() => {
    const land = begin();
    api
      .uptime(connectionId, resource.uuid)
      .then((a) => land({ monitors: a?.monitors ?? [] }))
      // A failed read proves nothing about the monitors: it says so.
      .catch(() => land({ failed: true }));
  }, [api, begin, connectionId, resource.uuid, target]);
  const monitors = read && "monitors" in read ? read.monitors : null;

  return (
    <div className="flex flex-col gap-1 text-xs" data-companion="uptime">
      <p className="font-medium">{t("companions.uptime.title")}</p>
      {read && "failed" in read && (
        <p className="text-muted-foreground">{t("companions.uptime.failed")}</p>
      )}
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
  target,
}: {
  connectionId: number;
  resource: CompanionResource;
  target: string;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [result, begin] = useTargetAnswer<
    { answer: LogSearchAnswer } | { error: string }
  >(target);

  async function search() {
    const land = begin();
    land(null);
    try {
      land({ answer: await api.logSearch(connectionId, resource.uuid) });
    } catch {
      land({ error: t("companions.logs.failed") });
    }
  }

  const answer = result && "answer" in result ? result.answer : null;
  const error = result && "error" in result ? result.error : null;
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
  target,
}: {
  connectionId: number;
  resource: CompanionResource;
  shell: Shell;
  target: string;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const [answer, begin] = useTargetAnswer<DbLoginAnswer>(target);

  useEffect(() => {
    const land = begin();
    api
      .dbLogin(connectionId, resource.uuid)
      .then((a) => land(a ?? null))
      .catch(() => land(null));
  }, [api, begin, connectionId, resource.uuid, target]);

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
 * Each part's state belongs to one connection, resource and revision: a new
 * one remounts it, and its answers for an older one are dropped.
 */
export function CompanionActions({
  connectionId,
  resource,
  shell,
  revision,
}: {
  connectionId: number;
  resource: CompanionResource;
  shell: Shell;
  /** The connection's target hash; a new one reads everything again. */
  revision?: string | null;
}) {
  const map = useCompanions();
  const canOperate = usePermission("operate");
  const canConfigure = usePermission("configure");
  if (!map) return null;
  const target = targetOf(connectionId, resource, revision);
  const isDatabase =
    resource.kind === "database" || resource.kind === "service-database";
  const parts = [
    map.dns && (
      <DnsRecords
        key={`dns:${target}`}
        connectionId={connectionId}
        resource={resource}
        canConfigure={canConfigure}
        target={target}
      />
    ),
    map.uptime && resource.fqdns.length > 0 && (
      <UptimeStatus
        key={`uptime:${target}`}
        connectionId={connectionId}
        resource={resource}
        shell={shell}
        target={target}
      />
    ),
    map.logSearch && canOperate && (
      <LogSearch
        key={`logs:${target}`}
        connectionId={connectionId}
        resource={resource}
        target={target}
      />
    ),
    map.databases && isDatabase && (
      <DatabaseLogin
        key={`databases:${target}`}
        connectionId={connectionId}
        resource={resource}
        shell={shell}
        target={target}
      />
    ),
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="flex flex-col gap-3">{parts}</div>;
}
