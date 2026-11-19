import { and, desc, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto } from "../coolify/dto.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import { dbClient, type Tables } from "../db.js";
import type { Sync } from "../sync/service.js";
import {
  backupsFailed,
  databaseLogins,
  dnsCreate,
  dnsRemove,
  logSearch,
  securityCheck,
  uptimeMonitors,
  uptimeSetPaused,
  type DnsType,
  type FailedBackup,
  type LogLine,
  type Monitor,
  type SavedLogin,
  type SecuritySummary,
} from "./adapters.js";
import {
  CompanionError,
  companions,
  requireCompanion,
  type CompanionMap,
} from "./detect.js";

/** The grant level a companion feature needs, besides the Termix permission of the same name. */
export type Level = "view" | "operate" | "configure";

const RANK: Record<AccessLevel, number> = {
  view: 1,
  operate: 2,
  configure: 3,
  owner: 4,
};

const UUID = /^[A-Za-z0-9_-]{1,64}$/;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^(?=.*:)[0-9a-f:.]{2,45}$/i;
const DNS_TYPES: ReadonlySet<string> = new Set(["A", "AAAA", "CNAME"]);

/** A DNS record made here, as routes return it. Never holds the DNS plugin's handle. */
export interface DnsRecordView {
  id: number;
  fqdn: string;
  type: DnsType;
  content: string;
  createdAt: string;
}

interface DnsRow {
  id: number;
  connectionId: number;
  resourceUuid: string;
  handle: unknown;
  fqdn: string;
  createdAt: string | Date;
}

/** What the handle column holds: the DNS plugin's handle, and what was asked for. */
interface StoredHandle {
  record: unknown;
  type: DnsType;
  content: string;
}

export interface DnsCreateBody {
  fqdn?: unknown;
  type?: unknown;
  content?: unknown;
}

function invalid(message: string): ConnectionError {
  return new ConnectionError("invalid-input", message);
}

function forbidden(message: string): ConnectionError {
  return new ConnectionError("forbidden", message);
}

const resourceNotFound = () =>
  new ConnectionError("not-found", "Coolify resource not found");

const notLinked = () =>
  new ConnectionError("not-linked", "This Coolify server has no Linked host");

/** The host names of a resource's domains, lowercase. */
export function hostnamesOf(fqdns: string[]): Set<string> {
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
      // Not a URL; not a domain the resource answers on.
    }
  }
  return names;
}

function hostnameOfUrl(text: string): string | null {
  try {
    return new URL(text).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function parseHandle(value: unknown): StoredHandle | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const stored = raw as Partial<StoredHandle>;
  if (!("record" in stored)) return null;
  return {
    record: stored.record,
    type: (DNS_TYPES.has(String(stored.type)) ? stored.type : "A") as DnsType,
    content: typeof stored.content === "string" ? stored.content : "",
  };
}

function toDnsView(row: DnsRow): DnsRecordView {
  const handle = parseHandle(row.handle);
  return {
    id: row.id,
    fqdn: row.fqdn,
    type: handle?.type ?? "A",
    content: handle?.content ?? "",
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
  };
}

function contentFits(type: DnsType, content: string): boolean {
  if (type === "A") return IPV4.test(content);
  if (type === "AAAA") return IPV6.test(content);
  return HOSTNAME.test(content);
}

function typeFor(content: string): DnsType | null {
  if (IPV4.test(content)) return "A";
  if (IPV6.test(content)) return "AAAA";
  return HOSTNAME.test(content) ? "CNAME" : null;
}

function isDatabase(resource: ResourceDto): boolean {
  return resource.kind === "database" || resource.kind === "service-database";
}

/** Whether a saved login is for this Coolify database: by its name or uuid. */
function loginMatches(login: SavedLogin, resource: ResourceDto): boolean {
  const names = [login.name, login.database].filter(
    (v): v is string => typeof v === "string",
  );
  return names.some(
    (name) => name === resource.name || name.includes(resource.uuid),
  );
}

function withoutHost(login: SavedLogin) {
  return {
    id: login.id,
    name: login.name,
    engine: login.engine,
    database: login.database,
    username: login.username,
  };
}

/**
 * The companion-plugin features. Every method acts for ctx.currentActor() and
 * checks, in order: the Termix permission, the actor's access to the
 * connection (owner, or a grant at the level the feature needs), that the
 * companion runs, and, for anything on a Linked host, the actor's own access
 * to that host. Nothing sent to a companion carries a token or secret.
 */
export function createCompanions(
  ctx: PluginContext,
  deps: { tables: Tables; connections: Connections; sync: Sync },
) {
  const t = deps.tables;
  const { connections, sync } = deps;

  async function need(connectionId: number, level: Level): Promise<void> {
    const permitted = await ctx.rbac.has(level).catch(() => false);
    if (!permitted) throw forbidden(`This needs coolify.${level}`);
    const access = await connections.access(connectionId);
    if (!access) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    if (RANK[access] < RANK[level]) {
      throw forbidden(`Your grant on this connection doesn't allow this`);
    }
  }

  async function resourceOf(
    connectionId: number,
    uuid: string,
  ): Promise<ResourceDto> {
    if (!UUID.test(uuid)) throw resourceNotFound();
    const api = await connections.api(connectionId);
    const [applications, services, databases] = await Promise.all([
      api.applications(),
      api.services(),
      api.databases(),
    ]);
    const found = [...applications, ...databases, ...services].find(
      (r) => r.uuid === uuid,
    );
    if (!found) throw resourceNotFound();
    return found;
  }

  async function resourcesOn(
    connectionId: number,
    serverUuid: string,
  ): Promise<ResourceDto[]> {
    const api = await connections.api(connectionId);
    const [applications, services, databases] = await Promise.all([
      api.applications(),
      api.services(),
      api.databases(),
    ]);
    return [...applications, ...databases, ...services].filter(
      (r) => r.serverUuid === serverUuid,
    );
  }

  /** The Linked host of a server, when the actor may see it. Fails closed. */
  async function hostOf(
    connectionId: number,
    serverUuid: string | null,
  ): Promise<number> {
    if (!serverUuid || !UUID.test(serverUuid)) throw notLinked();
    const hostId = await sync.linkedHostFor(connectionId, serverUuid);
    if (!hostId) throw notLinked();
    const access = await ctx.hosts
      .checkAccess(hostId, "view")
      .catch(() => null);
    if (access?.hasAccess !== true) {
      throw forbidden("You have no access to this server's Linked host");
    }
    return hostId;
  }

  async function storedRecord(
    connectionId: number,
    uuid: string,
    recordId: number,
  ): Promise<DnsRow> {
    if (!Number.isSafeInteger(recordId) || recordId <= 0 || !UUID.test(uuid)) {
      throw new CompanionError("dns-record-not-found", "dns");
    }
    const [row] = (await (
      await dbClient(ctx)
    )
      .select()
      .from(t.dnsRecords)
      .where(
        and(
          eq(t.dnsRecords.id, recordId),
          eq(t.dnsRecords.connectionId, connectionId),
          eq(t.dnsRecords.resourceUuid, uuid),
        ),
      )
      .limit(1)) as DnsRow[];
    if (!row) throw new CompanionError("dns-record-not-found", "dns");
    return row;
  }

  async function matchedMonitors(
    connectionId: number,
    uuid: string,
  ): Promise<Monitor[]> {
    const resource = await resourceOf(connectionId, uuid);
    const names = hostnamesOf(resource.fqdns);
    if (!names.size) return [];
    return (await uptimeMonitors(ctx)).filter((m) => {
      const host = hostnameOfUrl(m.url);
      return host !== null && names.has(host);
    });
  }

  return {
    /** Which companion plugins run. Needs only coolify.view. */
    async map(): Promise<CompanionMap> {
      const permitted = await ctx.rbac.has("view").catch(() => false);
      if (!permitted) throw forbidden("This needs coolify.view");
      return companions(ctx);
    },

    /** The DNS records made here for a resource. */
    async dnsList(
      connectionId: number,
      uuid: string,
    ): Promise<DnsRecordView[]> {
      await need(connectionId, "view");
      await requireCompanion(ctx, "dns");
      if (!UUID.test(uuid)) throw resourceNotFound();
      const rows = (await (
        await dbClient(ctx)
      )
        .select()
        .from(t.dnsRecords)
        .where(
          and(
            eq(t.dnsRecords.connectionId, connectionId),
            eq(t.dnsRecords.resourceUuid, uuid),
          ),
        )
        .orderBy(t.dnsRecords.id)) as DnsRow[];
      return rows.map(toDnsView);
    },

    /**
     * Creates a record for one of the resource's domains through the DNS
     * plugin and stores its handle, so it can be removed later. Without
     * content, points the name at the resource's server address.
     */
    async dnsCreate(
      connectionId: number,
      uuid: string,
      body: DnsCreateBody,
    ): Promise<DnsRecordView> {
      await need(connectionId, "configure");
      await requireCompanion(ctx, "dns");
      if (typeof body.fqdn !== "string") throw invalid("fqdn is required");
      const fqdn = body.fqdn.trim().toLowerCase().replace(/\.$/, "");
      if (!HOSTNAME.test(fqdn)) throw invalid("fqdn must be a host name");
      if (body.type !== undefined && !DNS_TYPES.has(String(body.type))) {
        throw invalid("type must be A, AAAA or CNAME");
      }
      if (body.content !== undefined && typeof body.content !== "string") {
        throw invalid("content must be text");
      }

      const resource = await resourceOf(connectionId, uuid);
      if (!hostnamesOf(resource.fqdns).has(fqdn)) {
        throw invalid("fqdn must be one of the resource's domains");
      }
      let content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content) {
        if (!resource.serverUuid) {
          throw invalid("content is required for this resource");
        }
        const api = await connections.api(connectionId);
        content = (await api.server(resource.serverUuid)).ip.trim();
      }
      const type = (body.type as DnsType | undefined) ?? typeFor(content);
      if (!type || !contentFits(type, content)) {
        throw invalid("content does not fit the record type");
      }

      const record = await dnsCreate(ctx, { fqdn, type, content });
      const stored: StoredHandle = { record, type, content };
      const db = await dbClient(ctx);
      await db.insert(t.dnsRecords).values({
        connectionId,
        resourceUuid: resource.uuid,
        // Stored as JSON text, like the other json columns.
        handle: JSON.stringify(stored),
        fqdn,
      });
      await ctx.db.persist();
      // No returning(): read the newest row for this name back.
      const [row] = (await db
        .select()
        .from(t.dnsRecords)
        .where(
          and(
            eq(t.dnsRecords.connectionId, connectionId),
            eq(t.dnsRecords.resourceUuid, resource.uuid),
            eq(t.dnsRecords.fqdn, fqdn),
          ),
        )
        .orderBy(desc(t.dnsRecords.id))
        .limit(1)) as DnsRow[];
      return toDnsView(row);
    },

    /**
     * Removes a record this connection made for this resource. Any other id
     * is refused before the DNS plugin is asked.
     */
    async dnsRemove(
      connectionId: number,
      uuid: string,
      recordId: number,
    ): Promise<{ id: number; removed: true }> {
      await need(connectionId, "configure");
      await requireCompanion(ctx, "dns");
      const row = await storedRecord(connectionId, uuid, recordId);
      const handle = parseHandle(row.handle);
      if (!handle) throw new CompanionError("companion-failed", "dns");
      await dnsRemove(ctx, handle.record);
      await (
        await dbClient(ctx)
      )
        .delete(t.dnsRecords)
        .where(eq(t.dnsRecords.id, row.id));
      await ctx.db.persist();
      return { id: row.id, removed: true };
    },

    /** Uptime monitors whose URL is on one of the resource's domains. */
    async uptime(
      connectionId: number,
      uuid: string,
    ): Promise<{ monitors: Monitor[] }> {
      await need(connectionId, "view");
      await requireCompanion(ctx, "uptime");
      return { monitors: await matchedMonitors(connectionId, uuid) };
    },

    /**
     * Pauses (or resumes) the resource's monitors through uptime.pause and
     * uptime.resume, for deploys. Answers the monitor ids it changed.
     */
    async setMonitorsPaused(
      connectionId: number,
      uuid: string,
      paused: boolean,
    ): Promise<{ monitors: string[] }> {
      await need(connectionId, "operate");
      await requireCompanion(ctx, "uptime");
      const monitors = await matchedMonitors(connectionId, uuid);
      for (const monitor of monitors) {
        await uptimeSetPaused(ctx, monitor.id, paused);
      }
      return { monitors: monitors.map((m) => m.id) };
    },

    /** Log Search over Docker logs, with the resource uuid as the query. */
    async logSearch(
      connectionId: number,
      uuid: string,
    ): Promise<{ source: "docker"; query: string; results: LogLine[] }> {
      await need(connectionId, "operate");
      await requireCompanion(ctx, "logSearch");
      const resource = await resourceOf(connectionId, uuid);
      return {
        source: "docker",
        query: resource.uuid,
        results: await logSearch(ctx, resource.uuid),
      };
    },

    /** Security Center's score and critical findings for a server's Linked host. */
    async security(
      connectionId: number,
      serverUuid: string,
    ): Promise<SecuritySummary & { hostId: number }> {
      await need(connectionId, "view");
      await requireCompanion(ctx, "securityCenter");
      const hostId = await hostOf(connectionId, serverUuid);
      return { hostId, ...(await securityCheck(ctx, hostId)) };
    },

    /** Failed Termix backup jobs on a server's Linked host. */
    async backupsFailed(
      connectionId: number,
      serverUuid: string,
    ): Promise<{ hostId: number; jobs: FailedBackup[] }> {
      await need(connectionId, "view");
      await requireCompanion(ctx, "backups");
      const hostId = await hostOf(connectionId, serverUuid);
      return { hostId, jobs: await backupsFailed(ctx, hostId) };
    },

    /** The Coolify resource counts the Host Metrics card shows. */
    async hostMetrics(
      connectionId: number,
      serverUuid: string,
    ): Promise<{
      hostId: number;
      applications: number;
      services: number;
      databases: number;
    }> {
      await need(connectionId, "view");
      await requireCompanion(ctx, "hostMetrics");
      const hostId = await hostOf(connectionId, serverUuid);
      const on = await resourcesOn(connectionId, serverUuid);
      const count = (kind: ResourceDto["kind"]) =>
        on.filter((r) => r.kind === kind).length;
      return {
        hostId,
        applications: count("application"),
        services: count("service"),
        databases: count("database"),
      };
    },

    /** Whether a Coolify database has a saved login in the Databases plugin. */
    async dbLogin(
      connectionId: number,
      uuid: string,
    ): Promise<{
      hostId: number;
      saved: boolean;
      logins: ReturnType<typeof withoutHost>[];
    }> {
      await need(connectionId, "view");
      await requireCompanion(ctx, "databases");
      const resource = await resourceOf(connectionId, uuid);
      if (!isDatabase(resource)) {
        throw invalid("Only a database has saved logins");
      }
      const hostId = await hostOf(connectionId, resource.serverUuid);
      const logins = (await databaseLogins(ctx, hostId)).filter((l) =>
        loginMatches(l, resource),
      );
      return {
        hostId,
        saved: logins.length > 0,
        logins: logins.map(withoutHost),
      };
    },

    /** The Coolify databases on a server and whether each has a saved login. */
    async dbLogins(
      connectionId: number,
      serverUuid: string,
    ): Promise<{
      hostId: number;
      databases: { uuid: string; name: string; saved: boolean }[];
    }> {
      await need(connectionId, "view");
      await requireCompanion(ctx, "databases");
      const hostId = await hostOf(connectionId, serverUuid);
      const databases = (await resourcesOn(connectionId, serverUuid)).filter(
        isDatabase,
      );
      const logins = await databaseLogins(ctx, hostId);
      return {
        hostId,
        databases: databases.map((r) => ({
          uuid: r.uuid,
          name: r.name,
          saved: logins.some((l) => loginMatches(l, r)),
        })),
      };
    },
  };
}

export type Companions = ReturnType<typeof createCompanions>;
