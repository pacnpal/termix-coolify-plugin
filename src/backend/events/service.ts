import { and, desc, eq, lt, or } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError, type Connections } from "../connections/service.js";
import { redactLog } from "../containers/logs.js";
import { dbClient, type Tables } from "../db.js";
import { redact } from "../redact.js";
import type { Sync } from "../sync/service.js";
import {
  EVENT_KINDS,
  EVENT_SOURCES,
  eventId,
  isEventKind,
  PAYLOAD_KEYS,
  type EventKind,
  type EventSeverity,
  type EventSource,
} from "./kinds.js";

/** The event log keeps this many of each connection's newest events. */
export const EVENT_LOG_LIMIT = 1000;

/** A page of the event log is at most this long. */
export const EVENT_PAGE_MAX = 200;
const EVENT_PAGE_DEFAULT = 50;

const MINUTE_MS = 60_000;
/** How far ahead of the clock a source's own time may be and still count. */
const CLOCK_SKEW_MS = MINUTE_MS;

const NAME_MAX = 255;
const STATUS_MAX = 64;
const FIELD_TEXT_MAX = 500;
const FIELDS_MAX = 20;

/** A Coolify uuid: one plain segment, never a path. */
const UUID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Field names that hold log or command output: dropped whole, never stored. */
const LOG_FIELD = /(?:^|_)(?:logs?|output|stdout|stderr)$/i;

/**
 * One thing a source saw happen on one connection's Coolify, as the poller
 * (#90) or the team webhook (#91) hands it to `events.ingest`. Everything in
 * it is what Coolify sent, so the pipeline treats all of it as untrusted:
 * uuids must be plain segments, text keeps only its first line, redacted and
 * capped, and `fields` keeps only top-level scalars whose names are not
 * log-shaped, redacted.
 */
export interface SourceEvent {
  kind: EventKind;
  source: EventSource;
  /** The resource it is about; required for resource kinds. */
  resourceUuid?: string | null;
  /**
   * The server it is about, or its resource's server. Required for server
   * kinds; for the rest, it gives the event a hostId when that server is
   * Linked.
   */
  serverUuid?: string | null;
  /** When set, the event is deduped by it alone: one event per deployment. */
  deploymentUuid?: string | null;
  /** The subject's name, as Coolify has it. */
  name?: string | null;
  /** Coolify's status word (finished, failed, ...). */
  status?: string | null;
  /**
   * When it happened by the source, in epoch milliseconds; picks the dedupe
   * minute. Missing, invalid or more than a minute ahead: the clock's.
   */
  at?: number | null;
  /** Anything else worth keeping (a disk percentage, a task name). */
  fields?: Record<string, unknown> | null;
}

export type IngestDropReason =
  /** Not a known kind or source, a malformed uuid, or a missing subject. */
  | "invalid"
  /** The connection was removed. */
  | "connection-gone"
  /** The connection points elsewhere than when the source read Coolify. */
  | "target-changed"
  /** The connection's owner no longer has coolify.view. */
  | "no-access";

export type IngestResult =
  | { outcome: "stored"; event: EventRecord }
  | { outcome: "duplicate" }
  | { outcome: "dropped"; reason: IngestDropReason };

export type EventField = string | number | boolean | null;

/** One event log row, as the event log read answers it. Holds no secret. */
export interface EventRecord {
  id: number;
  connectionId: number;
  kind: EventKind;
  severity: EventSeverity;
  title: string;
  resourceUuid: string | null;
  serverUuid: string | null;
  deploymentUuid: string | null;
  /** The Linked host of serverUuid when the event was stored, or null. */
  hostId: number | null;
  name: string | null;
  status: string | null;
  source: EventSource;
  fields: Record<string, EventField>;
  createdAt: string;
}

export interface EventQuery {
  /** 1 to EVENT_PAGE_MAX; 50 when missing. */
  limit?: unknown;
  /** Only events with a smaller id: the previous page's nextBefore. */
  before?: unknown;
  /** One event kind. */
  kind?: unknown;
  /** A resource or server uuid. */
  uuid?: unknown;
}

export interface EventPage {
  rows: EventRecord[];
  /** Pass as `before` for the next page; null when there is none. */
  nextBefore: number | null;
}

interface Clean {
  kind: EventKind;
  source: EventSource;
  resourceUuid: string | null;
  serverUuid: string | null;
  deploymentUuid: string | null;
  name: string | null;
  status: string | null;
  fields: Record<string, EventField>;
  dedupeKey: string;
}

interface EventRow {
  id: number;
  connectionId: number;
  kind: string;
  resourceUuid: string | null;
  deploymentUuid: string | null;
  hostId: number | null;
  title: string;
  detail: unknown;
  createdAt: string;
  serverUuid: string | null;
}

/** A uuid if `value` is one, null if absent, undefined if malformed. */
function uuidOf(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

/** The first line of `value`, redacted and capped, or null. */
function textOf(
  value: unknown,
  max: number,
  secrets: readonly string[],
): string | null {
  if (typeof value !== "string") return null;
  // Redacted whole first, so a key block or a secret spanning lines is
  // masked before the rest of the text is dropped as log-shaped.
  const [first] = redactLog(value, secrets).split(/\r\n|\r|\n/, 1);
  const line = first.trim().slice(0, max);
  return line === "" ? null : line;
}

/**
 * Top-level scalars of `raw` with plain names that aren't log output,
 * secret-named ones masked (redact.ts), text as textOf. Nested values,
 * arrays and anything past FIELDS_MAX are dropped.
 */
function fieldsOf(
  raw: unknown,
  secrets: readonly string[],
): Record<string, EventField> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const picked: Record<string, EventField> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(picked).length >= FIELDS_MAX) break;
    if (!FIELD_NAME.test(key) || LOG_FIELD.test(key)) continue;
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      picked[key] = value;
    }
  }
  const masked = redact(picked) as Record<string, EventField>;
  const out: Record<string, EventField> = {};
  for (const [key, value] of Object.entries(masked)) {
    out[key] =
      typeof value === "string"
        ? (textOf(value, FIELD_TEXT_MAX, secrets) ?? "")
        : value;
  }
  return out;
}

/** The dedupe minute: the source's time when it is believable. */
function minuteOf(at: unknown, now: number): number {
  const when =
    typeof at === "number" &&
    Number.isFinite(at) &&
    at > 0 &&
    at <= now + CLOCK_SKEW_MS
      ? at
      : now;
  return Math.floor(when / MINUTE_MS);
}

/**
 * The one key two sightings of the same event share: the deployment uuid
 * when there is one, else the kind, the subject and the minute.
 */
export function dedupeKeyOf(
  kind: EventKind,
  subject: { resourceUuid: string | null; serverUuid: string | null },
  deploymentUuid: string | null,
  minute: number,
): string {
  if (deploymentUuid) return `deployment|${deploymentUuid}`;
  const on = subject.resourceUuid ?? subject.serverUuid ?? "";
  return `${kind}|${on}|${minute}`;
}

/** The event made safe to keep, or null when it can't be trusted. */
function cleanEvent(
  raw: unknown,
  secrets: readonly string[],
  now: number,
): Clean | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (!isEventKind(e.kind)) return null;
  const source = EVENT_SOURCES.find((s) => s === e.source);
  if (!source) return null;
  let resourceUuid = uuidOf(e.resourceUuid);
  let serverUuid = uuidOf(e.serverUuid);
  const deploymentUuid = uuidOf(e.deploymentUuid);
  if (
    resourceUuid === undefined ||
    serverUuid === undefined ||
    deploymentUuid === undefined
  ) {
    return null;
  }
  const { subject } = EVENT_KINDS[e.kind];
  if (subject === "resource" && !resourceUuid) return null;
  if (subject === "server") {
    if (!serverUuid) return null;
    resourceUuid = null;
  }
  if (subject === "any" && !resourceUuid && !serverUuid) return null;
  if (subject === "team") {
    resourceUuid = null;
    serverUuid = null;
  }
  return {
    kind: e.kind,
    source,
    resourceUuid,
    serverUuid,
    deploymentUuid,
    name: textOf(e.name, NAME_MAX, secrets),
    status: textOf(e.status, STATUS_MAX, secrets),
    fields: fieldsOf(e.fields, secrets),
    dedupeKey: dedupeKeyOf(
      e.kind,
      { resourceUuid, serverUuid },
      deploymentUuid,
      minuteOf(e.at, now),
    ),
  };
}

function titleOf(kind: EventKind, name: string | null): string {
  const { title } = EVENT_KINDS[kind];
  return name ? `${title}: ${name}` : title;
}

function parseDetail(detail: unknown): Record<string, unknown> {
  let value = detail;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toRecord(row: EventRow): EventRecord | null {
  if (!isEventKind(row.kind)) return null;
  const detail = parseDetail(row.detail);
  const fields = parseDetail(detail.fields) as Record<string, EventField>;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: row.id,
    connectionId: row.connectionId,
    kind: row.kind,
    severity: EVENT_KINDS[row.kind].severity,
    title: row.title,
    resourceUuid: row.resourceUuid,
    serverUuid: row.serverUuid,
    deploymentUuid: row.deploymentUuid,
    hostId: row.hostId,
    name: text(detail.name),
    status: text(detail.status),
    source: detail.source === "webhook" ? "webhook" : "poll",
    // Stored redacted; masked again on the way out all the same.
    fields: redact(fields) as Record<string, EventField>,
    createdAt: row.createdAt,
  };
}

/** The operations event payload: exactly the keys manifest.json declares. */
function payloadOf(event: EventRecord): Record<string, unknown> {
  const all: Record<string, unknown> = {
    connectionId: event.connectionId,
    uuid: event.resourceUuid,
    serverUuid: event.serverUuid,
    name: event.name,
    deploymentUuid: event.deploymentUuid,
    status: event.status,
  };
  return Object.fromEntries(
    PAYLOAD_KEYS[EVENT_KINDS[event.kind].subject].map((key) => [key, all[key]]),
  );
}

function invalid(message: string): ConnectionError {
  return new ConnectionError("invalid-input", message);
}

function readQuery(query: EventQuery) {
  const int = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{1,15}$/.test(value)
          ? Number(value)
          : Number.NaN;
    return Number.isSafeInteger(n) ? n : Number.NaN;
  };
  const limit = int(query.limit) ?? EVENT_PAGE_DEFAULT;
  if (Number.isNaN(limit) || limit < 1 || limit > EVENT_PAGE_MAX) {
    throw invalid(`limit must be 1 to ${EVENT_PAGE_MAX}`);
  }
  const before = int(query.before);
  if (before !== null && (Number.isNaN(before) || before < 1)) {
    throw invalid("before must be an event id");
  }
  const kind =
    query.kind === undefined || query.kind === null || query.kind === ""
      ? null
      : query.kind;
  if (kind !== null && !isEventKind(kind)) throw invalid("Unknown event kind");
  const uuid = uuidOf(query.uuid);
  if (uuid === undefined) throw invalid("uuid must be a Coolify uuid");
  return { limit, before, kind, uuid };
}

export interface EventsDeps {
  tables: Tables;
  connections: Connections;
  sync: Sync;
  /** The clock, in epoch milliseconds; tests pass a fake one. */
  now?: () => number;
}

/**
 * The one event pipeline (design: "Alerts and live events"). A source hands
 * it what it saw with `ingest`; the pipeline drops what it can't trust,
 * dedupes, redacts, stores the event in the connection's event log (the
 * newest EVENT_LOG_LIMIT kept), and emits it as the declared operations
 * event `coolify.<kind>`, with hostId only when the subject's server is
 * Linked. Nothing else writes the event table or emits these events.
 *
 * Ingests for one connection run one at a time, in arrival order: the
 * dedupe read, the insert and the prune never interleave. This relies on one
 * plugin process per Termix server, like the connections service's lock;
 * the unique (connectionId, dedupeKey) index backs it up.
 */
export function createEvents(ctx: PluginContext, deps: EventsDeps) {
  const t = deps.tables.events;
  const { connections, sync } = deps;
  const now = deps.now ?? (() => Date.now());
  const queues = new Map<number, Promise<unknown>>();

  function serialized<T>(key: number, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  async function byKey(
    connectionId: number,
    dedupeKey: string,
  ): Promise<EventRow | null> {
    const db = await dbClient(ctx);
    const [row] = (await db
      .select()
      .from(t)
      .where(and(eq(t.connectionId, connectionId), eq(t.dedupeKey, dedupeKey)))
      .limit(1)) as EventRow[];
    return row ?? null;
  }

  /** Deletes the connection's events older than its newest EVENT_LOG_LIMIT. */
  async function prune(connectionId: number): Promise<void> {
    const db = await dbClient(ctx);
    const [edge] = (await db
      .select({ id: t.id })
      .from(t)
      .where(eq(t.connectionId, connectionId))
      .orderBy(desc(t.id))
      .limit(1)
      .offset(EVENT_LOG_LIMIT - 1)) as { id: number }[];
    if (!edge) return;
    await db
      .delete(t)
      .where(and(eq(t.connectionId, connectionId), lt(t.id, edge.id)));
  }

  async function dropRow(id: number): Promise<void> {
    const db = await dbClient(ctx);
    await db.delete(t).where(eq(t.id, id));
    await ctx.db.persist();
  }

  /**
   * The connection as the source read it, or why it no longer counts
   * (`reason`). One shape for both: the SDK's tsconfig has no strict null
   * checks, so a union wouldn't narrow.
   */
  async function current(
    connectionId: number,
    revision: string,
  ): Promise<{
    reason: IngestDropReason | null;
    userId: string;
    secrets: () => Promise<string[]>;
  }> {
    const none = async () => [] as string[];
    const snap = await connections.unattendedSnapshot(connectionId);
    if (!snap) return { reason: "connection-gone", userId: "", secrets: none };
    if (snap.revision !== revision) {
      return { reason: "target-changed", userId: "", secrets: none };
    }
    return { reason: null, userId: snap.userId, secrets: snap.secrets };
  }

  async function ingestNow(
    connectionId: number,
    event: SourceEvent,
    revision: string,
  ): Promise<IngestResult> {
    const conn = await current(connectionId, revision);
    if (conn.reason) return { outcome: "dropped", reason: conn.reason };
    if (!(await ctx.rbac.hasFor(conn.userId, "view"))) {
      return { outcome: "dropped", reason: "no-access" };
    }
    const at = now();
    const clean = cleanEvent(event, await conn.secrets(), at);
    if (!clean) return { outcome: "dropped", reason: "invalid" };
    if (await byKey(connectionId, clean.dedupeKey)) {
      return { outcome: "duplicate" };
    }
    const linked = clean.serverUuid
      ? await sync.linkedHostFor(connectionId, clean.serverUuid)
      : null;
    const hostId =
      typeof linked === "number" && Number.isSafeInteger(linked) && linked > 0
        ? linked
        : null;

    const db = await dbClient(ctx);
    await db.insert(t).values({
      connectionId,
      kind: clean.kind,
      resourceUuid: clean.resourceUuid,
      serverUuid: clean.serverUuid,
      deploymentUuid: clean.deploymentUuid,
      hostId,
      title: titleOf(clean.kind, clean.name),
      detail: JSON.stringify({
        name: clean.name,
        status: clean.status,
        source: clean.source,
        fields: clean.fields,
      }),
      createdAt: new Date(at).toISOString(),
      dedupeKey: clean.dedupeKey,
    });
    // No returning(): read the row back by its unique dedupe key.
    const row = await byKey(connectionId, clean.dedupeKey);
    const stored = row ? toRecord(row) : null;
    if (!stored) throw new Error("The event could not be stored");
    // A removal or a repoint that landed meanwhile wins: its rows are gone
    // (or about another target), so this one goes too and nothing is sent.
    const still = await current(connectionId, revision);
    if (still.reason) {
      await dropRow(stored.id);
      return { outcome: "dropped", reason: still.reason };
    }
    await prune(connectionId);
    await ctx.db.persist();
    try {
      await ctx.operations.emit(
        eventId(stored.kind),
        payloadOf(stored),
        hostId ? { hostId } : undefined,
      );
    } catch (err) {
      // Stored and sent together or not at all: a source that retries
      // isn't then told it's a duplicate of an event nobody received.
      await dropRow(stored.id);
      throw err;
    }
    return { outcome: "stored", event: stored };
  }

  return {
    /**
     * The source interface: hand the pipeline one event seen on connection
     * `connectionId`, with the connection `revision` the source read Coolify
     * under. It needs no actor (sources run in the background or on a public
     * webhook route) and never throws for a bad event: it answers stored,
     * duplicate or dropped with a reason. It throws only when the database
     * or the emit fails, and then nothing is kept.
     */
    async ingest(
      connectionId: number,
      event: SourceEvent,
      read: { revision: string },
    ): Promise<IngestResult> {
      if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
        return { outcome: "dropped", reason: "connection-gone" };
      }
      return serialized(connectionId, () =>
        ingestNow(connectionId, event, read.revision),
      );
    },

    /**
     * A page of a connection's event log, newest first. Needs coolify.view
     * and any access to the connection; another user's is 404.
     */
    async list(connectionId: number, query: EventQuery): Promise<EventPage> {
      if (!(await ctx.rbac.has("view"))) {
        throw new ConnectionError("forbidden", "Missing coolify.view");
      }
      if (!(await connections.access(connectionId))) {
        throw new ConnectionError("not-found", "Coolify connection not found");
      }
      const q = readQuery(query);
      const conditions = [eq(t.connectionId, connectionId)];
      if (q.before !== null) conditions.push(lt(t.id, q.before));
      if (q.kind !== null) conditions.push(eq(t.kind, q.kind));
      if (q.uuid !== null) {
        conditions.push(
          or(eq(t.resourceUuid, q.uuid), eq(t.serverUuid, q.uuid)),
        );
      }
      const db = await dbClient(ctx);
      const found = (await db
        .select()
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.id))
        .limit(q.limit + 1)) as EventRow[];
      const page = found.slice(0, q.limit);
      const rows = page
        .map(toRecord)
        .filter((r): r is EventRecord => r !== null);
      return {
        rows,
        nextBefore:
          found.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  };
}

export type Events = ReturnType<typeof createEvents>;
