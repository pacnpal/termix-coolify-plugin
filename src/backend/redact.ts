import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";

/** Keys whose value is a secret, at any depth (the design's "Redaction"). */
const SECRET_KEY =
  /(token|secret|password|passwd|private_key|api_key|apikey|webhook_secret|value|real_value|license|key_pem|client_secret|dsn)$/i;

/**
 * Text blobs that carry env values or credentials inside them: compose files,
 * labels, Dockerfiles and log drain configs. Masked whole. `docker_compose` is
 * Coolify's rendered copy of `docker_compose_raw`, with the same values.
 */
const BLOB_KEY =
  /^(docker_compose_raw|docker_compose|custom_labels|dockerfile|logdrain_.+_config)$/i;

function masked(key: string): boolean {
  return SECRET_KEY.test(key) || BLOB_KEY.test(key);
}

/**
 * Returns a copy of `value` with every secret masked, at any depth. Used for
 * every generic output: operation data, MCP tool results and the API console.
 * Null stays null, so "not set" still reads as not set. The input is not
 * changed.
 */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
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
        ? REDACTED_VALUE
        : walk(inner, seen);
  }
  seen.delete(value);
  return out;
}
