import { and, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { WebhookChannelForSetup } from "../coolify/api.js";
import {
  ConnectionError,
  isPrivateAddress,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import { dbClient, type Tables } from "../db.js";
import { hashToken } from "../status/service.js";
import { issueWebhookToken, type Webhooks } from "./service.js";

/**
 * The event toggles setup ticks: every Coolify v4.7.5 webhook notification
 * the receiver (shape.ts) turns into an event kind. Names read from Coolify's
 * NotificationsController and WebhookNotificationSettings (tag v4.7.5); the
 * vendored specs describe no body. Other toggles are left as they are.
 */
export const WEBHOOK_EVENT_FIELDS = [
  "deployment_success_webhook_notifications",
  "deployment_failure_webhook_notifications",
  "restart_limit_reached_webhook_notifications",
  "backup_success_webhook_notifications",
  "backup_failure_webhook_notifications",
  "scheduled_task_success_webhook_notifications",
  "scheduled_task_failure_webhook_notifications",
  "server_disk_usage_webhook_notifications",
  "server_unreachable_webhook_notifications",
] as const;

/** Access levels that may change the team's webhook. */
const CONFIGURE_ACCESS: ReadonlySet<AccessLevel> = new Set([
  "owner",
  "configure",
]);

/** A webhook token in a path: 32 random bytes as base64url. */
const TOKEN = "[A-Za-z0-9_-]{43}";

export type WebhookSetupErrorCode =
  | "forbidden"
  | "confirm-required"
  // Neither the request nor the actor's last request gave an address.
  | "no-base-url"
  // The connection's Coolify team is unknown (no instanceKey).
  | "no-team"
  // A token scoped to projects or resources can't reach /notifications.
  | "scoped-token"
  // Coolify hid the URL: the token lacks read:sensitive.
  | "secrets-unreadable"
  // Disable found someone else's URL.
  | "not-ours";

const STATUS: Record<WebhookSetupErrorCode, 400 | 403 | 409> = {
  forbidden: 403,
  "confirm-required": 400,
  "no-base-url": 409,
  "no-team": 409,
  "scoped-token": 409,
  "secrets-unreadable": 409,
  "not-ours": 409,
};

/** A refusal by the setup itself. The message is fixed text. */
export class WebhookSetupError extends Error {
  readonly code: WebhookSetupErrorCode;
  readonly status: 400 | 403 | 409;

  constructor(code: WebhookSetupErrorCode, message: string) {
    super(message);
    this.name = "WebhookSetupError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export type WebhookState = "unset" | "ours" | "foreign";

/** What the team's webhook is, as the actor may see it. Holds no token. */
export interface WebhookStatus {
  state: WebhookState;
  enabled: boolean;
  /** Someone else's URL, masked (`maskWebhookUrl`); null otherwise. */
  current: string | null;
  /** The Termix address our URL would use, or null when there is none. */
  base: string | null;
  /** Whether that address is private, which Coolify refuses. */
  basePrivate: boolean;
}

export type SetupResult =
  | { outcome: "configured"; replaced: boolean; basePrivate: boolean }
  | { outcome: "replace-needed"; current: string; basePrivate: boolean };

export type DisableResult = { outcome: "disabled" } | { outcome: "not-set" };

/**
 * A URL as setup may show it: its scheme, host and port, with any path or
 * query replaced by `[redacted]`. A webhook URL often carries its secret in
 * the path (ours does), so nothing past the host is ever shown. Credentials
 * are dropped. "[redacted]" when it isn't a URL.
 */
export function maskWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[redacted]";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "[redacted]";
  }
  const origin = `${url.protocol}//${url.host}`;
  const more = (url.pathname !== "/" && url.pathname !== "") || url.search;
  return more ? `${origin}/[redacted]` : origin;
}

/**
 * Whether Coolify would refuse a webhook to this address: loopback or a
 * private or link-local IP literal (the transport check), or a name Coolify
 * itself blocks (`.local`, `.internal`). Coolify resolves other names and may
 * refuse those too; this is only a warning.
 */
export function privateBase(base: string): boolean {
  if (isPrivateAddress(base)) return true;
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host.endsWith(".local") || host.endsWith(".internal");
  } catch {
    return false;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface WebhookSetupDeps {
  tables: Tables;
  connections: Connections;
  webhooks: Webhooks;
}

/**
 * One-click setup of the team webhook (#92, design "Alerts and live events").
 * Each call reads the connection once (`connections.snapshot`) and the team's
 * webhook channel through it, then decides by the URL Coolify holds: unset,
 * ours (our route, with a token that verifies against this team's row) or
 * someone else's. Our URL is written only for the first two, or for the
 * third when the caller asked to replace it and confirmed. The token is only
 * ever in the URL sent to Coolify: no answer, log or audit line holds it.
 * Every request and the row write first check that the connection still
 * points where the snapshot did, and that the actor still has
 * coolify.configure and owner or configure access (`target-changed`,
 * `forbidden`).
 */
export function createWebhookSetup(ctx: PluginContext, deps: WebhookSetupDeps) {
  const t = deps.tables;
  const { connections, webhooks } = deps;
  const ourPath = new RegExp(
    `/plugin-api/${escapeRegExp(ctx.pluginId)}/webhook/(${TOKEN})$`,
  );
  const queues = new Map<string, Promise<void>>();

  /**
   * Work on one team's webhook runs one at a time (single process, like
   * the connections lock): two setups for one team would otherwise each
   * write a token, and Coolify would keep the one the row doesn't.
   */
  async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = queues.get(key) ?? Promise.resolve();
    const run = before.then(fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    queues.set(key, tail);
    try {
      return await run;
    } finally {
      if (queues.get(key) === tail) queues.delete(key);
    }
  }

  async function mayConfigure(id: number): Promise<boolean> {
    if (!(await ctx.rbac.has("configure"))) return false;
    const access = await connections.access(id);
    return access !== null && CONFIGURE_ACCESS.has(access);
  }

  const forbidden = () =>
    new WebhookSetupError(
      "forbidden",
      "The team webhook needs coolify.configure and configure access to this connection.",
    );

  /** Permission, one snapshot, its access and its team, before any request. */
  async function begin(id: number) {
    if (!(await ctx.rbac.has("configure"))) throw forbidden();
    const snap = await connections.snapshot(id);
    if (!CONFIGURE_ACCESS.has(snap.view.access)) throw forbidden();
    if (snap.view.scoped) {
      throw new WebhookSetupError(
        "scoped-token",
        "A token limited to projects or resources can't change the team webhook.",
      );
    }
    const instanceKey = snap.instanceKey;
    if (!instanceKey) {
      throw new WebhookSetupError(
        "no-team",
        "This connection's Coolify team is unknown. Check the connection again.",
      );
    }
    /** The snapshot still holds, and the actor may still configure it. */
    const holds = async () => {
      if ((await connections.revision(id)) !== snap.view.revision) {
        throw new ConnectionError(
          "target-changed",
          "The connection's address, token or Access settings changed. Try again.",
        );
      }
      if (!(await mayConfigure(id))) throw forbidden();
    };
    return { snap, instanceKey, holds };
  }

  type Begun = Awaited<ReturnType<typeof begin>>;

  /** The channel's URL, read through the snapshot; refused when hidden. */
  async function readChannel(b: Begun): Promise<WebhookChannelForSetup> {
    const channel = await b.snap.api.webhookChannelForSetup({
      beforeFetch: b.holds,
    });
    if (!channel.readable) {
      throw new WebhookSetupError(
        "secrets-unreadable",
        "Coolify hides the webhook URL from this token. Give the token read:sensitive.",
      );
    }
    return channel;
  }

  /**
   * Whose URL it is. Ours only on our route, with no query, and a token
   * that verifies against this team's own row; its token is returned so a
   * rewrite can keep it.
   */
  async function classify(
    url: string | null,
    instanceKey: string,
  ): Promise<{ state: WebhookState; token: string | null }> {
    if (!url) return { state: "unset", token: null };
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    const token =
      parsed && !parsed.search && !parsed.hash
        ? (ourPath.exec(parsed.pathname)?.[1] ?? null)
        : null;
    if (token) {
      const row = await webhooks.verify(token);
      if (row && row.instanceKey === instanceKey) {
        return { state: "ours", token };
      }
    }
    return { state: "foreign", token: null };
  }

  function needBase(base: string | null): string {
    if (!base) {
      throw new WebhookSetupError(
        "no-base-url",
        "Termix's own address isn't known. Open Termix by the address Coolify should use, then try again.",
      );
    }
    return base;
  }

  /**
   * Gives this team's row a new token, replacing the old one (which Coolify
   * doesn't hold: the channel was unset or someone else's). lastReceivedAt
   * starts empty, so polling goes on until the new URL delivers.
   */
  async function newToken(b: Begun): Promise<string> {
    const issued = issueWebhookToken();
    await b.holds();
    const db = await dbClient(ctx);
    const [found] = (await db
      .select({ id: t.webhooks.id })
      .from(t.webhooks)
      .where(eq(t.webhooks.instanceKey, b.instanceKey))
      .limit(1)) as { id: number }[];
    if (found) {
      await db
        .update(t.webhooks)
        .set({ tokenHash: issued.tokenHash, lastReceivedAt: null })
        .where(eq(t.webhooks.id, found.id));
    } else {
      await db.insert(t.webhooks).values({
        instanceKey: b.instanceKey,
        tokenHash: issued.tokenHash,
        createdByUserId: ctx.currentActor() ?? "",
      });
    }
    await ctx.db.persist();
    return issued.token;
  }

  async function audit(
    action: string,
    connectionId: number,
    name: string,
    details: Record<string, unknown>,
  ) {
    await ctx.audit.record({
      action,
      resourceType: "coolify-connection",
      resourceId: String(connectionId),
      resourceName: name,
      details: JSON.stringify({ connectionId, ...details }),
      success: true,
    });
  }

  return {
    /** The team's webhook as it stands, read from Coolify. Changes nothing. */
    async status(
      connectionId: number,
      opts: { base: string | null },
    ): Promise<WebhookStatus> {
      const b = await begin(connectionId);
      const channel = await readChannel(b);
      const { state } = await classify(channel.url, b.instanceKey);
      await b.holds();
      return {
        state,
        enabled: channel.enabled,
        current:
          state === "foreign" && channel.url
            ? maskWebhookUrl(channel.url)
            : null,
        base: opts.base,
        basePrivate: opts.base ? privateBase(opts.base) : false,
      };
    },

    /**
     * Points the team's webhook at this Termix. Unset or ours: writes our
     * URL (a new token only when it isn't ours already) and ticks the event
     * toggles. Someone else's: answers `replace-needed` with their URL
     * masked and changes nothing, unless `replace` and `confirmed` are both
     * set. Declining is simply not asking again: polling stays on.
     */
    async setup(
      connectionId: number,
      opts: { base: string | null; replace?: boolean; confirmed?: boolean },
    ): Promise<SetupResult> {
      const b = await begin(connectionId);
      if (opts.replace && opts.confirmed !== true) {
        throw new WebhookSetupError(
          "confirm-required",
          "Replacing the team's webhook needs confirmed: true",
        );
      }
      const base = needBase(opts.base);
      const basePrivate = privateBase(base);
      return serialized(b.instanceKey, async () => {
        const channel = await readChannel(b);
        const found = await classify(channel.url, b.instanceKey);
        if (found.state === "foreign" && !opts.replace) {
          await b.holds();
          return {
            outcome: "replace-needed",
            current: maskWebhookUrl(channel.url ?? ""),
            basePrivate,
          };
        }
        const token = found.token ?? (await newToken(b));
        const body: Record<string, unknown> = {
          webhook_url: `${base}/plugin-api/${ctx.pluginId}/webhook/${token}`,
          webhook_enabled: true,
        };
        for (const field of WEBHOOK_EVENT_FIELDS) body[field] = true;
        await b.snap.api.updateWebhookChannel(body, { beforeFetch: b.holds });
        const replaced = found.state === "foreign";
        await audit("coolify_webhook_setup", connectionId, b.snap.view.name, {
          replaced,
        });
        return { outcome: "configured", replaced, basePrivate };
      });
    },

    /**
     * Removes our URL from the team's webhook, and our row with it, only
     * while the URL is still ours. Someone else's is `not-ours`; none set
     * is `not-set`. Needs `confirmed: true`.
     */
    async disable(
      connectionId: number,
      opts: { confirmed?: boolean },
    ): Promise<DisableResult> {
      const b = await begin(connectionId);
      if (opts.confirmed !== true) {
        throw new WebhookSetupError(
          "confirm-required",
          "Turning the team's webhook off needs confirmed: true",
        );
      }
      return serialized(b.instanceKey, async () => {
        const channel = await readChannel(b);
        const found = await classify(channel.url, b.instanceKey);
        if (found.state === "unset") {
          await b.holds();
          return { outcome: "not-set" };
        }
        if (found.state === "foreign" || !found.token) {
          throw new WebhookSetupError(
            "not-ours",
            "The team's webhook points somewhere else; it was left as it is.",
          );
        }
        await b.snap.api.updateWebhookChannel(
          { webhook_url: null, webhook_enabled: false },
          { beforeFetch: b.holds },
        );
        // Only the row the URL held: polling follows the default again.
        const db = await dbClient(ctx);
        await db
          .delete(t.webhooks)
          .where(
            and(
              eq(t.webhooks.instanceKey, b.instanceKey),
              eq(t.webhooks.tokenHash, hashToken(found.token)),
            ),
          );
        await ctx.db.persist();
        await audit("coolify_webhook_disable", connectionId, b.snap.view.name, {
          outcome: "disabled",
        });
        return { outcome: "disabled" };
      });
    },
  };
}

export type WebhookSetup = ReturnType<typeof createWebhookSetup>;
