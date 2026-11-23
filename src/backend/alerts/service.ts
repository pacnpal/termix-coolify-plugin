import { and, eq } from "drizzle-orm";
import type {
  PluginContext,
  PluginNotification,
} from "@termix-ssh/plugin-sdk/backend";
import en from "../../../locales/en.json";
import { alertTabData, DEFAULT_ALERT_KINDS } from "../../shared/alerts.js";
import { fill } from "../../shared/template.js";
import { ConnectionError, type Connections } from "../connections/service.js";
import { redactLog } from "../containers/logs.js";
import { dbClient, type Tables } from "../db.js";
import { EVENT_KINDS, isEventKind, type EventKind } from "../events/kinds.js";
import type { EventRecord } from "../events/service.js";

/** Every event kind, in the order the preferences list them. */
export const ALERT_KINDS = Object.keys(EVENT_KINDS) as EventKind[];

/** One person's alert kinds for one connection. */
export interface AlertPrefs {
  connectionId: number;
  /** The kinds this person gets alerts for. */
  kinds: EventKind[];
  /** True while they picked none of their own (the defaults apply). */
  isDefault: boolean;
  /** What applies with no preferences saved. */
  defaults: EventKind[];
  /** Every kind there is. */
  available: EventKind[];
}

export interface AlertsDeps {
  tables: Tables;
  connections: Connections;
}

function errorName(err: unknown): string {
  return (err as Error)?.name ?? "error";
}

function invalid(message: string): ConnectionError {
  return new ConnectionError("invalid-input", message);
}

/** The stored list, in ALERT_KINDS order, known kinds only. */
function storedKinds(raw: unknown): EventKind[] | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  return ALERT_KINDS.filter((kind) => value.includes(kind));
}

/**
 * A list of kinds from a caller: every entry a known kind, each once, in
 * ALERT_KINDS order. Anything else is invalid-input.
 */
function readKinds(raw: unknown): EventKind[] {
  if (!Array.isArray(raw)) throw invalid("kinds must be a list of event kinds");
  for (const kind of raw) {
    if (!isEventKind(kind)) throw invalid("Unknown event kind");
  }
  return ALERT_KINDS.filter((kind) => raw.includes(kind));
}

/**
 * Conditions that repeat on one subject while they last: while a person's
 * alert about one is unread, the hub drops the next for the same subject.
 */
const REPEATING: ReadonlySet<EventKind> = new Set<EventKind>([
  "container-restarted",
  "restart-limit",
  "server-unreachable",
  "high-disk",
  "certificate-problem",
  "token-expiring",
]);

/**
 * What an alert's dedupe key is about: the deployment, a repeating
 * condition's subject, or else the event itself, so two scheduled tasks of
 * one resource (the pipeline keeps them apart by task), two backups or a
 * status change and the change back are each their own alert.
 */
function dedupeSubject(event: EventRecord): string {
  if (event.deploymentUuid) return `deployment:${event.deploymentUuid}`;
  if (REPEATING.has(event.kind)) {
    return `on:${event.resourceUuid ?? event.serverUuid ?? "team"}`;
  }
  return `event:${event.id}`;
}

/**
 * What the alert says, in words, from the stored event only: the pipeline
 * already redacted its name and status (#89), and every line is masked once
 * more on the way out, failing closed. Filled in one pass, so a `$&` or a
 * `{{...}}` in a name is kept as it is.
 */
function alertText(
  event: EventRecord,
  connectionName: string,
): { title: string; body: string } {
  const what = en.alerts.kinds[event.kind];
  const subject =
    event.name ??
    event.resourceUuid ??
    event.serverUuid ??
    en.alerts.subjects.team;
  const title = event.name
    ? fill(en.alerts.title.named, { what, name: event.name })
    : fill(en.alerts.title.plain, { what });
  const body = event.status
    ? fill(en.alerts.body.withStatus, {
        subject,
        connection: connectionName,
        status: event.status,
      })
    : fill(en.alerts.body.plain, { subject, connection: connectionName });
  return { title: redactLog(title, []), body: redactLog(body, []) };
}

/**
 * Alerts from the event pipeline through Termix's Alerts hub
 * (`ctx.notify.send`, design: "Alerts (`notify:send`)"), and each person's
 * alert preferences.
 *
 * `notify` is the pipeline's `onStored` hook. For each stored event it sends
 * one alert to the connection's owner and to each user with a grant, each
 * only for the kinds they picked (DEFAULT_ALERT_KINDS until they pick), and
 * only while they hold coolify.view and still reach the connection: both
 * are read again right before each send, so a lost permission or grant
 * stops alerts at once. One recipient's failure never stops the others,
 * and nothing it throws is passed on.
 */
export function createAlerts(ctx: PluginContext, deps: AlertsDeps) {
  const t = deps.tables.alertPrefs;
  const { connections } = deps;
  const inFlight = new Set<Promise<void>>();
  // Every change to one person's preferences on one connection runs alone,
  // in the order asked: the read of their row and the insert or update that
  // follows never interleave with another save, so two first saves can't
  // both insert and trip the unique (connectionId, userId) index. One plugin
  // process per Termix server, like the connections service's lock.
  const queues = new Map<string, Promise<unknown>>();

  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = queues.get(key) ?? Promise.resolve();
    const run = before.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  async function rowFor(
    connectionId: number,
    userId: string,
  ): Promise<{ kinds: unknown } | null> {
    const db = await dbClient(ctx);
    const [found] = (await db
      .select()
      .from(t)
      .where(and(eq(t.connectionId, connectionId), eq(t.userId, userId)))
      .limit(1)) as { kinds: unknown }[];
    return found ?? null;
  }

  /** The kinds `userId` gets alerts for on that connection. */
  async function kindsOf(
    connectionId: number,
    userId: string,
  ): Promise<{ kinds: EventKind[]; isDefault: boolean }> {
    const found = await rowFor(connectionId, userId);
    const kinds = found ? storedKinds(found.kinds) : null;
    return kinds
      ? { kinds, isDefault: false }
      : { kinds: [...DEFAULT_ALERT_KINDS], isDefault: true };
  }

  async function sendTo(
    userId: string,
    event: EventRecord,
    connectionName: string,
  ): Promise<void> {
    const { kinds } = await kindsOf(event.connectionId, userId);
    if (!kinds.includes(event.kind)) return;
    if (!(await ctx.rbac.hasFor(userId, "view"))) return;
    // The grant (or ownership) as it is now, the last read before the send.
    if (!(await connections.accessFor(event.connectionId, userId))) return;
    const { title, body } = alertText(event, connectionName);
    const subject = dedupeSubject(event);
    const notification: PluginNotification = {
      title,
      body,
      severity: EVENT_KINDS[event.kind].severity,
      category: `coolify.${event.kind}`,
      audience: { userId },
      // The SDK's link names only a tab type; the subject rides in context
      // as the tab data CoolifyTab opens it with.
      link: { tab: "coolify" },
      // Per person and per subject: a repeat while this one is unread is
      // dropped by the hub, and never someone else's alert.
      dedupeKey: `coolify:${userId}:${event.connectionId}:${event.kind}:${subject}`,
      context: {
        ...(event.hostId ? { hostId: event.hostId } : {}),
        connectionId: event.connectionId,
        eventId: event.id,
        kind: event.kind,
        resourceUuid: event.resourceUuid,
        serverUuid: event.serverUuid,
        deploymentUuid: event.deploymentUuid,
        tab: alertTabData(event),
      },
    };
    await ctx.notify.send(notification);
  }

  async function notifyNow(event: EventRecord): Promise<void> {
    if (!isEventKind(event.kind)) return;
    const audience = await connections.audience(event.connectionId);
    if (!audience) return;
    for (const userId of [audience.ownerId, ...audience.grantees]) {
      try {
        await sendTo(userId, event, audience.name);
      } catch (err) {
        ctx.log.warn(`coolify alert not sent: ${errorName(err)}`);
      }
    }
  }

  /** The actor and their access to the connection, or why not. */
  async function reach(connectionId: number): Promise<string> {
    if (!(await ctx.rbac.has("view"))) {
      throw new ConnectionError("forbidden", "Missing coolify.view");
    }
    const userId = ctx.currentActor();
    if (!userId || !(await connections.access(connectionId))) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    return userId;
  }

  async function answer(
    connectionId: number,
    userId: string,
  ): Promise<AlertPrefs> {
    const { kinds, isDefault } = await kindsOf(connectionId, userId);
    return {
      connectionId,
      kinds,
      isDefault,
      defaults: [...DEFAULT_ALERT_KINDS],
      available: [...ALERT_KINDS],
    };
  }

  async function setPrefsNow(
    connectionId: number,
    raw: unknown,
  ): Promise<AlertPrefs> {
    const userId = await reach(connectionId);
    const kinds = raw === null ? null : readKinds(raw);
    const db = await dbClient(ctx);
    const where = and(eq(t.connectionId, connectionId), eq(t.userId, userId));
    if (kinds === null) {
      await db.delete(t).where(where);
    } else if (await rowFor(connectionId, userId)) {
      await db
        .update(t)
        .set({
          kinds: JSON.stringify(kinds),
          updatedAt: new Date().toISOString(),
        })
        .where(where);
    } else {
      await db.insert(t).values({
        connectionId,
        userId,
        kinds: JSON.stringify(kinds),
        updatedAt: new Date().toISOString(),
      });
    }
    await ctx.db.persist();
    return answer(connectionId, userId);
  }

  return {
    /**
     * The pipeline's onStored hook: alerts for one stored event. Never
     * rejects; a failure is logged by its error name only.
     */
    notify(event: EventRecord): Promise<void> {
      const run = notifyNow(event).catch((err) => {
        ctx.log.warn(`coolify alerts failed: ${errorName(err)}`);
      });
      inFlight.add(run);
      void run.finally(() => inFlight.delete(run));
      return run;
    },

    /** How many events' alerts are still being sent. */
    pending(): number {
      return inFlight.size;
    },

    /** Resolves once every alert started so far is sent or given up. */
    async idle(): Promise<void> {
      while (inFlight.size) await Promise.all([...inFlight]);
    },

    /**
     * The actor's own alert kinds for a connection they own or were
     * granted. Needs coolify.view; another user's connection is 404.
     */
    async prefs(connectionId: number): Promise<AlertPrefs> {
      const userId = await reach(connectionId);
      return answer(connectionId, userId);
    },

    /**
     * Saves the actor's own alert kinds for that connection: a list of
     * known kinds (an empty list means no alerts), or null to go back to
     * the defaults. Unknown kinds are invalid-input and save nothing.
     */
    async setPrefs(connectionId: number, raw: unknown): Promise<AlertPrefs> {
      // Queued by the actor before anything is awaited, so saves apply in
      // the order they were asked; reach() checks the actor inside.
      const key = `${connectionId}:${ctx.currentActor() ?? ""}`;
      return serialized(key, () => setPrefsNow(connectionId, raw));
    },
  };
}

export type Alerts = ReturnType<typeof createAlerts>;
