import type {
  PluginFetch,
  PluginFetchInit,
} from "@termix-ssh/plugin-sdk/backend";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { trimTrailing } from "../text.js";

/** Everything needed to reach one Coolify instance. Holds the token unsealed: never log or return it. */
export interface CoolifyTarget {
  baseUrl: string;
  token: string;
  cfAccess: { id: string; secret: string } | null;
  allowPrivate: boolean;
  caCert: string | null;
}

/** A plain reason a Coolify call failed. The UI translates it under `causes.<cause>`. */
export type CoolifyCause =
  | "unreachable"
  | "unauthorized"
  | "api-disabled"
  | "forbidden-ability"
  | "not-found"
  | "rate-limited"
  | "access-redirect"
  | "not-coolify"
  | "validation"
  | "upstream"
  | "unsupported-by-instance"
  | "unsupported-version";

/**
 * A failed Coolify call. `status` is the upstream HTTP status, or 0 when there
 * was no answer. The message is one of the fixed texts below, so it never
 * carries anything Coolify sent back (which could echo a token).
 */
export class CoolifyError extends Error {
  readonly status: number;
  override readonly cause: CoolifyCause;
  readonly fields?: Record<string, string[]>;

  constructor(
    cause: CoolifyCause,
    status: number,
    message: string = CAUSE_MESSAGES[cause],
    fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "CoolifyError";
    this.cause = cause;
    this.status = status;
    if (fields) this.fields = fields;
  }
}

export const CAUSE_MESSAGES: Record<CoolifyCause, string> = {
  unreachable: "Coolify could not be reached",
  unauthorized: "Coolify refused the API token",
  "api-disabled":
    "API access is turned off in Coolify (Settings, Advanced, API access)",
  "forbidden-ability": "The Coolify token lacks the ability this needs",
  "not-found": "Not found in Coolify",
  "rate-limited": "Coolify is rate limiting requests; try again in a minute",
  "access-redirect":
    "Coolify is behind Cloudflare Access: add a Cloudflare Access service token",
  "not-coolify": "The address answered, but not as a Coolify API",
  validation: "Coolify refused the values sent",
  upstream: "Coolify answered with an error",
  "unsupported-by-instance":
    "This Coolify instance does not have this feature; update Coolify",
  "unsupported-version": "This plugin needs Coolify 4.4 or newer",
};

type QueryScalar = string | number | boolean;
/** An array is sent as one name=value per item (OpenAPI form, exploded). */
type QueryValue = QueryScalar | QueryScalar[] | undefined;

export interface CoolifyRequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** GETs retry 429 and 5xx by default. False turns that off. */
  retry?: boolean;
  /**
   * The one success status accepted; any other 2xx is refused as
   * `upstream` (the webhook's visibility check passes only on a 200).
   */
  exactStatus?: number;
  /** Read the answer as plain text (Coolify's /version and /health). */
  text?: boolean;
  /**
   * Masks every answer string that holds the token or the Cloudflare Access
   * secret, for answers passed on as they came (the generic API).
   */
  scrubSecrets?: boolean;
  /**
   * Runs right before each fetch, after the request budget's wait and any
   * retry's backoff. A throw sends nothing.
   */
  beforeFetch?: () => Promise<void>;
  /**
   * Posts to Coolify's own MCP endpoint (`<url>/mcp`) instead of the API,
   * with the same headers, budget and error mapping. Use with `text`.
   */
  mcp?: boolean;
}

/** `value` with every string that contains one of `secrets` masked. */
function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.some((secret) => value.includes(secret))
      ? REDACTED_VALUE
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]),
    );
  }
  return value;
}

export interface CoolifyHttp {
  request<T>(
    method: string,
    path: string,
    opts?: CoolifyRequestOptions,
  ): Promise<T>;
}

export interface CoolifyHttpOptions {
  /** Requests a minute. Coolify allows 200; the default leaves room. */
  perMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PER_MINUTE = 150;
const WINDOW_MS = 60_000;
const RETRIES = 2;
const BACKOFF_MS = [500, 1500];
const MAX_RETRY_AFTER_MS = 10_000;
const TIMEOUT_MS = 30_000;

function apiBase(baseUrl: string): string {
  return `${trimTrailing(baseUrl.trim(), "/")}/api/v1`;
}

/**
 * The request URL. Refuses a path that URL parsing would change (".", "..",
 * their percent-encoded forms, backslashes, a query or fragment in the path):
 * fetch would send it to a different endpoint than the one the caller's
 * access was checked for. Nothing is sent then.
 */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const rest = path.startsWith("/") ? path : `/${path}`;
  const base = apiBase(baseUrl);
  const url = `${base}${rest}`;
  let sent: string | null = null;
  let expected: string | null = null;
  try {
    sent = new URL(url).pathname;
    expected = `${new URL(base).pathname}${rest}`;
  } catch {
    // Not a URL at all: refused below.
  }
  if (sent === null || sent !== expected) {
    throw new CoolifyError(
      "validation",
      0,
      "The request path is not a plain Coolify API path",
    );
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of value === undefined ? [] : [value].flat()) {
      params.append(key, String(item));
    }
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function isAccessRedirect(location: string | null): boolean {
  if (!location) return false;
  const host = hostOf(location);
  return (
    host !== null &&
    (host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com"))
  );
}

function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text);
}

function toFieldMap(errors: unknown): Record<string, string[]> | undefined {
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) {
    return undefined;
  }
  const fields: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(
    errors as Record<string, unknown>,
  )) {
    const list = Array.isArray(value) ? value : [value];
    fields[key] = list.filter((v) => typeof v === "string") as string[];
  }
  return fields;
}

/** The body as text, or null when it can't be read (a reset mid-body). */
async function readText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** An HTML page, not one of Coolify's JSON API answers. */
function isHtml(response: Response, text: string | null): boolean {
  if (text === null || text.trim() === "") return false;
  return (
    looksLikeHtml(text) ||
    /text\/html/i.test(response.headers.get("content-type") ?? "")
  );
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * The request layer every Coolify call goes through: ctx.fetch, the Bearer
 * token and Cloudflare Access headers, no redirects, a budget under Coolify's
 * rate limit, GET retries, and error mapping to a CoolifyCause.
 */
export function createCoolifyHttp(
  fetch: PluginFetch,
  target: CoolifyTarget,
  opts: CoolifyHttpOptions = {},
): CoolifyHttp {
  const perMinute = Math.max(1, opts.perMinute ?? DEFAULT_PER_MINUTE);
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sent: number[] = [];

  async function takeSlot(): Promise<void> {
    for (;;) {
      const t = now();
      while (sent.length && sent[0] <= t - WINDOW_MS) sent.shift();
      if (sent.length < perMinute) {
        sent.push(t);
        return;
      }
      await sleep(sent[0] + WINDOW_MS - t);
    }
  }

  const baseHost = hostOf(target.baseUrl);

  function init(method: string, body: unknown, mcp: boolean): PluginFetchInit {
    const headers: Record<string, string> = {
      accept: mcp ? "application/json, text/event-stream" : "application/json",
      authorization: `Bearer ${target.token}`,
    };
    if (target.cfAccess) {
      headers["cf-access-client-id"] = target.cfAccess.id;
      headers["cf-access-client-secret"] = target.cfAccess.secret;
    }
    const result: PluginFetchInit = {
      method,
      headers,
      redirect: "manual",
      timeoutMs: TIMEOUT_MS,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      result.body = JSON.stringify(body);
    }
    if (target.allowPrivate && baseHost) {
      result.allowPrivateHosts = [baseHost];
    }
    if (target.caCert) result.tls = { ca: target.caCert };
    return result;
  }

  async function failure(response: Response): Promise<CoolifyError> {
    const status = response.status;
    if (status >= 300 && status < 400) {
      return new CoolifyError(
        isAccessRedirect(response.headers.get("location"))
          ? "access-redirect"
          : "not-coolify",
        status,
      );
    }
    if (status === 429) return new CoolifyError("rate-limited", status);
    if (status >= 500) return new CoolifyError("upstream", status);
    // Every other answer is read once. An HTML page (a proxy's or a login
    // page) is not Coolify's API, so its status says nothing about the token.
    const text = await readText(response);
    if (isHtml(response, text)) return new CoolifyError("not-coolify", status);
    if (status === 401) return new CoolifyError("unauthorized", status);
    if (status === 403) {
      const body = parseJson(text) as { message?: unknown } | null;
      const message = typeof body?.message === "string" ? body.message : "";
      return new CoolifyError(
        /api is disabled/i.test(message) ? "api-disabled" : "forbidden-ability",
        status,
      );
    }
    if (status === 404) return new CoolifyError("not-found", status);
    if (status === 405) {
      return new CoolifyError("unsupported-by-instance", status);
    }
    if (status === 422) {
      const body = parseJson(text) as { errors?: unknown } | null;
      return new CoolifyError(
        "validation",
        status,
        undefined,
        toFieldMap(body?.errors) ?? {},
      );
    }
    return new CoolifyError("upstream", status);
  }

  async function success(
    response: Response,
    asText: boolean,
  ): Promise<unknown> {
    const text = await readText(response);
    if (text === null) throw new CoolifyError("unreachable", response.status);
    if (asText) {
      if (looksLikeHtml(text)) {
        throw new CoolifyError("not-coolify", response.status);
      }
      return text.trim();
    }
    if (response.status === 204 || text.trim() === "") return undefined;
    const type = response.headers.get("content-type") ?? "";
    if (!/json/i.test(type)) {
      throw new CoolifyError("not-coolify", response.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new CoolifyError("not-coolify", response.status);
    }
  }

  return {
    async request<T>(
      method: string,
      path: string,
      options: CoolifyRequestOptions = {},
    ): Promise<T> {
      const verb = method.toUpperCase();
      const url = options.mcp
        ? `${trimTrailing(target.baseUrl.trim(), "/")}/mcp`
        : buildUrl(target.baseUrl, path, options.query);
      const canRetry = verb === "GET" && options.retry !== false;
      for (let attempt = 0; ; attempt++) {
        await takeSlot();
        await options.beforeFetch?.();
        let response: Response;
        try {
          response = await fetch(
            url,
            init(verb, options.body, options.mcp === true),
          );
        } catch {
          throw new CoolifyError("unreachable", 0);
        }
        if (response.status >= 200 && response.status < 300) {
          if (
            options.exactStatus !== undefined &&
            response.status !== options.exactStatus
          ) {
            throw new CoolifyError("upstream", response.status);
          }
          const answer = await success(response, options.text === true);
          if (!options.scrubSecrets) return answer as T;
          const secrets = [target.token, target.cfAccess?.secret ?? ""].filter(
            (secret) => secret !== "",
          );
          return scrub(answer, secrets) as T;
        }
        if (canRetry && attempt < RETRIES && retryable(response.status)) {
          await sleep(retryAfterMs(response) ?? BACKOFF_MS[attempt]);
          continue;
        }
        throw await failure(response);
      }
    },
  };
}

const ROUTE_STATUS: Partial<Record<CoolifyCause, number>> = {
  validation: 422,
  "not-found": 404,
  "rate-limited": 429,
  "unsupported-by-instance": 409,
  "unsupported-version": 409,
};

/**
 * The answer a route sends for a failed Coolify call. Only fixed texts go
 * out, so nothing Coolify echoed (a token, say) reaches the caller.
 */
export function toRouteError(err: unknown): {
  status: number;
  body: { error: string; cause: CoolifyCause };
} {
  if (err instanceof CoolifyError) {
    return {
      status: ROUTE_STATUS[err.cause] ?? 502,
      body: { error: CAUSE_MESSAGES[err.cause], cause: err.cause },
    };
  }
  return {
    status: 502,
    body: { error: CAUSE_MESSAGES.upstream, cause: "upstream" },
  };
}
