import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { trimTrailing } from "../text.js";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createCoolifyApi, type CoolifyApi } from "../coolify/api.js";
import {
  CAUSE_MESSAGES,
  CoolifyError,
  createCoolifyHttp,
  type CoolifyHttp,
  type CoolifyTarget,
} from "../coolify/http.js";
import { dbClient, type Table, type Tables } from "../db.js";
import {
  runProbe,
  type Abilities,
  type ProbeResult,
  type ProbeStep,
} from "./probe.js";

export type AccessLevel = "owner" | "view" | "operate" | "configure";

const GRANT_LEVELS: ReadonlySet<string> = new Set([
  "view",
  "operate",
  "configure",
]);

/** A connection as routes and operations return it. Never holds a secret. */
export interface ConnectionView {
  id: number;
  name: string;
  baseUrl: string;
  teamName: string | null;
  version: string | null;
  scoped: boolean;
  abilities: Abilities;
  /** The cause of the last failed probe (a CoolifyCause), or null. */
  lastError: string | null;
  autoSync: boolean;
  /**
   * The owner's opt-in to coolify.exec for this connection. It also needs the
   * admin setting allowExec.
   */
  execEnabled: boolean;
  /** The actor's access: "owner", or the level of a grant. */
  access: AccessLevel;
  allowPrivate: boolean;
  /** A CA certificate is public; it is returned so the form can show it. */
  caCert: string | null;
  /** Whether a Cloudflare Access service token is stored. Its values never leave. */
  cfAccess: boolean;
  lastCheckedAt: string | null;
  /** The last probe's checklist. */
  steps: ProbeStep[];
  /**
   * Changes whenever the address, token, Cloudflare Access values or TLS
   * settings do: a hash of the stored (sealed) values, so it holds no secret.
   */
  revision: string;
}

export interface ConnectionInput {
  name: string;
  baseUrl: string;
  token: string;
  cfAccessId?: string | null;
  cfAccessSecret?: string | null;
  allowPrivate?: boolean;
  caCert?: string | null;
}

/**
 * A change to a connection. An absent or empty token or Cloudflare Access
 * value keeps the stored one; null for both Cloudflare values clears them.
 */
export interface ConnectionPatch {
  name?: string;
  baseUrl?: string;
  token?: string;
  cfAccessId?: string | null;
  cfAccessSecret?: string | null;
  allowPrivate?: boolean;
  caCert?: string | null;
  autoSync?: boolean;
}

export type ConnectionErrorCode =
  | "invalid-input"
  | "forbidden"
  | "not-found"
  // A server with no Linked host (host sync's unlink).
  | "not-linked"
  // The connection's target changed while a host sync was running.
  | "target-changed";

const ERROR_STATUS = {
  "invalid-input": 400,
  forbidden: 403,
  "not-found": 404,
  "not-linked": 404,
  "target-changed": 409,
} as const;

/** A refusal by the plugin itself, before or without asking Coolify. */
export class ConnectionError extends Error {
  readonly status: (typeof ERROR_STATUS)[ConnectionErrorCode];
  readonly code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

const notFound = () =>
  new ConnectionError("not-found", "Coolify connection not found");

/**
 * Removes a connection's Linked hosts and then its rows: it unlinks the hosts
 * (or removes them when `removeHosts`) and must call `deleteRows` after,
 * inside the same critical section, so no host sync of the connection runs
 * between the two. Host sync supplies it; without it, only the rows go.
 */
export type ReleaseLinkedHosts = (
  connectionId: number,
  opts: { removeHosts: boolean },
  deleteRows: () => Promise<void>,
) => Promise<void>;

export interface ConnectionsOptions {
  releaseLinkedHosts?: ReleaseLinkedHosts;
}

/** What the abilities column holds: the probe's summary, never key material. */
interface StoredProbe {
  abilities: Abilities;
  scoped: boolean;
  teamId: string | null;
  steps: ProbeStep[];
}

interface ConnectionRow {
  id: number;
  userId: string;
  name: string;
  baseUrl: string;
  tokenSealed: string;
  cfAccessIdSealed: string | null;
  cfAccessSecretSealed: string | null;
  allowPrivate: boolean;
  caCert: string | null;
  instanceKey: string | null;
  autoSync: boolean;
  execEnabled: boolean;
  abilities: string | null;
  coolifyVersion: string | null;
  teamName: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

const NO_ABILITIES: Abilities = {
  read: false,
  sensitive: false,
  keys: false,
  root: false,
  mcp: false,
};

const MAX_NAME = 100;
const MAX_SECRET = 4096;
const MAX_CERT = 64 * 1024;

/**
 * The base URL as stored: http or https, no credentials, query or fragment,
 * lowercase host, no trailing slash and no pasted "/api/v1". Null when the
 * value isn't such a URL.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = trimTrailing(
    trimTrailing(url.pathname, "/").replace(/\/api\/v1$/i, ""),
    "/",
  );
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

type Reach = "loopback" | "private-ip" | "other";

/** 127.0.0.0/8 is loopback; 10/8, 172.16/12, 192.168/16 and 169.254/16 private. */
function ipv4Reach(a: number, b: number): Reach {
  if (a === 127) return "loopback";
  const isPrivate =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
  return isPrivate ? "private-ip" : "other";
}

/** Dotted IPv4 as four octets, or null. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** IPv6 as its eight 16-bit groups (`::` expanded, a dotted tail read), or null. */
function parseIpv6(text: string): number[] | null {
  let rest = text;
  const tail: number[] = [];
  const lastColon = rest.lastIndexOf(":");
  if (rest.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(rest.slice(lastColon + 1));
    if (!v4) return null;
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    // Drop the IPv4 and its colon, but keep a "::" that came right before it.
    rest = rest.slice(0, lastColon + 1);
    if (!rest.endsWith("::")) rest = rest.slice(0, -1);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const read = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  };
  const head = read(halves[0]);
  const after = halves.length === 2 ? read(halves[1]) : [];
  if (!head || !after) return null;
  const known = head.length + after.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...head, ...new Array(8 - known).fill(0), ...after, ...tail];
  }
  return known === 8 ? [...head, ...tail] : null;
}

/**
 * Where a URL's host is: loopback (localhost, 127.0.0.0/8, ::1), an IP
 * literal in a private or link-local range, or anything else. Any other name
 * counts as "other": the plugin can't resolve it, and a name can point
 * anywhere, so it is never trusted to be private. An address that doesn't
 * parse cleanly is "other" too.
 */
function hostReach(url: URL): Reach {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return "loopback";
  if (!host.includes(":")) {
    const v4 = parseIpv4(host);
    return v4 ? ipv4Reach(v4[0], v4[1]) : "other";
  }
  const g = parseIpv6(host);
  if (!g) return "other";
  const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUntil(7) && g[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d): the embedded address decides.
  if (zeroUntil(5) && g[5] === 0xffff) return ipv4Reach(g[6] >> 8, g[6] & 0xff);
  // fc00::/7 unique local, fe80::/10 link-local.
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) {
    return "private-ip";
  }
  return "other";
}

/**
 * Plain http would send the token and Cloudflare Access secret in the clear,
 * so it is allowed only to loopback, or to a private or link-local IP literal
 * when the connection allows private hosts. Throws before anything is sent.
 */
export function checkTransport(baseUrl: string, allowPrivate: boolean): void {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") return;
  const reach: Reach = hostReach(url);
  if (reach === "loopback" || (reach === "private-ip" && allowPrivate)) return;
  throw invalid(
    reach === "private-ip"
      ? 'Use HTTPS, or turn on "On my local network" to reach this private IP address over plain HTTP'
      : 'Use HTTPS, or the server\'s private IP address with "On my local network" on; plain HTTP to a name sends the token in the clear',
  );
}

/** Groups connections to the same Coolify team; null when the team is unknown. */
export function instanceKeyOf(
  baseUrl: string,
  teamId: string | null,
): string | null {
  return teamId ? `${baseUrl}#${teamId}`.slice(0, 255) : null;
}

function invalid(message: string): ConnectionError {
  return new ConnectionError("invalid-input", message);
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_NAME) {
    throw invalid(`name must be 1 to ${MAX_NAME} characters`);
  }
  return name;
}

function cleanUrl(value: unknown): string {
  const url = typeof value === "string" ? normalizeBaseUrl(value) : null;
  if (!url) throw invalid("baseUrl must be an http or https URL");
  return url;
}

function cleanSecret(value: unknown, field: string): string {
  const secret = typeof value === "string" ? value.trim() : "";
  if (!secret || secret.length > MAX_SECRET) {
    throw invalid(`${field} must be 1 to ${MAX_SECRET} characters`);
  }
  return secret;
}

function cleanCert(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid("caCert must be text");
  const cert = value.trim();
  if (!cert) return null;
  if (cert.length > MAX_CERT || !cert.includes("BEGIN CERTIFICATE")) {
    throw invalid("caCert must be a PEM certificate");
  }
  return cert;
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseStored(text: string | null): StoredProbe {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<StoredProbe>;
      return {
        abilities: { ...NO_ABILITIES, ...(parsed.abilities ?? {}) },
        scoped: parsed.scoped === true,
        teamId: parsed.teamId ?? null,
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      };
    } catch {
      // A damaged column reads as never probed.
    }
  }
  return { abilities: NO_ABILITIES, scoped: false, teamId: null, steps: [] };
}

/** Everything that decides where calls go and with which credentials. */
function targetKey(found: ConnectionRow): string {
  return JSON.stringify([
    found.baseUrl,
    found.tokenSealed,
    found.cfAccessIdSealed,
    found.cfAccessSecretSealed,
    found.allowPrivate === true,
    found.caCert,
  ]);
}

function revisionOf(found: ConnectionRow): string {
  return createHash("sha256").update(targetKey(found)).digest("hex");
}

function toView(row: ConnectionRow, access: AccessLevel): ConnectionView {
  const stored = parseStored(row.abilities);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    teamName: row.teamName,
    version: row.coolifyVersion,
    scoped: stored.scoped,
    abilities: stored.abilities,
    lastError: row.lastError,
    autoSync: row.autoSync === true,
    execEnabled: row.execEnabled === true,
    access,
    allowPrivate: row.allowPrivate === true,
    caCert: row.caCert,
    cfAccess: Boolean(row.cfAccessIdSealed && row.cfAccessSecretSealed),
    lastCheckedAt: row.lastCheckedAt,
    steps: stored.steps,
    revision: revisionOf(row),
  };
}

/** The columns a probe result writes. */
function probeColumns(baseUrl: string, probe: ProbeResult) {
  const stored: StoredProbe = {
    abilities: probe.abilities,
    scoped: probe.scoped,
    teamId: probe.teamId,
    steps: probe.steps,
  };
  const failed = probe.ok ? null : probe.steps.find((s) => !s.ok);
  return {
    abilities: JSON.stringify(stored),
    coolifyVersion: probe.version,
    teamName: probe.teamName,
    instanceKey: probe.ok ? instanceKeyOf(baseUrl, probe.teamId) : null,
    lastError: failed ? (failed.cause ?? "upstream") : null,
    lastCheckedAt: new Date().toISOString(),
  };
}

function refuseOldCoolify(probe: ProbeResult): void {
  if (probe.steps.some((s) => s.cause === "unsupported-version")) {
    throw new CoolifyError(
      "unsupported-version",
      0,
      CAUSE_MESSAGES["unsupported-version"],
    );
  }
}

/**
 * Connections, their sealed tokens, who may use them and the ability probe.
 * Every method acts for ctx.currentActor(). Another user's connection reads
 * as missing (404), never as forbidden. In 1.0 only owners reach a
 * connection: the grants table is read, but nothing writes it yet.
 */
export function createConnections(
  ctx: PluginContext,
  tables: Tables,
  options: ConnectionsOptions = {},
) {
  const t = tables;
  const release: ReleaseLinkedHosts =
    options.releaseLinkedHosts ??
    (async (_id, _opts, deleteRows) => deleteRows());
  const clients = new Map<
    number,
    { key: string; http: CoolifyHttp; api: CoolifyApi }
  >();

  // Writes to one connection run one at a time, in the order asked: update,
  // remove, and storing a probe's result. The plugin backend is a single Node
  // process per Termix server, so this in-memory chain serializes every writer
  // of a connection row without an affected-row count, which SQLite,
  // PostgreSQL and MySQL report differently. Each critical section reads the
  // row again and builds its write from that row.
  const locks = new Map<number, Promise<void>>();

  async function withLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const before = locks.get(id) ?? Promise.resolve();
    const run = before.then(fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (locks.get(id) === tail) locks.delete(id);
    }
  }

  function actor(): string | null {
    return ctx.currentActor() ?? null;
  }

  async function row(id: number): Promise<ConnectionRow | null> {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const db = await dbClient(ctx);
    const [found] = await db
      .select()
      .from(t.connections)
      .where(eq(t.connections.id, id))
      .limit(1);
    return (found as ConnectionRow | undefined) ?? null;
  }

  async function accessTo(
    found: ConnectionRow,
    userId: string | null,
  ): Promise<AccessLevel | null> {
    if (!userId) return null;
    if (found.userId === userId) return "owner";
    const db = await dbClient(ctx);
    const [grant] = await db
      .select()
      .from(t.grants)
      .where(
        and(eq(t.grants.connectionId, found.id), eq(t.grants.userId, userId)),
      )
      .limit(1);
    const level = (grant as { level?: string } | undefined)?.level;
    return level && GRANT_LEVELS.has(level) ? (level as AccessLevel) : null;
  }

  /** The row and the actor's access, or a 404. */
  async function reach(
    id: number,
  ): Promise<{ row: ConnectionRow; access: AccessLevel }> {
    const found = await row(id);
    const access = found ? await accessTo(found, actor()) : null;
    if (!found || !access) throw notFound();
    return { row: found, access };
  }

  async function owned(id: number): Promise<ConnectionRow> {
    const { row: found, access } = await reach(id);
    if (access !== "owner") {
      throw new ConnectionError(
        "forbidden",
        "Only the owner can change this connection",
      );
    }
    return found;
  }

  async function unsealOrNull(value: string | null): Promise<string | null> {
    return value ? ctx.secrets.unseal(value) : null;
  }

  /** A stored secret as text, or null when absent or unreadable. Never "". */
  async function readable(value: string | null): Promise<string | null> {
    return (await unsealOrNull(value)) || null;
  }

  /**
   * Matches the connection only while it still points where `found` did, so
   * a probe of that target can't land after a change has replaced it.
   */
  function sameTarget(found: ConnectionRow) {
    const c = t.connections;
    const is = (column: Table, value: string | null) =>
      value === null ? isNull(column) : eq(column, value);
    return and(
      eq(c.id, found.id),
      eq(c.baseUrl, found.baseUrl),
      eq(c.tokenSealed, found.tokenSealed),
      is(c.cfAccessIdSealed, found.cfAccessIdSealed),
      is(c.cfAccessSecretSealed, found.cfAccessSecretSealed),
      eq(c.allowPrivate, found.allowPrivate === true),
      is(c.caCert, found.caCert),
    );
  }

  async function targetOf(found: ConnectionRow): Promise<CoolifyTarget> {
    const token = await ctx.secrets.unseal(found.tokenSealed);
    if (!token) {
      throw new CoolifyError(
        "unauthorized",
        0,
        "The stored token can't be read; enter it again",
      );
    }
    const id = await unsealOrNull(found.cfAccessIdSealed);
    const secret = await unsealOrNull(found.cfAccessSecretSealed);
    return {
      baseUrl: found.baseUrl,
      token,
      cfAccess: id && secret ? { id, secret } : null,
      allowPrivate: found.allowPrivate === true,
      caCert: found.caCert,
    };
  }

  /** Every Coolify client is built here, after the transport check. */
  function clientFor(target: CoolifyTarget) {
    checkTransport(target.baseUrl, target.allowPrivate);
    const http = createCoolifyHttp(ctx.fetch, target);
    return { http, api: createCoolifyApi(http) };
  }

  /** One client per connection, so the request budget is shared. */
  async function cachedClient(found: ConnectionRow) {
    const key = targetKey(found);
    const hit = clients.get(found.id);
    if (hit && hit.key === key) return hit;
    const made = { key, ...clientFor(await targetOf(found)) };
    clients.set(found.id, made);
    return made;
  }

  async function probeTarget(target: CoolifyTarget): Promise<ProbeResult> {
    const { http, api } = clientFor(target);
    return runProbe(api, http);
  }

  async function view(id: number): Promise<ConnectionView> {
    const { row: found, access } = await reach(id);
    return toView(found, access);
  }

  /**
   * The body of update, run under the connection's lock: it reads the row,
   * probes the next target and writes, with no other writer in between. The
   * lock is held through the probe, so updates apply in the order asked.
   */
  async function updateNow(
    id: number,
    patch: ConnectionPatch,
  ): Promise<ConnectionView> {
    const found = await owned(id);
    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined) changes.name = cleanName(patch.name);
    if (patch.autoSync !== undefined) {
      changes.autoSync = patch.autoSync === true;
    }

    const token = present(patch.token)
      ? cleanSecret(patch.token, "token")
      : null;
    const baseUrl =
      patch.baseUrl !== undefined ? cleanUrl(patch.baseUrl) : found.baseUrl;
    const allowPrivate =
      patch.allowPrivate !== undefined
        ? patch.allowPrivate === true
        : found.allowPrivate === true;
    const caCert =
      patch.caCert !== undefined ? cleanCert(patch.caCert) : found.caCert;
    const clearCf = patch.cfAccessId === null && patch.cfAccessSecret === null;
    const cfId = present(patch.cfAccessId)
      ? cleanSecret(patch.cfAccessId, "cfAccessId")
      : null;
    const cfSecret = present(patch.cfAccessSecret)
      ? cleanSecret(patch.cfAccessSecret, "cfAccessSecret")
      : null;
    const setCf = !clearCf && (cfId !== null || cfSecret !== null);
    const hadCf = Boolean(found.cfAccessIdSealed && found.cfAccessSecretSealed);

    const reprobe =
      token !== null ||
      setCf ||
      (clearCf && hadCf) ||
      baseUrl !== found.baseUrl ||
      allowPrivate !== (found.allowPrivate === true) ||
      caCert !== found.caCert;

    if (!reprobe) {
      if (Object.keys(changes).length) {
        const db = await dbClient(ctx);
        await db
          .update(t.connections)
          .set(changes)
          .where(eq(t.connections.id, found.id));
        await ctx.db.persist();
      }
      return view(found.id);
    }

    // Read a stored secret only when the change keeps it. A failed read
    // refuses the change: nothing is sent with an empty or missing value.
    const nextToken = token ?? (await readable(found.tokenSealed));
    if (!nextToken) {
      throw invalid(
        "The stored token can't be read; enter the token again with this change",
      );
    }
    let cfAccess: CoolifyTarget["cfAccess"] = null;
    if (setCf || (!clearCf && hadCf)) {
      const cfIdNext = cfId ?? (await readable(found.cfAccessIdSealed));
      const cfSecretNext =
        cfSecret ?? (await readable(found.cfAccessSecretSealed));
      if (!cfIdNext || !cfSecretNext) {
        throw invalid(
          hadCf
            ? "The stored Cloudflare Access token can't be read; enter both values again or clear them"
            : "cfAccessId and cfAccessSecret go together",
        );
      }
      cfAccess = { id: cfIdNext, secret: cfSecretNext };
    }
    const next: CoolifyTarget = {
      baseUrl,
      token: nextToken,
      cfAccess,
      allowPrivate,
      caCert,
    };

    const probe = await probeTarget(next);
    refuseOldCoolify(probe);
    const tokenSealed =
      token !== null ? await ctx.secrets.seal(token) : found.tokenSealed;
    Object.assign(changes, probeColumns(baseUrl, probe), {
      baseUrl,
      allowPrivate,
      caCert,
      tokenSealed,
    });
    const cfChanged = clearCf || setCf;
    if (cfChanged) {
      changes.cfAccessIdSealed = cfAccess
        ? await ctx.secrets.seal(cfAccess.id)
        : null;
      changes.cfAccessSecretSealed = cfAccess
        ? await ctx.secrets.seal(cfAccess.secret)
        : null;
    }

    // Under the lock nothing else has written this row since it was read.
    const db = await dbClient(ctx);
    await db
      .update(t.connections)
      .set(changes)
      .where(eq(t.connections.id, found.id));
    await ctx.db.persist();
    return view(found.id);
  }

  async function removeNow(
    id: number,
    opts: { removeHosts?: boolean },
  ): Promise<ConnectionView> {
    const found = await owned(id);
    const gone = toView(found, "owner");
    // Lock order: this connection lock, then host sync's queue (inside
    // release). Host sync never takes this lock, so the two can't deadlock.
    await release(
      found.id,
      { removeHosts: opts.removeHosts === true },
      async () => {
        const db = await dbClient(ctx);
        const byConnection = [
          t.grants,
          t.servers,
          t.cache,
          t.events,
          t.onboardings,
          t.statusPages,
          t.dnsRecords,
          t.recent,
        ].map((table) =>
          db.delete(table).where(eq(table.connectionId, found.id)),
        );
        await ctx.db.batch([
          ...byConnection,
          db.delete(t.connections).where(eq(t.connections.id, found.id)),
        ]);
        await ctx.db.persist();
        clients.delete(found.id);
      },
    );
    return gone;
  }

  return {
    async list(): Promise<ConnectionView[]> {
      const userId = actor();
      if (!userId) return [];
      const db = await dbClient(ctx);
      const own = (await db
        .select()
        .from(t.connections)
        .where(eq(t.connections.userId, userId))
        .orderBy(t.connections.id)) as ConnectionRow[];
      const grants = (await db
        .select()
        .from(t.grants)
        .where(eq(t.grants.userId, userId))) as {
        connectionId: number;
        level: string;
      }[];
      const levels = new Map(
        grants
          .filter((g) => GRANT_LEVELS.has(g.level))
          .map((g) => [g.connectionId, g.level as AccessLevel]),
      );
      const shared = levels.size
        ? ((await db
            .select()
            .from(t.connections)
            .where(inArray(t.connections.id, [...levels.keys()]))
            .orderBy(t.connections.id)) as ConnectionRow[])
        : [];
      return [
        ...own.map((r) => toView(r, "owner")),
        ...shared
          .filter((r) => r.userId !== userId)
          .map((r) => toView(r, levels.get(r.id)!)),
      ];
    },

    async get(id: number): Promise<ConnectionView | null> {
      const found = await row(id);
      const access = found ? await accessTo(found, actor()) : null;
      return found && access ? toView(found, access) : null;
    },

    async access(id: number): Promise<AccessLevel | null> {
      const found = await row(id);
      return found ? accessTo(found, actor()) : null;
    },

    /** Probes first; refuses Coolify older than 4.4 and stores nothing then. */
    async create(input: ConnectionInput): Promise<ConnectionView> {
      const userId = actor();
      if (!userId) throw notFound();
      const name = cleanName(input.name);
      const baseUrl = cleanUrl(input.baseUrl);
      const token = cleanSecret(input.token, "token");
      const hasId = present(input.cfAccessId);
      const hasSecret = present(input.cfAccessSecret);
      if (hasId !== hasSecret) {
        throw invalid("cfAccessId and cfAccessSecret go together");
      }
      const cfAccess = hasId
        ? {
            id: cleanSecret(input.cfAccessId, "cfAccessId"),
            secret: cleanSecret(input.cfAccessSecret, "cfAccessSecret"),
          }
        : null;
      const allowPrivate = input.allowPrivate === true;
      const caCert = cleanCert(input.caCert);

      const probe = await probeTarget({
        baseUrl,
        token,
        cfAccess,
        allowPrivate,
        caCert,
      });
      refuseOldCoolify(probe);

      const tokenSealed = await ctx.secrets.seal(token);
      const db = await dbClient(ctx);
      await db.insert(t.connections).values({
        userId,
        name,
        baseUrl,
        tokenSealed,
        cfAccessIdSealed: cfAccess ? await ctx.secrets.seal(cfAccess.id) : null,
        cfAccessSecretSealed: cfAccess
          ? await ctx.secrets.seal(cfAccess.secret)
          : null,
        allowPrivate,
        caCert,
        ...probeColumns(baseUrl, probe),
      });
      await ctx.db.persist();
      // No returning(): read the row back by the sealed token just written.
      const [created] = (await db
        .select()
        .from(t.connections)
        .where(
          and(
            eq(t.connections.userId, userId),
            eq(t.connections.tokenSealed, tokenSealed),
          ),
        )
        .orderBy(desc(t.connections.id))
        .limit(1)) as ConnectionRow[];
      return toView(created, "owner");
    },

    /**
     * Owner only. Re-probes when the address, token or TLS settings change.
     * A replacement token or Cloudflare Access value is used as sent, so it
     * repairs a connection whose stored one can no longer be read; a stored
     * secret is read only when the change keeps it and needs a probe.
     */
    async update(id: number, patch: ConnectionPatch): Promise<ConnectionView> {
      return withLock(id, () => updateNow(id, patch));
    },

    /**
     * Owner only, whatever a grant says: turns coolify.exec on or off for
     * this connection. Audited.
     */
    async setExec(id: number, enabled: boolean): Promise<ConnectionView> {
      if (typeof enabled !== "boolean") {
        throw invalid("execEnabled must be true or false");
      }
      // Whatever called it (the route, the action), not only core's gate.
      if ((await ctx.rbac.has("configure")) !== true) {
        throw new ConnectionError(
          "forbidden",
          "Changing this needs Configure Coolify.",
        );
      }
      const found = await owned(id);
      const db = await dbClient(ctx);
      await db
        .update(t.connections)
        .set({ execEnabled: enabled })
        .where(eq(t.connections.id, found.id));
      await ctx.db.persist();
      await ctx.audit.record({
        action: "coolify_exec_setting_changed",
        resourceType: "coolify_connection",
        resourceId: String(found.id),
        resourceName: found.name,
        details: JSON.stringify({ execEnabled: enabled }),
        success: true,
      });
      return view(found.id);
    },

    /**
     * Owner only. Releases the Linked hosts first (unlinks them, or removes
     * them with `removeHosts`), then deletes the connection and every plugin
     * row that belongs to it. The team webhook row stays: other connections
     * to the same team share it.
     */
    async remove(
      id: number,
      opts: { removeHosts?: boolean } = {},
    ): Promise<ConnectionView> {
      return withLock(id, () => removeNow(id, opts));
    },

    /** The unsealed target. Only for calling Coolify; never return or log it. */
    async target(id: number): Promise<CoolifyTarget> {
      return targetOf((await reach(id)).row);
    },

    /**
     * A hash of the connection's target: its address, sealed token, sealed
     * Cloudflare Access values and TLS settings. It changes whenever any of
     * them does, and holds no secret. Null when the actor can't reach it.
     */
    async revision(id: number): Promise<string | null> {
      const found = await row(id);
      if (!found || !(await accessTo(found, actor()))) return null;
      return revisionOf(found);
    },

    /**
     * One read of the connection, for work that spans several awaits (host
     * sync): its view, whose `revision` names the target, a Coolify client
     * for that same target, and its Cloudflare Access token, unsealed on
     * first use from that same row. A later change to the connection can't
     * mix into it. The token is only for host settings; never return or log
     * it.
     */
    async snapshot(id: number): Promise<{
      view: ConnectionView;
      api: CoolifyApi;
      /** The request layer for that same target, for the generic API. */
      http: CoolifyHttp;
      cfAccess: () => Promise<CoolifyTarget["cfAccess"]>;
      /**
       * The token and Access secret of that same row, for masking them in
       * text passed on as it came (logs). Never return or log them.
       */
      secrets: () => Promise<string[]>;
    }> {
      const { row: found, access } = await reach(id);
      const { api, http } = await cachedClient(found);
      let cfAccess: Promise<CoolifyTarget["cfAccess"]> | null = null;
      const unsealAccess = async () => {
        const cfId = await unsealOrNull(found.cfAccessIdSealed);
        const cfSecret = await unsealOrNull(found.cfAccessSecretSealed);
        return cfId && cfSecret ? { id: cfId, secret: cfSecret } : null;
      };
      return {
        view: toView(found, access),
        api,
        http,
        cfAccess: () => (cfAccess ??= unsealAccess()),
        secrets: async () =>
          [
            await readable(found.tokenSealed),
            await readable(found.cfAccessSecretSealed),
          ].filter((v): v is string => v !== null),
      };
    },

    /**
     * One read of the connection for background or public work with no actor
     * (status pages): its owner, its revision and a client for that same
     * target, built on first use. Null when the connection is gone. It skips
     * the access check, so the caller checks the owner's access before using
     * anything it reads.
     */
    async unattendedSnapshot(id: number): Promise<{
      userId: string;
      revision: string;
      api: () => Promise<CoolifyApi>;
    } | null> {
      const found = await row(id);
      if (!found) return null;
      return {
        userId: found.userId,
        revision: revisionOf(found),
        api: async () => (await cachedClient(found)).api,
      };
    },

    async api(id: number): Promise<CoolifyApi> {
      return (await cachedClient((await reach(id)).row)).api;
    },

    /**
     * Runs the probe again and stores what it found, unless the connection
     * now points somewhere else. Any access level may.
     */
    async probe(
      id: number,
    ): Promise<{ connection: ConnectionView; probe: ProbeResult }> {
      const { row: found } = await reach(id);
      const { http, api } = await cachedClient(found);
      const probe = await runProbe(api, http);
      // Stored under the lock, and only while the connection still points
      // at the probed target: a change that replaced it meanwhile wins, and
      // this result, about the old target, is dropped.
      await withLock(found.id, async () => {
        const db = await dbClient(ctx);
        await db
          .update(t.connections)
          .set(probeColumns(found.baseUrl, probe))
          .where(sameTarget(found));
        await ctx.db.persist();
      });
      return { connection: await view(found.id), probe };
    },
  };
}

export type Connections = ReturnType<typeof createConnections>;
