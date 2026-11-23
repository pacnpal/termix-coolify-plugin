import { eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "../connections/service.js";
import { dbClient, type Tables } from "../db.js";
import type { Events, IngestResult } from "../events/service.js";
import { hashToken, newToken, tokenMatches } from "../status/service.js";
import { readWebhook, type WebhookIngest } from "./shape.js";

/** The largest body accepted, in bytes: 64 KB. */
export const WEBHOOK_BODY_MAX = 65_536;

/**
 * Fan-outs one webhook row may have in flight; a delivery past it is still
 * accepted, but its event is dropped (logged). Bounds the work a burst of
 * deliveries can queue behind Coolify's request budget.
 */
export const WEBHOOK_FANOUT_MAX = 32;

/** A webhook token: 32 random bytes as base64url (43 characters). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** What became of one connection's copy of a delivered event. */
export interface FanoutResult {
  connectionId: number;
  outcome:
    | IngestResult["outcome"]
    /** The connection's token couldn't read the event's subject. */
    | "not-visible"
    /** The connection is gone or its owner lacks coolify.view; not asked. */
    | "skipped"
    /** The pipeline failed (database or emit); logged by name only. */
    | "error";
}

export type Delivery =
  | { accepted: false }
  | {
      accepted: true;
      /**
       * The fan-out, running after the answer. Never rejects. Callers don't
       * wait for it; tests do.
       */
      fanout: Promise<FanoutResult[]>;
    };

/** A webhook row, as verify finds it. Holds no secret. */
export interface WebhookRow {
  id: number;
  instanceKey: string;
}

/**
 * A new webhook token and the sha256 the `webhooks` table keeps instead of
 * it. The token is shown once (the setup, #92) and never stored.
 */
export function issueWebhookToken(): { token: string; tokenHash: string } {
  const token = newToken();
  return { token, tokenHash: hashToken(token) };
}

export interface WebhooksDeps {
  tables: Tables;
  connections: Connections;
  events: Events;
}

/**
 * The team webhook (#91, design "Alerts and live events"): Coolify POSTs one
 * notification per request to `/webhook/:token`. `receive` refuses anything
 * but a known token with a strict body (shape.ts) under WEBHOOK_BODY_MAX,
 * marks the row's `lastReceivedAt`, and starts the fan-out without waiting
 * for it: each connection with the row's instanceKey asks Coolify, with its
 * own token, for the event's subject (`canRead`: one GET, no retry, only a
 * 200 passes, counted against that connection's request budget), and only
 * then hands the event to the pipeline under the revision it asked with.
 * Nothing is cached and nothing is retried: a failed check drops the event
 * for that connection.
 */
export function createWebhooks(ctx: PluginContext, deps: WebhooksDeps) {
  const t = deps.tables;
  const { connections, events } = deps;
  const inFlight = new Map<number, number>();

  async function verify(token: unknown): Promise<WebhookRow | null> {
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
    const db = await dbClient(ctx);
    const [found] = (await db
      .select({
        id: t.webhooks.id,
        instanceKey: t.webhooks.instanceKey,
        tokenHash: t.webhooks.tokenHash,
      })
      .from(t.webhooks)
      .where(eq(t.webhooks.tokenHash, hashToken(token)))
      .limit(1)) as (WebhookRow & { tokenHash: string })[];
    if (!found || !tokenMatches(found.tokenHash, token)) return null;
    return { id: found.id, instanceKey: found.instanceKey };
  }

  /** One connection's copy: the owner's view, the live check, then ingest. */
  async function deliverTo(
    connectionId: number,
    ingest: WebhookIngest,
  ): Promise<FanoutResult> {
    const result = (outcome: FanoutResult["outcome"]) => ({
      connectionId,
      outcome,
    });
    try {
      const snap = await connections.unattendedSnapshot(connectionId);
      if (!snap || !(await ctx.rbac.hasFor(snap.userId, "view"))) {
        return result("skipped");
      }
      // The connection's own client, so the check shares its budget.
      const api = await snap.api().catch(() => null);
      if (!api) return result("not-visible");
      // Right before the GET (after any budget wait): the connection still
      // points where the snapshot did, or nothing is sent with its token.
      let moved = false;
      const beforeFetch = async () => {
        const now = await connections.unattendedSnapshot(connectionId);
        if (now?.revision !== snap.revision) {
          moved = true;
          throw new Error("target changed");
        }
      };
      if (!(await api.canRead(ingest.subject, { beforeFetch }))) {
        return result(moved ? "dropped" : "not-visible");
      }
      const ingested = await events.ingest(connectionId, ingest.event, {
        revision: snap.revision,
      });
      return result(ingested.outcome);
    } catch (err) {
      ctx.log.warn(
        `coolify webhook event not delivered: ${(err as Error)?.name ?? "error"}`,
      );
      return result("error");
    }
  }

  async function fanOut(
    row: WebhookRow,
    ingest: WebhookIngest | null,
  ): Promise<FanoutResult[]> {
    if (!ingest) return [];
    const held = inFlight.get(row.id) ?? 0;
    if (held >= WEBHOOK_FANOUT_MAX) {
      ctx.log.warn("coolify webhook busy: event dropped");
      return [];
    }
    inFlight.set(row.id, held + 1);
    try {
      const db = await dbClient(ctx);
      const ids = (
        (await db
          .select({ id: t.connections.id })
          .from(t.connections)
          .where(eq(t.connections.instanceKey, row.instanceKey))) as {
          id: number;
        }[]
      ).map((r) => r.id);
      return await Promise.all(ids.map((id) => deliverTo(id, ingest)));
    } catch (err) {
      ctx.log.warn(
        `coolify webhook fan-out failed: ${(err as Error)?.name ?? "error"}`,
      );
      return [];
    } finally {
      const left = (inFlight.get(row.id) ?? 1) - 1;
      if (left > 0) inFlight.set(row.id, left);
      else inFlight.delete(row.id);
    }
  }

  return {
    /**
     * The webhook row `token` names, compared by its sha256 in constant
     * time, or null. For the route and for the setup (#92).
     */
    verify,

    /**
     * One delivery. `bytes` is the body's size as received (its
     * content-length); the parsed body's own JSON size counts too, so a
     * caller can't claim less. Refused (nothing stored, nothing asked) when
     * either is over WEBHOOK_BODY_MAX, the body isn't exactly one of
     * Coolify's events, or the token is unknown, all alike. Throws only
     * when the database fails.
     */
    async receive(
      token: unknown,
      body: unknown,
      bytes: number | null,
    ): Promise<Delivery> {
      const size = Buffer.byteLength(JSON.stringify(body ?? null) ?? "");
      if (
        size > WEBHOOK_BODY_MAX ||
        (bytes !== null &&
          (!Number.isFinite(bytes) || bytes > WEBHOOK_BODY_MAX))
      ) {
        return { accepted: false };
      }
      const read = readWebhook(body);
      if (!read) return { accepted: false };
      const row = await verify(token);
      if (!row) return { accepted: false };
      const db = await dbClient(ctx);
      await db
        .update(t.webhooks)
        .set({ lastReceivedAt: new Date().toISOString() })
        .where(eq(t.webhooks.id, row.id));
      await ctx.db.persist();
      return { accepted: true, fanout: fanOut(row, read.ingest) };
    },
  };
}

export type Webhooks = ReturnType<typeof createWebhooks>;
