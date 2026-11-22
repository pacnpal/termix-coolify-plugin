import { and, desc, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto } from "../coolify/dto.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import { dbClient, type Tables } from "../db.js";
import type { Resources } from "../resources/service.js";
import type { Sync } from "../sync/service.js";
import {
  backupsFailed,
  databaseLogins,
  dnsKey,
  dnsRemove,
  dnsUpsert,
  logSearch,
  securityCheck,
  uptimeMonitors,
  uptimeSetPaused,
  type CompanionCaller,
  type DnsRecordKey,
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
/**
 * A real IPv6 address: the WHATWG URL parser checks the full grammar
 * (compressed forms like 2001:db8::1 pass, ::: does not).
 */
function isIPv6(text: string): boolean {
  if (!/^[0-9a-f:.]{2,45}$/i.test(text) || !text.includes(":")) return false;
  try {
    return new URL(`http://[${text}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}
const DNS_TYPES: ReadonlySet<string> = new Set(["A", "AAAA", "CNAME"]);

/** Only an exact type string: ["A"] or a number never passes as one. */
function isDnsType(value: unknown): value is DnsType {
  return typeof value === "string" && DNS_TYPES.has(value);
}

/** A DNS record made here, as routes return it. */
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

/** A host name as it is compared: lowercase, without a trailing dot. */
function canonicalHost(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

/** Where a resource answers: host and path (no trailing slash, "" for the root). */
interface Place {
  host: string;
  path: string;
}

function placeOf(text: string): Place | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
    if (!url.hostname) return null;
    return {
      host: canonicalHost(url.hostname),
      path: url.pathname.replace(/\/+$/, ""),
    };
  } catch {
    // Not a URL; not a place the resource answers on.
    return null;
  }
}

function placesOf(fqdns: string[]): Place[] {
  return fqdns.flatMap((f) => placeOf(f) ?? []);
}

/** The host names of a resource's domains, lowercase, without a trailing dot. */
export function hostnamesOf(fqdns: string[]): Set<string> {
  return new Set(placesOf(fqdns).map((p) => p.host));
}

/**
 * Whether a monitor checks one of the resource's own URLs: the same host,
 * and a path at or under the resource's path (a resource at the root owns
 * the whole host). /app matches /app and /app/health, never /apple or /admin.
 */
function monitorMatches(url: string, places: Place[]): boolean {
  const monitor = placeOf(url);
  if (!monitor) return false;
  return places.some(
    (p) =>
      p.host === monitor.host &&
      (p.path === "" ||
        monitor.path === p.path ||
        monitor.path.startsWith(`${p.path}/`)),
  );
}

/**
 * The handle column: the zone, type, name and content dns.delete-record needs
 * to remove the record. Null when any is missing, so nothing is guessed.
 */
function parseHandle(value: unknown): DnsRecordKey | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const stored = raw as Partial<Record<keyof DnsRecordKey, unknown>>;
  const { zone, type, name, content } = stored;
  if (
    typeof zone !== "string" ||
    typeof name !== "string" ||
    typeof content !== "string" ||
    !isDnsType(type)
  ) {
    return null;
  }
  return { zone, type: type as DnsType, name, content };
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
  if (type === "AAAA") return isIPv6(content);
  return HOSTNAME.test(content);
}

function typeFor(content: string): DnsType | null {
  if (IPV4.test(content)) return "A";
  if (isIPv6(content)) return "AAAA";
  return HOSTNAME.test(content) ? "CNAME" : null;
}

function isDatabase(resource: ResourceDto): boolean {
  return resource.kind === "database" || resource.kind === "service-database";
}

/**
 * Whether a saved login is for this Coolify database. Its uuid in the login's
 * name proves it; a plain name match counts only when no other database on
 * the same host (`onHost`) shares that name, since a shared name can't tell
 * them apart.
 */
function loginMatches(
  login: SavedLogin,
  resource: ResourceDto,
  onHost: readonly ResourceDto[],
): boolean {
  const names = [login.name, login.database].filter(
    (v): v is string => typeof v === "string",
  );
  if (names.some((name) => name.includes(resource.uuid))) return true;
  const unique =
    onHost.filter((r) => isDatabase(r) && r.name === resource.name).length <= 1;
  return unique && names.some((name) => name === resource.name);
}

/**
 * The companion-plugin features. Every method acts for ctx.currentActor() and
 * checks, in order: the Termix permission, the actor's access to the
 * connection (owner, or a grant at the level the feature needs), read once
 * with `snapshot`, that the companion runs (an unreadable plugin list is
 * companions-unknown), a resource from that connection's own list or a server
 * its own Coolify has, and, for anything on a Linked host, the actor's own
 * access to that host. The snapshot's revision is checked again right before
 * every companion call, and before a read answers, so a target change ends
 * it with target-changed. Nothing sent to a companion carries a token or
 * secret.
 */
export function createCompanions(
  ctx: PluginContext,
  deps: {
    tables: Tables;
    connections: Connections;
    resources: Pick<Resources, "get" | "byServer">;
    sync: Pick<Sync, "linkedHostFor">;
  },
) {
  const t = deps.tables;
  const { connections, resources, sync } = deps;

  type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

  /** The permission and grant a feature needs, on one read of the connection. */
  async function need(connectionId: number, level: Level): Promise<Snapshot> {
    const permitted = await ctx.rbac.has(level).catch(() => false);
    if (!permitted) throw forbidden(`This needs coolify.${level}`);
    // Read once: every later step is checked against this target. Another
    // user's connection is not-found here.
    const snap = await connections.snapshot(connectionId);
    if (RANK[snap.view.access] < RANK[level]) {
      throw forbidden(`Your grant on this connection doesn't allow this`);
    }
    levels.set(snap, level);
    return snap;
  }

  // The level each snapshot was opened for, so `holds` re-checks the grant.
  const levels = new WeakMap<Snapshot, Level>();

  /**
   * Fails closed unless the connection still points at the snapshot's target
   * and the actor's grant still reaches the level the feature was opened
   * for: a grant lowered mid-way (which leaves the revision as it was) stops
   * it too.
   */
  async function holds(connectionId: number, snap: Snapshot): Promise<void> {
    const access = await connections.access(connectionId);
    if (!access) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    if (RANK[access] < RANK[levels.get(snap) ?? "owner"]) {
      throw forbidden(`Your grant on this connection doesn't allow this`);
    }
    // Last, so nothing is awaited between this check and the guarded call.
    if ((await connections.revision(connectionId)) !== snap.view.revision) {
      throw new ConnectionError(
        "target-changed",
        "The connection's address, token or Access settings changed. Try again.",
      );
    }
  }

  /** What the adapters call companions through: the snapshot is checked first. */
  function guarded(connectionId: number, snap: Snapshot): CompanionCaller {
    return {
      operations: ctx.operations,
      before: () => holds(connectionId, snap),
    };
  }

  /** One of the connection's own resources, from the shared resource cache. */
  async function resourceOf(
    connectionId: number,
    uuid: string,
  ): Promise<ResourceDto> {
    if (!UUID.test(uuid)) throw resourceNotFound();
    // A miss is checked once more, fresh, as lifecycle does.
    const found =
      (await resources.get(connectionId, uuid)) ??
      (await resources.get(connectionId, uuid, { refresh: true }));
    if (!found) throw resourceNotFound();
    return found;
  }

  /**
   * Before any stored row is read or acted on: the resource is in the
   * current target's own list (a miss, or a list that can't be read,
   * refuses), and that target is still the snapshot's.
   */
  async function exposed(
    connectionId: number,
    snap: Snapshot,
    uuid: string,
  ): Promise<ResourceDto> {
    const resource = await resourceOf(connectionId, uuid);
    await holds(connectionId, snap);
    return resource;
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

  /**
   * A server path's Linked host: linked to this connection, still in the
   * connection's own Coolify (a uuid it doesn't have is Coolify's 404,
   * whatever link row is left), and one the actor may see.
   */
  async function serverHost(
    connectionId: number,
    snap: Snapshot,
    serverUuid: string,
  ): Promise<number> {
    if (!UUID.test(serverUuid)) throw notLinked();
    if (!(await sync.linkedHostFor(connectionId, serverUuid))) {
      throw notLinked();
    }
    await snap.api.server(serverUuid);
    return hostOf(connectionId, serverUuid);
  }

  // DNS rows are inserted and read back one at a time, so an overlapping
  // create can't read another request's row as its own.
  // ponytail: one in-process queue, as connections' withLock; move to the
  // database if the backend ever runs as more than one process.
  let storing: Promise<unknown> = Promise.resolve();

  // DNS creates and removes for one resource run one at a time, so a remove
  // never runs while a create's DNS write is still out.
  // ponytail: in-process queues, as sync's `serialized`; move to the
  // database if the backend ever runs as more than one process.
  const dnsQueues = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (dnsQueues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    dnsQueues.set(key, tail);
    void tail.then(() => {
      if (dnsQueues.get(key) === tail) dnsQueues.delete(key);
    });
    return run;
  }

  // Rows written ahead of their DNS write: not listed and not removable
  // until that write succeeds. A restart forgets them, and the row (made
  // before the write) then lists like any other.
  const pendingRows = new Set<number>();

  /** Inserts a DNS row and answers exactly that row. */
  function storeRecord(
    connectionId: number,
    resourceUuid: string,
    fqdn: string,
    key: DnsRecordKey,
  ): Promise<DnsRow> {
    const handle = JSON.stringify(key);
    const run = storing.then(async () => {
      const db = await dbClient(ctx);
      // Stored as JSON text, like the other json columns.
      await db
        .insert(t.dnsRecords)
        .values({ connectionId, resourceUuid, handle, fqdn });
      // No returning(): the newest row with this exact handle is the one
      // just inserted, since inserts here run one at a time.
      const [row] = (await db
        .select()
        .from(t.dnsRecords)
        .where(
          and(
            eq(t.dnsRecords.connectionId, connectionId),
            eq(t.dnsRecords.resourceUuid, resourceUuid),
            eq(t.dnsRecords.fqdn, fqdn),
            eq(t.dnsRecords.handle, handle),
          ),
        )
        .orderBy(desc(t.dnsRecords.id))
        .limit(1)) as DnsRow[];
      await ctx.db.persist();
      return row;
    });
    storing = run.catch(() => undefined);
    return run;
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
    if (!row || pendingRows.has(row.id)) {
      throw new CompanionError("dns-record-not-found", "dns");
    }
    return row;
  }

  async function matchedMonitors(
    connectionId: number,
    snap: Snapshot,
    uuid: string,
  ): Promise<Monitor[]> {
    const resource = await resourceOf(connectionId, uuid);
    const places = placesOf(resource.fqdns);
    if (!places.length) return [];
    return (await uptimeMonitors(guarded(connectionId, snap))).filter((m) =>
      monitorMatches(m.url, places),
    );
  }

  /** A read's answer, only while the connection still points at the snapshot. */
  async function answer<T>(
    connectionId: number,
    snap: Snapshot,
    value: T,
  ): Promise<T> {
    await holds(connectionId, snap);
    return value;
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
      const snap = await need(connectionId, "view");
      await requireCompanion(ctx, "dns");
      await exposed(connectionId, snap, uuid);
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
      // A record whose DNS write is still out isn't one yet.
      return rows.filter((r) => !pendingRows.has(r.id)).map(toDnsView);
    },

    /**
     * Creates a record for one of the resource's domains with dns.upsert-record
     * and stores its zone, type, name and content, so it can be removed later. Without
     * content, points the name at the resource's server address.
     */
    async dnsCreate(
      connectionId: number,
      uuid: string,
      body: DnsCreateBody,
    ): Promise<DnsRecordView> {
      const snap = await need(connectionId, "configure");
      await requireCompanion(ctx, "dns");
      if (typeof body.fqdn !== "string") throw invalid("fqdn is required");
      const fqdn = body.fqdn.trim().toLowerCase().replace(/\.$/, "");
      if (!HOSTNAME.test(fqdn)) throw invalid("fqdn must be a host name");
      if (body.type !== undefined && !isDnsType(body.type)) {
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
        content = (await snap.api.server(resource.serverUuid)).ip.trim();
      }
      const type = isDnsType(body.type) ? body.type : typeFor(content);
      if (!type || !contentFits(type, content)) {
        throw invalid("content does not fit the record type");
      }

      const caller = guarded(connectionId, snap);
      const key = await dnsKey(caller, { fqdn, type, content });
      // The handle is stored before the DNS write, so a record that write
      // makes can always be listed and removed. Only if the write fails is
      // the stored row dropped (never the record in DNS: the write may have
      // touched one that was already there).
      return serialized(`${connectionId}:${resource.uuid}`, async () => {
        const row = await storeRecord(connectionId, resource.uuid, fqdn, key);
        pendingRows.add(row.id);
        try {
          await dnsUpsert(caller, key);
        } catch (err) {
          await (
            await dbClient(ctx)
          )
            .delete(t.dnsRecords)
            .where(eq(t.dnsRecords.id, row.id));
          await ctx.db.persist();
          throw err;
        } finally {
          pendingRows.delete(row.id);
        }
        return toDnsView(row);
      });
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
      const snap = await need(connectionId, "configure");
      await requireCompanion(ctx, "dns");
      // The stored row alone proves nothing about the current target: the
      // resource must still be one it exposes, or nothing is removed.
      await exposed(connectionId, snap, uuid);
      return serialized(`${connectionId}:${uuid}`, async () => {
        const row = await storedRecord(connectionId, uuid, recordId);
        const handle = parseHandle(row.handle);
        if (!handle) throw new CompanionError("companion-failed", "dns");
        await dnsRemove(guarded(connectionId, snap), handle);
        await (
          await dbClient(ctx)
        )
          .delete(t.dnsRecords)
          .where(eq(t.dnsRecords.id, row.id));
        await ctx.db.persist();
        return { id: row.id, removed: true as const };
      });
    },

    /** Uptime monitors whose URL is on one of the resource's domains. */
    async uptime(
      connectionId: number,
      uuid: string,
    ): Promise<{ monitors: Monitor[] }> {
      const snap = await need(connectionId, "view");
      await requireCompanion(ctx, "uptime");
      const monitors = await matchedMonitors(connectionId, snap, uuid);
      return answer(connectionId, snap, { monitors });
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
      const snap = await need(connectionId, "operate");
      await requireCompanion(ctx, "uptime");
      const monitors = await matchedMonitors(connectionId, snap, uuid);
      const caller = guarded(connectionId, snap);
      // Each monitor's state before this call, read from Uptime's own
      // status: "paused" is paused; up, down and pending are not; anything
      // else is unknown.
      const before = (m: Monitor): boolean | null =>
        m.status === "paused" ? true : m.status === "unknown" ? null : false;
      // A monitor already in the asked state is left alone: this call never
      // touches it, so it can never set it back either.
      const todo = monitors.filter((m) => before(m) !== paused);
      const changed: Monitor[] = [];
      try {
        for (const monitor of todo) {
          await uptimeSetPaused(caller, monitor.id, paused);
          changed.push(monitor);
        }
      } catch (err) {
        // No partial change is left behind: each monitor this call changed
        // goes back to its own state from before, unguarded, since this only
        // undoes its own writes. One whose state before was unknown is left
        // as it is, rather than guessed. A failed undo can't be helped; the
        // first error is answered.
        for (const monitor of changed.reverse()) {
          const was = before(monitor);
          if (was === null) continue;
          await uptimeSetPaused(ctx, monitor.id, was).catch(() => undefined);
        }
        throw err;
      }
      return { monitors: changed.map((m) => m.id) };
    },

    /** Log Search over Docker logs, with the resource uuid as the query. */
    async logSearch(
      connectionId: number,
      uuid: string,
    ): Promise<{ source: "docker"; query: string; results: LogLine[] }> {
      const snap = await need(connectionId, "operate");
      await requireCompanion(ctx, "logSearch");
      const resource = await resourceOf(connectionId, uuid);
      const results = await logSearch(
        guarded(connectionId, snap),
        resource.uuid,
      );
      return answer(connectionId, snap, {
        source: "docker" as const,
        query: resource.uuid,
        results,
      });
    },

    /** Security Center's score and critical findings for a server's Linked host. */
    async security(
      connectionId: number,
      serverUuid: string,
    ): Promise<SecuritySummary & { hostId: number }> {
      const snap = await need(connectionId, "view");
      await requireCompanion(ctx, "securityCenter");
      const hostId = await serverHost(connectionId, snap, serverUuid);
      const summary = await securityCheck(guarded(connectionId, snap), hostId);
      return answer(connectionId, snap, { hostId, ...summary });
    },

    /** Failed Termix backup jobs on a server's Linked host. */
    async backupsFailed(
      connectionId: number,
      serverUuid: string,
    ): Promise<{ hostId: number; jobs: FailedBackup[] }> {
      const snap = await need(connectionId, "view");
      await requireCompanion(ctx, "backups");
      const hostId = await serverHost(connectionId, snap, serverUuid);
      const jobs = await backupsFailed(guarded(connectionId, snap), hostId);
      return answer(connectionId, snap, { hostId, jobs });
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
      const snap = await need(connectionId, "view");
      await requireCompanion(ctx, "hostMetrics");
      const hostId = await serverHost(connectionId, snap, serverUuid);
      const on = await resources.byServer(connectionId, serverUuid);
      const count = (kind: ResourceDto["kind"]) =>
        on.filter((r) => r.kind === kind).length;
      return answer(connectionId, snap, {
        hostId,
        applications: count("application"),
        services: count("service"),
        databases: count("database"),
      });
    },

    /** Whether a Coolify database has a saved login in the Databases plugin. */
    async dbLogin(
      connectionId: number,
      uuid: string,
    ): Promise<{
      hostId: number;
      saved: boolean;
      logins: SavedLogin[];
    }> {
      const snap = await need(connectionId, "view");
      await requireCompanion(ctx, "databases");
      const resource = await resourceOf(connectionId, uuid);
      if (!isDatabase(resource)) {
        throw invalid("Only a database has saved logins");
      }
      const hostId = await hostOf(connectionId, resource.serverUuid);
      const onHost = await resources.byServer(
        connectionId,
        resource.serverUuid ?? "",
      );
      const logins = (
        await databaseLogins(guarded(connectionId, snap), hostId)
      ).filter((l) => loginMatches(l, resource, onHost));
      return answer(connectionId, snap, {
        hostId,
        saved: logins.length > 0,
        logins,
      });
    },

    /** The Coolify databases on a server and whether each has a saved login. */
    async dbLogins(
      connectionId: number,
      serverUuid: string,
    ): Promise<{
      hostId: number;
      databases: { uuid: string; name: string; saved: boolean }[];
    }> {
      const snap = await need(connectionId, "view");
      await requireCompanion(ctx, "databases");
      const hostId = await serverHost(connectionId, snap, serverUuid);
      const databases = (
        await resources.byServer(connectionId, serverUuid)
      ).filter(isDatabase);
      const logins = await databaseLogins(guarded(connectionId, snap), hostId);
      return answer(connectionId, snap, {
        hostId,
        databases: databases.map((r) => ({
          uuid: r.uuid,
          name: r.name,
          saved: logins.some((l) => loginMatches(l, r, databases)),
        })),
      });
    },
  };
}

export type Companions = ReturnType<typeof createCompanions>;
