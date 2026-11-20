import { useEffect, useMemo, useRef, useState } from "react";
import { Database } from "lucide-react";
import {
  usePluginApi,
  useTranslation,
  type ShellApi,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, StatusBadge } from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  type BackupsFailedAnswer,
  type DbLoginsAnswer,
  type HostMetricsAnswer,
  type SecurityAnswer,
} from "../api";
import { useCompanions } from "../companions";
import type { HostLink } from "../linked";

/**
 * Loads one answer while `on`; a failed read leaves it null, which hides it.
 * The answer is kept with the key it was read for, so another server's (or
 * an older target's) answer is never shown, and only the newest load lands.
 */
function useAnswer<T>(on: boolean, load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ key: string; value: T | null }>({
    key,
    value: null,
  });
  // The latest loader; `key` names what it reads, so a new key loads again.
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    setState({ key, value: null });
    if (!on) return;
    let live = true;
    loader
      .current()
      .then((v) => live && setState({ key, value: v ?? null }))
      .catch(() => live && setState({ key, value: null }));
    return () => {
      live = false;
    };
  }, [on, key]);
  return state.key === key ? state.value : null;
}

function securityTone(answer: SecurityAnswer) {
  if ((answer.critical ?? 0) > 0) return "bad" as const;
  if (answer.score !== null && answer.score < 50) return "warn" as const;
  return "ok" as const;
}

/**
 * What companion plugins add to a Linked host's Coolify card: the Security
 * Center score, a Host Metrics card with Coolify's resource counts, failed
 * backup jobs and the Databases saved-login link. Each part shows only while
 * its plugin runs.
 */
export function HostCompanions({
  link,
  shell,
  revision,
}: {
  link: HostLink;
  shell: Pick<ShellApi, "openSingletonTab">;
  /** The connection's target hash: a new one reads everything again. */
  revision?: string | null;
}) {
  const { t } = useTranslation();
  const client = usePluginApi();
  const api = useMemo(() => createApi(client), [client]);
  const map = useCompanions();
  const { connectionId, serverUuid } = link;
  const key = `${connectionId}:${serverUuid}:${revision ?? ""}`;

  const security = useAnswer<SecurityAnswer>(
    !!map?.securityCenter,
    () => api.security(connectionId, serverUuid),
    key,
  );
  const metrics = useAnswer<HostMetricsAnswer>(
    !!map?.hostMetrics,
    () => api.hostMetrics(connectionId, serverUuid),
    key,
  );
  const backups = useAnswer<BackupsFailedAnswer>(
    !!map?.backups,
    () => api.backupsFailed(connectionId, serverUuid),
    key,
  );
  const logins = useAnswer<DbLoginsAnswer>(
    !!map?.databases,
    () => api.dbLogins(connectionId, serverUuid),
    key,
  );

  if (!security && !metrics && !backups && !logins) return null;
  return (
    <div className="flex flex-col gap-2 text-xs" data-companions="host">
      {security && (
        <p className="flex items-center gap-2" data-companion="security">
          <span>{t("companions.security.label")}</span>
          <StatusBadge tone={securityTone(security)}>
            {security.score === null
              ? t("companions.security.noScore")
              : t("companions.security.score", { score: security.score })}
          </StatusBadge>
          {(security.critical ?? 0) > 0 && (
            <StatusBadge tone="bad">
              {t("companions.security.critical", { count: security.critical })}
            </StatusBadge>
          )}
        </p>
      )}
      {metrics && (
        <div className="rounded-md border p-2" data-companion="host-metrics">
          <p className="font-medium">{t("companions.metrics.title")}</p>
          <p>
            {t("companions.metrics.counts", {
              applications: metrics.applications,
              services: metrics.services,
              databases: metrics.databases,
            })}
          </p>
        </div>
      )}
      {backups && (
        <div data-companion="backups">
          <p className="font-medium">{t("companions.backups.title")}</p>
          {backups.jobs.length === 0 ? (
            <p className="text-muted-foreground">
              {t("companions.backups.none")}
            </p>
          ) : (
            <ul>
              {backups.jobs.map((job) => (
                <li key={job.id} className="flex items-center gap-2">
                  <StatusBadge tone="bad">
                    {t("companions.backups.failed")}
                  </StatusBadge>
                  {job.failedAt
                    ? t("companions.backups.job", {
                        name: job.name,
                        at: job.failedAt,
                      })
                    : job.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {logins && logins.databases.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          data-companion="databases"
        >
          <span>
            {t("companions.databases.summary", {
              saved: logins.databases.filter((d) => d.saved).length,
              total: logins.databases.length,
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => shell.openSingletonTab("databases")}
          >
            <Database className="size-3.5" />
            {t("companions.databases.open")}
          </Button>
        </div>
      )}
    </div>
  );
}
