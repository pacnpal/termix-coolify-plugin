import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError, type Connections } from "../connections/service.js";
import { dbClient, type Tables } from "../db.js";
import type { Resources } from "../resources/service.js";
import { resourceHealth } from "../../shared/resource-health.js";
import { knownBaseUrl } from "./base-url.js";
import type { StatusView } from "./render.js";

/** The background refresh's id, listed in the manifest's sandbox.schedules. */
export const STATUS_REFRESH_ID = "status-refresh";
export const STATUS_REFRESH_MS = 60_000;
const STATUS_REFRESH_JITTER_MS = 10_000;
/** The reason given to ctx.schedule.keepAwake while a page is published. */
export const KEEP_AWAKE_REASON = "status pages";
/** Older cached status shows "Status may be out of date". */
export const STALE_AFTER_MS = 5 * 60_000;
/** Waits after 1, 2, 3 and 4 or more failed refreshes in a row. */
export const BACKOFF_MS = [1, 2, 5, 15].map((m) => m * 60_000);
/** How long a one-time URL waits in memory to be taken. */
export const HANDOFF_TTL_MS = 5 * 60_000;
/** Cached rows younger than this aren't fetched again by the refresh. */
const FRESH_ENOUGH_MS = 20_000;

const MAX_TITLE = 100;
const MAX_RESOURCES = 100;
const UUID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HANDOFF_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

// ---------------------------------------------------------------------------
// Tokens

/** A new page token: 32 random bytes, base64url. Never stored. */
export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** What the table keeps instead of the token: its sha256, as hex. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Whether `token` hashes to `storedHash`, compared in constant time. */
export function tokenMatches(storedHash: string, token: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(hashToken(token), "hex"),
  );
}

// ---------------------------------------------------------------------------
// One-time URL handoff

const handoffs = new Map<string, { url: string; expiresAt: number }>();

function handoffKey(userId: string, handoffId: string): string {
  return `${userId}\u0000${handoffId}`;
}

function sweep(now: number): void {
  for (const [key, entry] of handoffs) {
    if (entry.expiresAt <= now) handoffs.delete(key);
  }
}

/**
 * Keeps a page URL in this process's memory for at most 5 minutes, for one
 * user and one run. Never written to the store, a log or run data.
 */
export function stashOnceUrl(
  userId: string,
  handoffId: string,
  url: string,
): void {
  if (!userId || !handoffId || !url) return;
  const now = Date.now();
  sweep(now);
  handoffs.set(handoffKey(userId, handoffId), {
    url,
    expiresAt: now + HANDOFF_TTL_MS,
  });
}

/**
 * The URL once, to the user who ran the action, then forgotten. Another
 * user, another run's id, a second call or an expired entry gets null.
 */
export function takeOnceUrl(userId: string, handoffId: string): string | null {
  if (!userId || !handoffId) return null;
  const now = Date.now();
  sweep(now);
  const key = handoffKey(userId, handoffId);
  const entry = handoffs.get(key);
  if (!entry) return null;
  handoffs.delete(key);
  return entry.url;
}

/** A handoff id from a path or a tool argument, or null when it can't be one. */
export function handoffIdOf(value: unknown): string | null {
  return typeof value === "string" && HANDOFF_ID.test(value) ? value : null;
}

/** The handler's handoff id: its run id, or a random id when there is none. */
export function handoffIdFor(runId: string | null): string {
  return runId && HANDOFF_ID.test(runId)
    ? runId
    : `handoff-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Pages

/** A page as its owner sees it. Never holds the token or its hash. */
export interface StatusPageView {
  id: number;
  connectionId: number;
  title: string;
  resources: string[];
  createdAt: string | null;
}

interface StatusPageRow {
  id: number;
  connectionId: number;
  tokenHash: string;
  resources: unknown;
  title: string;
  createdAt: unknown;
  revokedAt: unknown;
}

export interface StatusPagesDeps {
  tables: Tables;
  connections: Connections;
  resources: Resources;
  /**
   * Uptime percentages by resource uuid, when the Uptime plugin runs. Left
   * out, the page shows no uptime.
   */
  uptime?: (
    connectionId: number,
    uuids: string[],
  ) => Promise<Record<string, number>>;
}

/** The public page's data: no uuids, servers, domains, logs or secrets. */
export type PublicStatus = StatusView;

function uuidList(value: unknown): string[] {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list)
    ? list.filter((u): u is string => typeof u === "string")
    : [];
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toView(row: StatusPageRow): StatusPageView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    title: row.title,
    resources: uuidList(row.resources),
    createdAt: isoOrNull(row.createdAt),
  };
}

function invalid(message: string): ConnectionError {
  return new ConnectionError("invalid-input", message);
}

const pageNotFound = () =>
  new ConnectionError("not-found", "Status page not found");

/** A refusal because an admin turned status pages off. */
export class StatusPagesOffError extends Error {
  readonly status = 403;
  readonly code = "status-pages-off";
  constructor() {
    super("An admin has turned off public status pages");
    this.name = "StatusPagesOffError";
  }
}

function cleanTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > MAX_TITLE) {
    throw invalid(`title must be 1 to ${MAX_TITLE} characters`);
  }
  return title;
}

function cleanResources(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid("resources must be a list of uuids");
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !UUID.test(item)) {
      throw invalid("resources must be a list of uuids");
    }
    if (!out.includes(item)) out.push(item);
  }
  if (out.length === 0 || out.length > MAX_RESOURCES) {
    throw invalid(`resources must name 1 to ${MAX_RESOURCES} resources`);
  }
  return out;
}

/**
 * Public read-only status pages. Owners publish, rotate and revoke them; the
 * token is shown once and only its sha256 is stored. The public view reads
 * the resource cache and never calls Coolify; a background job keeps that
 * cache fresh for connections with a published page.
 */
export function createStatusPages(ctx: PluginContext, deps: StatusPagesDeps) {
  const t = deps.tables.statusPages;
  // Per connection: failures in a row and when the next refresh may run.
  const backoff = new Map<number, { failures: number; nextAt: number }>();
  let awake: boolean | null = null;

  async function allowed(): Promise<boolean> {
    return (await ctx.settings.get("allowStatusPages")) !== false;
  }

  async function pageUrl(token: string): Promise<string> {
    const base = (await knownBaseUrl(ctx)) ?? "";
    return `${base}/plugin-api/${ctx.pluginId}/status/${token}`;
  }

  async function liveRows(): Promise<StatusPageRow[]> {
    const db = await dbClient(ctx);
    return (await db
      .select()
      .from(t)
      .where(isNull(t.revokedAt))
      .orderBy(t.id)) as StatusPageRow[];
  }

  async function pageRow(id: number): Promise<StatusPageRow | null> {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const db = await dbClient(ctx);
    const [found] = (await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.revokedAt)))
      .limit(1)) as StatusPageRow[];
    return found ?? null;
  }

  /** Only the connection's owner manages its pages; anyone else gets a 404. */
  async function ownConnection(connectionId: number): Promise<void> {
    const access = await deps.connections.access(connectionId);
    if (!access) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    if (access !== "owner") {
      throw new ConnectionError(
        "forbidden",
        "Only the connection's owner can manage its status pages",
      );
    }
  }

  async function ownPage(id: number): Promise<StatusPageRow> {
    const found = await pageRow(id);
    if (
      !found ||
      (await deps.connections.access(found.connectionId)) !== "owner"
    ) {
      throw pageNotFound();
    }
    return found;
  }

  /** keepAwake follows whether any page is published (and allowed). */
  async function syncAwake(): Promise<boolean> {
    const active = (await allowed()) && (await liveRows()).length > 0;
    if (awake !== active) {
      ctx.schedule.keepAwake?.(KEEP_AWAKE_REASON, active);
      awake = active;
    }
    if (!active) backoff.clear();
    return active;
  }

  function issueToken(): { token: string; tokenHash: string } {
    const token = newToken();
    return { token, tokenHash: hashToken(token) };
  }

  async function refreshOne(connectionId: number, now: number): Promise<void> {
    const state = backoff.get(connectionId);
    if (state && now < state.nextAt) return;
    const cached = await deps.resources.peekCached(connectionId);
    if (!state && cached && now - cached.fetchedAt < FRESH_ENOUGH_MS) return;
    try {
      await deps.resources.refreshUnattended(connectionId);
      backoff.delete(connectionId);
    } catch (err) {
      const failures = (state?.failures ?? 0) + 1;
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
      backoff.set(connectionId, { failures, nextAt: now + wait });
      // Only the error's name: a message could carry something from Coolify.
      ctx.log.warn(
        `status page refresh failed for connection ${connectionId}: ${(err as Error)?.name ?? "error"}`,
      );
    }
  }

  /**
   * The background job: refreshes the resource cache of each connection with
   * a published page, with the connection's own token and no actor. Backs
   * off 1, 2, 5, then 15 minutes after errors. Never throws.
   */
  async function refreshTick(): Promise<void> {
    try {
      if (!(await syncAwake())) return;
      const connectionIds = [
        ...new Set((await liveRows()).map((r) => r.connectionId)),
      ];
      const now = Date.now();
      for (const id of connectionIds) await refreshOne(id, now);
      for (const id of backoff.keys()) {
        if (!connectionIds.includes(id)) backoff.delete(id);
      }
    } catch (err) {
      ctx.log.warn(
        `status page refresh failed: ${(err as Error)?.name ?? "error"}`,
      );
    }
  }

  return {
    allowed,
    syncAwake,

    /** The actor's live pages, for one connection or all they own. */
    async list(connectionId?: number): Promise<StatusPageView[]> {
      if (connectionId !== undefined) {
        if (!(await deps.connections.access(connectionId))) {
          throw new ConnectionError(
            "not-found",
            "Coolify connection not found",
          );
        }
        return (await liveRows())
          .filter((r) => r.connectionId === connectionId)
          .map(toView);
      }
      const owned = new Set(
        (await deps.connections.list())
          .filter((c) => c.access === "owner")
          .map((c) => c.id),
      );
      return (await liveRows())
        .filter((r) => owned.has(r.connectionId))
        .map(toView);
    },

    /** The URL carries the token; it is returned here once and never again. */
    async create(
      connectionId: number,
      input: { title: unknown; resources: unknown },
    ): Promise<{ page: StatusPageView; url: string }> {
      await ownConnection(connectionId);
      if (!(await allowed())) throw new StatusPagesOffError();
      const title = cleanTitle(input.title);
      const resources = cleanResources(input.resources);
      const { token, tokenHash } = issueToken();
      const db = await dbClient(ctx);
      await db.insert(t).values({
        connectionId,
        tokenHash,
        resources: JSON.stringify(resources),
        title,
      });
      await ctx.db.persist();
      // No returning(): read the row back by its unique token hash.
      const [created] = (await db
        .select()
        .from(t)
        .where(eq(t.tokenHash, tokenHash))
        .limit(1)) as StatusPageRow[];
      await syncAwake();
      return { page: toView(created), url: await pageUrl(token) };
    },

    /** A new token; the old URL stops working at once. */
    async rotate(id: number): Promise<{ page: StatusPageView; url: string }> {
      const found = await ownPage(id);
      const { token, tokenHash } = issueToken();
      const db = await dbClient(ctx);
      await db
        .update(t)
        .set({ tokenHash })
        .where(and(eq(t.id, found.id), isNull(t.revokedAt)));
      await ctx.db.persist();
      return { page: toView(found), url: await pageUrl(token) };
    },

    async revoke(id: number): Promise<StatusPageView> {
      const found = await ownPage(id);
      const db = await dbClient(ctx);
      await db
        .update(t)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(t.id, found.id));
      await ctx.db.persist();
      await syncAwake();
      return toView(found);
    },

    /**
     * What the public route shows for a token, or null (404) for an unknown,
     * revoked or malformed token, or while status pages are turned off.
     * Reads only the cache: a page view never calls Coolify.
     */
    async publicView(token: string): Promise<PublicStatus | null> {
      if (!TOKEN.test(token)) return null;
      if (!(await allowed())) return null;
      const db = await dbClient(ctx);
      const [found] = (await db
        .select()
        .from(t)
        .where(eq(t.tokenHash, hashToken(token)))
        .limit(1)) as StatusPageRow[];
      if (!found || found.revokedAt || !tokenMatches(found.tokenHash, token)) {
        return null;
      }
      const chosen = uuidList(found.resources);
      const cached = await deps.resources.peekCached(found.connectionId);
      const now = Date.now();
      const byUuid = new Map((cached?.rows ?? []).map((r) => [r.uuid, r]));
      const rows = chosen
        .map((uuid) => byUuid.get(uuid))
        .filter((r): r is NonNullable<typeof r> => Boolean(r));
      const uptime = deps.uptime
        ? await deps
            .uptime(
              found.connectionId,
              rows.map((r) => r.uuid),
            )
            .catch(() => ({}) as Record<string, number>)
        : {};
      ctx.log.info(`status page ${found.id} viewed`);
      return {
        title: found.title,
        generatedAt: new Date(now).toISOString(),
        updatedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
        stale: !cached || now - cached.fetchedAt > STALE_AFTER_MS,
        items: rows.map((r) => ({
          name: r.name,
          status: resourceHealth(r.status),
          lastDeployAt: r.lastDeployAt,
          // The resource list doesn't carry the last deploy's result yet.
          lastDeployOk: null,
          ...(typeof uptime[r.uuid] === "number"
            ? { uptime: uptime[r.uuid] }
            : {}),
        })),
      };
    },

    refreshTick,

    /** Starts the job and tells core whether there is work to keep awake for. */
    async start(): Promise<void> {
      ctx.schedule.every(STATUS_REFRESH_MS, refreshTick, {
        id: STATUS_REFRESH_ID,
        jitterMs: STATUS_REFRESH_JITTER_MS,
      });
      await syncAwake();
    },
  };
}

export type StatusPages = ReturnType<typeof createStatusPages>;
