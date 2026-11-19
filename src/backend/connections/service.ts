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
  "invalid-input" | "forbidden" | "not-found" | "conflict";

const ERROR_STATUS = {
  "invalid-input": 400,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
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
 * Called before a connection's rows are deleted, with its id, so the hosts
 * linked to its servers can be unlinked (or removed when `removeHosts`).
 * Host sync supplies it; until then there are no Linked hosts to release.
 */
export type ReleaseLinkedHosts = (
  connectionId: number,
  opts: { removeHosts: boolean },
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

/**
 * Where a URL's host is: loopback (localhost, 127.0.0.0/8, ::1), an IP
 * literal in a private or link-local range, or anything else. Any other name
 * counts as "name": the plugin can't resolve it, and a name can point
 * anywhere, so it is never trusted to be private.
 */
function hostReach(url: URL): "loopback" | "private-ip" | "other" {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return "loopback";
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return "loopback";
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    return isPrivate ? "private-ip" : "other";
  }
  if (host.includes(":")) {
    if (host === "::1") return "loopback";
    // fc00::/7 unique local, fe80::/10 link-local.
    return /^(f[cd]|fe[89ab])/.test(host) ? "private-ip" : "other";
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
  const reach = hostReach(url);
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
    access,
    allowPrivate: row.allowPrivate === true,
    caCert: row.caCert,
    cfAccess: Boolean(row.cfAccessIdSealed && row.cfAccessSecretSealed),
    lastCheckedAt: row.lastCheckedAt,
    steps: stored.steps,
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
    options.releaseLinkedHosts ?? (async () => {});
  const clients = new Map<
    number,
    { key: string; http: CoolifyHttp; api: CoolifyApi }
  >();

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
    const key = JSON.stringify([
      found.baseUrl,
      found.tokenSealed,
      found.cfAccessIdSealed,
      found.cfAccessSecretSealed,
      found.allowPrivate,
      found.caCert,
    ]);
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
      const clearCf =
        patch.cfAccessId === null && patch.cfAccessSecret === null;
      const cfId = present(patch.cfAccessId)
        ? cleanSecret(patch.cfAccessId, "cfAccessId")
        : null;
      const cfSecret = present(patch.cfAccessSecret)
        ? cleanSecret(patch.cfAccessSecret, "cfAccessSecret")
        : null;
      const setCf = !clearCf && (cfId !== null || cfSecret !== null);
      const hadCf = Boolean(
        found.cfAccessIdSealed && found.cfAccessSecretSealed,
      );

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

      // Lands only if nothing replaced the target while the probe ran.
      const db = await dbClient(ctx);
      await db.update(t.connections).set(changes).where(sameTarget(found));
      await ctx.db.persist();
      const after = await row(found.id);
      if (!after) throw notFound();
      // The affected-row count isn't the same across SQLite, PostgreSQL and
      // MySQL, so read the row back: the write landed (or nothing it set was
      // lost) only if every field it wrote holds what it wrote.
      const stored = after as unknown as Record<string, unknown>;
      const landed = Object.entries(changes).every(([key, value]) =>
        typeof value === "boolean"
          ? Boolean(stored[key]) === value
          : stored[key] === value,
      );
      if (!landed) {
        throw new ConnectionError(
          "conflict",
          "The connection changed while this change was being checked; reload it and try again",
        );
      }
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
      const found = await owned(id);
      const gone = toView(found, "owner");
      await release(found.id, { removeHosts: opts.removeHosts === true });
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
      return gone;
    },

    /** The unsealed target. Only for calling Coolify; never return or log it. */
    async target(id: number): Promise<CoolifyTarget> {
      return targetOf((await reach(id)).row);
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
      // A change that replaced the target meanwhile wins: this result is
      // about the old one and is dropped.
      const db = await dbClient(ctx);
      await db
        .update(t.connections)
        .set(probeColumns(found.baseUrl, probe))
        .where(sameTarget(found));
      await ctx.db.persist();
      return { connection: await view(found.id), probe };
    },
  };
}

export type Connections = ReturnType<typeof createConnections>;
