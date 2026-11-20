import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { SECRET_FIELDS } from "./coolify/generated/schemas.js";

/** Keys whose value is a secret, at any depth (the design's "Redaction"). */
const SECRET_KEY =
  /(token|secret|password|passwd|private_key|api_key|apikey|webhook_secret|value|real_value|license|key_pem|client_secret|dsn|_key|_db_url)$/i;

/**
 * Text blobs that carry env values or credentials inside them: compose files,
 * labels, Dockerfiles and log drain configs. Masked whole. `docker_compose` is
 * Coolify's rendered copy of `docker_compose_raw`, with the same values.
 */
const BLOB_KEY =
  /^(docker_compose_raw|docker_compose|custom_labels|dockerfile|logdrain_.+_config)$/i;

/** Keys holding a URL with credentials in it: kept as a URL, password masked. */
const URL_KEY = /_url$/i;

/** A URL's `scheme://user:` before the password and its `@`. */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)[^\s/?#]*@/gi;

/** A query parameter whose name says it carries a credential. */
const SECRET_QUERY =
  /([?&;][\w.-]*(?:password|passwd|pwd|token|secret|key|signature|sig|auth)=)[^&#\s]+/gi;

function masked(key: string): boolean {
  return SECRET_KEY.test(key) || BLOB_KEY.test(key) || SECRET_FIELDS.has(key);
}

/**
 * Masks the credentials inside a string, wherever a URL holds them: the
 * userinfo password and credential query parameters. The rest stays.
 */
export function maskCredentials(text: string): string {
  return text
    .replace(USERINFO, `$1${REDACTED_VALUE}@`)
    .replace(SECRET_QUERY, `$1${REDACTED_VALUE}`);
}

function isUrl(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** A secret key's value: a URL keeps its shape with its credentials masked. */
function maskedValue(key: string, value: unknown): unknown {
  if (URL_KEY.test(key) && typeof value === "string" && isUrl(value)) {
    return maskCredentials(value);
  }
  return REDACTED_VALUE;
}

/** Whether a redacted value hides something (whole, or inside a URL). */
export function isMasked(value: unknown): boolean {
  return typeof value === "string" && value.includes(REDACTED_VALUE);
}

/**
 * Returns a copy of `value` with every secret masked, at any depth. Used for
 * every generic output: operation data, MCP tool results and the API console.
 * Secret keys (by name, or described as a password or secret by a vendored
 * spec) are masked, and every other string has the credentials inside any URL
 * masked. Null stays null, so "not set" still reads as not set. The input is
 * not changed.
 */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return maskCredentials(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED_VALUE;
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => walk(item, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      masked(key) && inner !== null && inner !== undefined
        ? maskedValue(key, inner)
        : walk(inner, seen);
  }
  seen.delete(value);
  return out;
}
