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

/*
 * The text redactor works one line at a time (the text is split on "\n", so
 * no pattern ever sees a newline) and every pattern is linear: no `\s` that
 * could cross a line, no nested quantifiers, and no two adjacent unbounded
 * quantifiers over overlapping characters. Names are bounded to 128
 * characters. A JSON string value and a key block are scanned by hand, not
 * by a pattern. Callers still bound the input first (coolify.exec caps each
 * stream at EXEC_RAW_CAP before calling this).
 */

/**
 * The start of `NAME=value`, `export NAME=value` or `NAME: value`, up to the
 * value's first non-blank character. Each part's characters are disjoint
 * from the next part's, so there is one way to match and no backtracking.
 */
const TEXT_PAIR =
  /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_.-]{0,127})([ \t]*[=:][ \t]*)(?=[^ \t])/;
/** `"name":` then `"`, as JSON prints it; the value is scanned by hand. */
const JSON_KEY = /"([A-Za-z0-9_.-]{1,128})"[ \t]*:[ \t]*"/g;
const PEM_BEGIN = "-----BEGIN ";
const PEM_TAIL = "PRIVATE KEY-----";
/** The kind in `-----BEGIN <kind>PRIVATE KEY-----`, like "RSA " or "". */
const PEM_KIND = /^[A-Z0-9 ]{0,40}$/;

/** Where a private key block starts in a line, and its kind. */
function pemStart(line: string): { index: number; kind: string } | null {
  let from = 0;
  for (;;) {
    const index = line.indexOf(PEM_BEGIN, from);
    if (index === -1) return null;
    const head = line.slice(index + PEM_BEGIN.length, index + 64);
    const tail = head.indexOf(PEM_TAIL);
    if (tail !== -1 && PEM_KIND.test(head.slice(0, tail))) {
      return { index, kind: head.slice(0, tail) };
    }
    from = index + PEM_BEGIN.length;
  }
}

/** The end of a JSON string whose content starts at `from`: its closing quote, or the line's end. */
function stringEnd(line: string, from: number): number {
  let i = from;
  while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
  return Math.min(i, line.length);
}

/** Masks `"secret_name": "value"` in one line; a value cut at the line's end is masked too. */
function maskJson(line: string): string {
  let out = "";
  let last = 0;
  JSON_KEY.lastIndex = 0;
  for (let m = JSON_KEY.exec(line); m; m = JSON_KEY.exec(line)) {
    const start = m.index + m[0].length;
    const end = stringEnd(line, start);
    if (masked(m[1])) {
      out += line.slice(last, start) + REDACTED_VALUE;
      last = end;
    }
    JSON_KEY.lastIndex = Math.max(end + 1, start);
  }
  return out + line.slice(last);
}

/** One line without a key block: JSON pairs, then a `NAME=value` line. */
function maskLine(line: string): string {
  const json = line.includes('"') ? maskJson(line) : line;
  const pair = TEXT_PAIR.exec(json);
  if (!pair || !masked(pair[2])) return json;
  const cr = json.endsWith("\r") ? "\r" : "";
  return `${pair[0]}${REDACTED_VALUE}${cr}`;
}

/**
 * The text form of {@link redact}, for command output: values of names the
 * redactor masks (`POSTGRES_PASSWORD=…`, `"client_secret": "…"`) and private
 * key blocks are replaced, including a block whose END was cut off. Everything
 * else is kept as it is. Linear in the length of `text`.
 */
export function redactText(text: string): string {
  const out: string[] = [];
  let open: string | null = null;
  for (const line of text.split("\n")) {
    if (open !== null) {
      const end = `-----END ${open}${PEM_TAIL}`;
      const at = line.indexOf(end);
      if (at === -1) continue;
      out.push(end + maskLine(line.slice(at + end.length)));
      open = null;
      continue;
    }
    const start = pemStart(line);
    if (!start) {
      out.push(maskLine(line));
      continue;
    }
    const begin = `${PEM_BEGIN}${start.kind}${PEM_TAIL}`;
    out.push(maskLine(line.slice(0, start.index)) + begin, REDACTED_VALUE);
    const rest = line.slice(start.index + begin.length);
    const end = `-----END ${start.kind}${PEM_TAIL}`;
    const at = rest.indexOf(end);
    if (at === -1) {
      open = start.kind;
    } else {
      out.push(end + maskLine(rest.slice(at + end.length)));
    }
  }
  if (open !== null) out.push(`-----END ${open}${PEM_TAIL}`);
  return out.join("\n");
}
