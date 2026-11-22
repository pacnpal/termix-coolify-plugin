import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { CoolifyError } from "../coolify/http.js";
import type { ResourceDto } from "../coolify/dto.js";
import type { Connections } from "../connections/service.js";
import { maskCredentials } from "../redact.js";
import { sshRunner, type SshRunner } from "../ssh.js";
import { assertContainerName, CommandError, dockerPrefix } from "./commands.js";
import type { ContainerChoice } from "./resolver.js";
import {
  ContainerError,
  type ContainerPlace,
  type Containers,
} from "./service.js";

/** The most lines a snapshot reads, from Coolify or from docker. */
export const MAX_LINES = 10_000;
export const DEFAULT_LINES = 100;
/** docker logs output kept over SSH: 10,000 long lines fit. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const LOGS_TIMEOUT_MS = 30_000;

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A name that says its value is a secret, from its keyword on, with its
 * optional quote. It starts at the keyword, not at the name's first
 * character (`DB_` of `DB_PASSWORD` stays as it is either way), so a long
 * run of word characters is never rescanned from every position.
 */
const NAME = String.raw`(?:password|passwd|pwd|secret|token|api_?key|private_?key|access_?key|credentials?)[\w.-]{0,64}["']?`;

/**
 * A YAML `name: value` that starts its line with an unquoted value: the
 * value is the rest of the line.
 */
const YAML_FIELD = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?["']?[\w.-]{0,64}${NAME}[ \t]{0,8}:[ \t]{1,8})(?!["'])[^\r\n]+`,
  "gim",
);

/**
 * `name=value`, `name: value` and `"name": "value"` anywhere: env dumps,
 * logfmt, config echoes and JSON log lines. A quoted value runs through its
 * closing quote (escapes honoured), an unterminated quote to the end of the
 * line, and an unquoted value to the end of its own token (whitespace or
 * `&`), so the next secret on the line is matched too.
 */
const SECRET_FIELD = new RegExp(
  String.raw`(${NAME}\s{0,8}[:=][ \t]{0,8})("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|["'][^\r\n]*|[^\s&]+)`,
  "gi",
);

/** One secret field's value masked; a closed quote keeps its quotes. */
function maskField(head: string, value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1) {
    if (value.endsWith(quote)) {
      return `${head}${quote}${REDACTED_VALUE}${quote}`;
    }
  }
  return `${head}${REDACTED_VALUE}`;
}

/**
 * An Authorization or Proxy-Authorization header's credential, any length.
 * Brackets count, so a credential with the connection token masked inside
 * it stays one run and its tail is masked too.
 */
const AUTHORIZATION =
  /(\b(?:proxy-)?authorization["']?\s{0,8}[:=]\s{0,8}["']?(?:(?:bearer|basic|token|digest)\s+)?)[A-Za-z0-9._~+/=|[\]-]+/gi;
/** A credential after an auth scheme word elsewhere in a line. */
const AUTH_HEADER = /(\b(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=|[\]-]{8,}/gi;
/** Passes before redaction is taken as settled; each pass only masks more. */
const MAX_PASSES = 4;

function redactOnce(text: string): string {
  return maskCredentials(text)
    .replace(YAML_FIELD, `$1${REDACTED_VALUE}`)
    .replace(SECRET_FIELD, (_m, head: string, value: string) =>
      maskField(head, value),
    )
    .replace(AUTHORIZATION, `$1${REDACTED_VALUE}`)
    .replace(AUTH_HEADER, `$1${REDACTED_VALUE}`);
}

const KEY_BEGIN = "-----BEGIN ";
const KEY_END = "-----END ";
const KEY_TAIL = "PRIVATE KEY-----";
/** The kind in `-----BEGIN <kind>PRIVATE KEY-----`, like "RSA " or "". */
const KEY_KIND = /^[A-Z0-9 ]{0,40}$/;
/** Where a kind's tail can be, past BEGIN: its 40 characters and the tail. */
const KEY_HEAD_MAX = 40 + KEY_TAIL.length;

interface KeyBegin {
  /** Where `-----BEGIN` (or, for an END marker, `-----END`) starts. */
  at: number;
  /** Where the key's body starts, right after the marker. */
  body: number;
  /** The END marker that closes it (an END marker: itself). */
  end: string;
}

/** The next private key marker (`marker` is KEY_BEGIN or KEY_END) at or after `from`, or null. */
function nextKeyMarker(
  text: string,
  from: number,
  marker: string,
): KeyBegin | null {
  for (
    let at = text.indexOf(marker, from);
    at >= 0;
    at = text.indexOf(marker, at + 1)
  ) {
    const head = at + marker.length;
    const tail = text.slice(head, head + KEY_HEAD_MAX).indexOf(KEY_TAIL);
    if (tail < 0) continue;
    const kind = text.slice(head, head + tail);
    if (!KEY_KIND.test(kind)) continue;
    return {
      at,
      body: head + tail + KEY_TAIL.length,
      end: `${KEY_END}${kind}${KEY_TAIL}`,
    };
  }
  return null;
}

/** The next private key BEGIN marker at or after `from`, or null. */
function nextKeyBegin(text: string, from: number): KeyBegin | null {
  return nextKeyMarker(text, from, KEY_BEGIN);
}

/**
 * Where the last private key END marker that no BEGIN in `text` opened
 * starts, or -1. Such an END means `text` started inside a key (a tail cut:
 * `docker logs --tail`, Coolify's `?lines=`, a follow that starts at now), so
 * everything before it may be the key's body. Linear: every search moves
 * forward, and a search result is reused while it is still ahead.
 */
function lastLoneKeyEnd(text: string): number {
  let last = -1;
  let begin = nextKeyBegin(text, 0);
  let end = nextKeyMarker(text, 0, KEY_END);
  while (end) {
    if (begin && begin.at < end.at) {
      // A block opens first: its own END closes it, and anything between
      // (an END of another kind too) is its body.
      const close = text.indexOf(begin.end, begin.body);
      if (close < 0) break;
      const pos = close + begin.end.length;
      begin = nextKeyBegin(text, pos);
      if (end.at < pos) end = nextKeyMarker(text, pos, KEY_END);
    } else {
      last = end.at;
      end = nextKeyMarker(text, end.body, KEY_END);
    }
  }
  return last;
}

/** Where the tail rule's END is in texts read as joined by newlines. */
interface KeyTailAt {
  /** The text holding the END marker. */
  index: number;
  /** Where the marker starts in that text. */
  from: number;
}

/**
 * The tail rule's END in a snapshot (or a stream's first lines) given as
 * texts in order (lines, or log entries) read as if joined by newlines: the
 * last END marker that no BEGIN before it opened, or null when there is none
 * or nothing comes before it.
 */
function keyTailAt(texts: readonly string[]): KeyTailAt | null {
  let at = lastLoneKeyEnd(texts.join("\n"));
  if (at <= 0) return null;
  for (let index = 0; index < texts.length; index += 1) {
    if (at <= texts[index].length) return { index, from: at };
    at -= texts[index].length + 1;
  }
  return null;
}

/**
 * The tail rule over texts in order (lines, or log entries; see keyTailAt):
 * when an END marker appears that no BEGIN before it opened, everything from
 * the start up to that END is masked. Each text before it becomes
 * REDACTED_VALUE, the one holding it keeps the marker and what follows it,
 * and the texts after are untouched. Same length as `texts`.
 */
export function maskKeyTail(texts: readonly string[]): string[] {
  const tail = keyTailAt(texts);
  if (!tail) return [...texts];
  return texts.map((text, i) => {
    if (i < tail.index) return REDACTED_VALUE;
    if (i > tail.index) return text;
    return REDACTED_VALUE + text.slice(tail.from);
  });
}

/**
 * Every private key block's body masked, wherever it is: several on one
 * line (a JSON array of PEMs with escaped newlines), across real lines, and
 * a block without its END to the end of `text`. The markers stay. `text` may
 * start inside a key: an END that no BEGIN opened masks everything before it
 * (maskKeyTail). Linear: every search moves forward.
 */
export function maskKeyBlocks(text: string): string {
  const lone = lastLoneKeyEnd(text);
  return lone > 0
    ? REDACTED_VALUE + maskWholeBlocks(text.slice(lone))
    : maskWholeBlocks(text);
}

/** maskKeyBlocks without the tail rule: for a slice that isn't a start. */
function maskWholeBlocks(text: string): string {
  let out = "";
  let pos = 0;
  for (let b = nextKeyBegin(text, 0); b; b = nextKeyBegin(text, pos)) {
    out += text.slice(pos, b.body) + REDACTED_VALUE;
    const close = text.indexOf(b.end, b.body);
    if (close < 0) return out;
    out += b.end;
    pos = close + b.end.length;
  }
  return out + text.slice(pos);
}

/** The last private key block in `text` still open at its end, or null. */
export function openKeyBlock(text: string): KeyBegin | null {
  let pos = 0;
  for (let b = nextKeyBegin(text, 0); b; b = nextKeyBegin(text, pos)) {
    const close = text.indexOf(b.end, b.body);
    if (close < 0) return b;
    pos = close + b.end.length;
  }
  return null;
}

/**
 * Log text with its secrets masked before it leaves the backend: the
 * connection's own token and Access secret anywhere, then what redact.ts
 * masks in a string (a URL's password, credential query parameters), then
 * secret-named fields and Authorization credentials, repeated until the
 * text stops changing (a fixed point, at most MAX_PASSES).
 */
export function redactLog(text: string, secrets: readonly string[]): string {
  return redactWith(maskKeyBlocks(text), secrets);
}

/**
 * redactLog of a slice of a line that isn't where the text starts (safeCut's
 * windows and halves): no tail rule, since its start is not a cut the log
 * was read from.
 */
function redactSlice(text: string, secrets: readonly string[]): string {
  return redactWith(maskWholeBlocks(text), secrets);
}

/** The passes after key blocks: `secrets`, then redactOnce to a fixed point. */
function redactWith(masked: string, secrets: readonly string[]): string {
  let out = masked;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED_VALUE);
  }
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = redactOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

export interface LogsRequest {
  lines: number;
  timestamps: boolean;
  /** A Part of the resource, by uuid. */
  part?: string;
  /** A name from an earlier choices answer. */
  container?: string;
}

/** Where a snapshot came from, so the UI can say which rule applied. */
export type LogSource = "coolify" | "ssh";

export interface LogsAnswer {
  source: LogSource;
  text: string;
  /** The container read over SSH. */
  container?: string;
}

export interface LogsChoices {
  choices: ContainerChoice[];
}

function invalid(message: string): ContainerError {
  return new ContainerError("invalid-input", message);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function readLines(value: unknown): number {
  if (!present(value)) return DEFAULT_LINES;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,9}$/.test(text)) {
    throw invalid("lines must be a whole number");
  }
  const lines = Number(text);
  if (lines < 1) throw invalid("lines must be at least 1");
  return Math.min(lines, MAX_LINES);
}

function readFlag(value: unknown): boolean {
  if (!present(value)) return false;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw invalid("timestamps must be true or false");
}

/**
 * Checks a logs request (a route query or an operation input). The line count
 * is capped at MAX_LINES, never refused for being large.
 */
export function readLogsRequest(raw: unknown): LogsRequest {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: LogsRequest = {
    lines: readLines(input.lines),
    timestamps: readFlag(input.timestamps),
  };
  if (present(input.part)) {
    if (typeof input.part !== "string" || !UUID.test(input.part)) {
      throw invalid("part must be a Part's uuid");
    }
    out.part = input.part;
  }
  if (present(input.container)) {
    try {
      out.container = assertContainerName(input.container);
    } catch {
      throw invalid("container must be a container name");
    }
  }
  return out;
}

/** The last `max` lines of a log, keeping a final newline when it had one. */
export function lastLines(text: string, max: number): string {
  const trailing = text.endsWith("\n");
  const lines = (trailing ? text.slice(0, -1) : text).split("\n");
  if (lines.length <= max) return text;
  return lines.slice(-max).join("\n") + (trailing ? "\n" : "");
}

export interface LogsCommandOptions {
  sudo: boolean;
  /** Lines from the end; 0 with follow starts at now. */
  lines: number;
  timestamps: boolean;
  follow?: boolean;
}

/**
 * The `docker logs` line for the Linked host. The container name passes the
 * name check and is quoted, the line count is quoted, and stderr joins
 * stdout so both reach the reader in order.
 */
export function logsCommand(
  container: string,
  opts: LogsCommandOptions,
): string {
  const name = assertContainerName(container);
  const min = opts.follow ? 0 : 1;
  if (
    !Number.isSafeInteger(opts.lines) ||
    opts.lines < min ||
    opts.lines > MAX_LINES
  ) {
    throw new CommandError("Not a line count");
  }
  return [
    `${dockerPrefix(opts.sudo)} logs`,
    ...(opts.follow ? ["-f"] : []),
    `--tail ${shellQuote(String(opts.lines))}`,
    ...(opts.timestamps ? ["--timestamps"] : []),
    shellQuote(name),
    "2>&1",
  ].join(" ");
}

/** The part of an ssh2 exec channel the follow uses. */
interface ExecStream {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  signal?: (name: string) => unknown;
  close?: () => unknown;
}

interface ExecClient {
  exec(
    command: string,
    options: { pty: boolean },
    callback: (err: Error | undefined, stream: ExecStream) => void,
  ): unknown;
}

/** Receives a follow's output. `lines` never holds a partial line. */
export interface FollowSink {
  lines: (lines: string[]) => void;
  /** The process ended on its own (the container stopped or went away). */
  end: () => void;
}

export interface Following {
  kind: "following";
  container: string;
  where: ContainerPlace;
  /**
   * Throws unless the actor may still read this follow: lifecycle's
   * authorize (coolify.operate, an operate grant, the uuid in the
   * connection's own list), the snapshot's revision and host access.
   */
  recheck: () => Promise<void>;
  /** Kills the remote docker logs and ends the SSH connection. Idempotent. */
  stop: () => void;
}

/** A line longer than this is sent in pieces, so the carry can't grow. */
export const MAX_LINE = 16 * 1024;
/** Raw text kept back from a long line's cut, so a match can't straddle it. */
const CUT_CONTEXT = 1024;
/** Cut points tried before a long line is masked from there to its end. */
const CUT_TRIES = 32;
/**
 * Raw text before a cut that its check looks at: longer than any bounded
 * match (a secret, a URL's credentials, a field's name and short value). A
 * match that starts further back is unbounded and runs to the cut, which
 * the caller catches (the redacted prefix then ends masked).
 */
const CUT_WINDOW = 4096;

/** `text` in pieces of at most MAX_LINE. */
function pieces(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_LINE) {
    out.push(text.slice(i, i + MAX_LINE));
  }
  return out.length ? out : [""];
}

/**
 * Where a long line can be cut so that no bounded match (a secret, a field,
 * a URL credential) spans the cut: around the cut, redacting the two halves
 * apart masks exactly what redacting them together would. Only a window of
 * CUT_WINDOW before the cut and what follows it (the kept-back context) is
 * checked, so each try costs the same however long the line is. Tries
 * `from`, then earlier whitespace. 0 when none works.
 */
/** A secret field's head, without its value. */
const SECRET_HEAD = new RegExp(String.raw`${NAME}\s{0,8}[:=][ \t]{0,8}`, "gi");
/** A YAML secret line's head: its value is the rest of the line. */
const YAML_HEAD = new RegExp(
  String.raw`^[ \t]*(?:-[ \t]+)?["']?[\w.-]{0,64}${NAME}[ \t]{0,8}:`,
  "im",
);
/** An auth credential's head, either kind. */
const AUTH_HEAD =
  /\b(?:(?:proxy-)?authorization["']?\s{0,8}[:=]\s{0,8}["']?(?:(?:bearer|basic|token|digest)\s+)?|(?:bearer|basic|token)\s+)/gi;
/**
 * Where an open secret context ends at a cut: only whitespace. `@`, `/`,
 * `&` and every other mid-token character keep it open (a password may hold
 * any of them), so an over-long line is masked too much, never too little.
 */
const CONTEXT_END = /\s/g;

/** The index of `text[from]`'s closing quote, honouring backslashes, or -1. */
function closingQuote(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * Where a secret that is still open at the end of `text` starts, or -1:
 * a URL's `scheme://` whose userinfo hasn't ended, a quoted secret value
 * without its closing quote, an unquoted secret value or a YAML secret line
 * running to the end, or an Authorization credential running to the end.
 * `text` starts where nothing was open (a line's start or an earlier clean
 * cut), and every scan moves forward, so this is linear in `text`.
 * Conservative: anything that might still be a secret counts as open.
 */
export function openSecretStart(text: string): number {
  let open = -1;
  const note = (at: number) => {
    if (open < 0 || at < open) open = at;
  };
  // The first `scheme://` of the last token: open until whitespace.
  let lastSpace = text.length - 1;
  while (lastSpace >= 0 && !/\s/.test(text[lastSpace])) lastSpace -= 1;
  const url = text.indexOf("://", lastSpace + 1);
  if (url >= 0) {
    let start = url;
    while (
      start > 0 &&
      url - start < 64 &&
      /[a-z0-9+.-]/i.test(text[start - 1])
    ) {
      start -= 1;
    }
    note(start);
  }
  const yaml = YAML_HEAD.exec(text);
  if (yaml) note(yaml.index);
  const key = openKeyBlock(text);
  if (key) note(key.at);
  SECRET_HEAD.lastIndex = 0;
  for (let m = SECRET_HEAD.exec(text); m; m = SECRET_HEAD.exec(text)) {
    const value = m.index + m[0].length;
    const quote = text[value];
    if (quote === '"' || quote === "'") {
      const close = closingQuote(text, value);
      if (close < 0) {
        note(m.index);
        break;
      }
      SECRET_HEAD.lastIndex = close + 1;
      continue;
    }
    CONTEXT_END.lastIndex = value;
    const end = CONTEXT_END.exec(text);
    if (!end) {
      note(m.index);
      break;
    }
    SECRET_HEAD.lastIndex = Math.max(end.index, value);
  }
  AUTH_HEAD.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (let m = AUTH_HEAD.exec(text); m; m = AUTH_HEAD.exec(text)) last = m;
  if (last) {
    CONTEXT_END.lastIndex = last.index + last[0].length;
    if (!CONTEXT_END.exec(text)) note(last.index);
  }
  return open;
}

function safeCut(text: string, secrets: readonly string[], from: number) {
  let p = from;
  for (let tries = 0; tries < CUT_TRIES && p > 0; tries += 1) {
    const start = Math.max(0, p - CUT_WINDOW);
    const window = text.slice(start);
    const at = p - start;
    const left = redactSlice(window.slice(0, at), secrets);
    const right = redactSlice(window.slice(at), secrets);
    if (left + right === redactSlice(window, secrets)) return p;
    const space = text.lastIndexOf(" ", p - 2);
    p = space > start ? space + 1 : p - CUT_CONTEXT;
  }
  return 0;
}

/** Redacts whole lines in order, carrying an open private key block. */
export interface KeyBlockCarry {
  /**
   * The END marker of a private key block an earlier line left open, or
   * null. Every line up to it is the key's body.
   */
  keyEnd: string | null;
  /**
   * One whole line, redacted (redactLog), or null when it is the body of a
   * key block an earlier line opened: such a line is dropped. A line that
   * holds the END keeps it and what follows.
   */
  line(raw: string): string | null;
}

/**
 * The cross-line half of log redaction. redactLog masks a key block inside
 * the text it is given; a block whose BEGIN, body and END arrive as separate
 * lines (or log entries) needs this state, kept for the whole stream and fed
 * every line in order, so no body line goes out after its BEGIN did.
 */
export function keyBlockCarry(secrets: readonly string[]): KeyBlockCarry {
  const carry: KeyBlockCarry = {
    keyEnd: null,
    line(raw: string): string | null {
      let line = raw;
      if (carry.keyEnd !== null) {
        const at = line.indexOf(carry.keyEnd);
        if (at < 0) return null;
        line = line.slice(at);
        carry.keyEnd = null;
      }
      const out = redactLog(line, secrets);
      carry.keyEnd = openKeyBlock(line)?.end ?? null;
      return out;
    },
  };
  return carry;
}

/** A `docker logs --timestamps` prefix. */
const LOG_STAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) /;
/** A key body line at full width: PEM (64), OpenSSH (70) or MIME (76). */
const KEY_WIDE =
  /^(?:[A-Za-z0-9+/=]{64}|[A-Za-z0-9+/=]{70}|[A-Za-z0-9+/=]{76})$/;
/** A key body's last, shorter line. */
const KEY_SHORT = /^[A-Za-z0-9+/=]{1,76}$/;
/** A PEM header line, or the blank line after the headers. */
const KEY_HEADER = /^(?:(?:Proc-Type|DEK-Info): .*)?$/;
/** Text a stream holds at most while its start may be inside a key. */
const KEY_HOLD_MAX = 32 * 1024;

/**
 * Whether a stream whose lines so far are `lines` may still be inside a
 * private key it started in: its last line is shaped like a key's body (a
 * full-width line, a header or blank line, or a short last line right after
 * a full-width one or at the start).
 */
function mayBeInKey(lines: readonly string[]): boolean {
  const shape = (i: number) => lines[i].replace(LOG_STAMP, "");
  const last = shape(lines.length - 1);
  if (KEY_WIDE.test(last) || KEY_HEADER.test(last)) return true;
  if (!KEY_SHORT.test(last)) return false;
  return lines.length === 1 || KEY_WIDE.test(shape(lines.length - 2));
}

/**
 * Turns one SSH stream's bytes into redacted lines. One UTF-8 decoder per
 * stream keeps a character split across chunks whole. A line longer than
 * MAX_LINE is cut only where `safeCut` allows, with at least CUT_CONTEXT
 * (and the longest secret) kept back; when no safe cut exists the rest of
 * that line is masked, so nothing is let through unredacted.
 *
 * A stream can start inside a private key (a follow starts at now), so its
 * first lines are held while they may be a key's body: until a chunk ends
 * on a whole line that isn't shaped like one, the stream ends, or
 * KEY_HOLD_MAX is held. Then maskKeyTail applies to everything held: an END
 * that no BEGIN opened masks every line before it.
 */
export function lineSplitter(
  secrets: readonly string[],
  emit: (lines: string[]) => void,
) {
  const decoder = new TextDecoder("utf-8");
  const keep = Math.max(CUT_CONTEXT, ...secrets.map((s) => s.length * 2));
  let carry = "";
  let skipping = false;
  // A private key block left open by an earlier line: every line up to its
  // END is the key's body and is dropped.
  const keys = keyBlockCarry(secrets);
  // The stream's first lines, held while it may have started inside a key.
  let opening = true;
  let held: string[] = [];
  let heldSize = 0;

  /**
   * The held lines once the stream's start is settled, with the tail rule
   * applied over them and the partial line: everything held before an END
   * that no BEGIN opened becomes one REDACTED_VALUE.
   */
  function settle(): string[] {
    opening = false;
    const lines = held;
    held = [];
    const tail = keyTailAt([...lines, carry]);
    if (!tail) return lines;
    if (tail.index === lines.length) {
      carry = REDACTED_VALUE + carry.slice(tail.from);
      return [];
    }
    return [
      REDACTED_VALUE + lines[tail.index].slice(tail.from),
      ...lines.slice(tail.index + 1),
    ];
  }

  function take(text: string, final: boolean): void {
    let parts = (carry + text).split(/\r?\n/);
    carry = final ? "" : (parts.pop() ?? "");
    if (opening) {
      for (const line of parts) {
        held.push(line);
        heldSize += line.length + 1;
      }
      parts = [];
      const waiting =
        !final &&
        heldSize <= KEY_HOLD_MAX &&
        (carry === ""
          ? held.length === 0 || mayBeInKey(held)
          : carry.length <= MAX_LINE + keep);
      if (waiting) return;
      parts = settle();
    }
    const out: string[] = [];
    for (const line of parts) {
      if (skipping) {
        skipping = false;
        continue;
      }
      const sent = keys.line(line);
      // A key body line, or the empty end of the stream.
      if (sent === null || (final && sent === "")) continue;
      out.push(...pieces(sent));
    }
    if (keys.keyEnd !== null && carry.length > MAX_LINE) {
      // A key body line too long to wait for: keep only what could start
      // its END marker.
      const at = carry.indexOf(keys.keyEnd);
      if (at < 0) carry = carry.slice(-(keys.keyEnd.length - 1));
      else {
        carry = carry.slice(at);
        keys.keyEnd = null;
      }
    }
    if (skipping) {
      carry = "";
    } else {
      while (keys.keyEnd === null && carry.length > MAX_LINE + keep) {
        const cut = safeCut(carry, secrets, carry.length - keep);
        if (cut <= 0) {
          out.push(REDACTED_VALUE);
          carry = "";
          skipping = true;
          break;
        }
        const prefix = carry.slice(0, cut);
        let openAt = openSecretStart(prefix);
        // The connection's own secrets can be longer than safeCut's window:
        // one that starts before the cut and runs past it is open too. The
        // kept-back context is at least twice the longest, so it is whole.
        for (const secret of secrets) {
          if (!secret) continue;
          const at = carry.indexOf(
            secret,
            Math.max(0, cut - secret.length + 1),
          );
          if (at >= 0 && at < cut && (openAt < 0 || at < openAt)) openAt = at;
        }
        if (openAt >= 0) {
          // A key block still open here may run on past this line: its body
          // lines are dropped until its END (over-masking, never under).
          const key = openKeyBlock(prefix);
          if (key && carry.indexOf(key.end, cut) < 0) keys.keyEnd = key.end;
          // A secret is open at the cut: mask from its start (from the word
          // before it, so nothing bounded straddles) to the end of the line.
          const space = prefix.lastIndexOf(" ", openAt - 1);
          const clean =
            space >= 0 && openAt - space < CUT_WINDOW ? space + 1 : 0;
          if (clean > 0)
            out.push(...pieces(redactLog(prefix.slice(0, clean), secrets)));
          out.push(REDACTED_VALUE);
          carry = "";
          skipping = true;
          break;
        }
        const sent = redactLog(prefix, secrets);
        out.push(...pieces(sent));
        if (sent.endsWith(REDACTED_VALUE) && !prefix.endsWith(REDACTED_VALUE)) {
          // A mask ran to the cut (a YAML value, an unclosed quote, a token
          // longer than the window): the rest of the line may be more of it.
          carry = "";
          skipping = true;
          break;
        }
        carry = carry.slice(cut);
      }
    }
    if (out.length) emit(out);
  }

  return {
    data(chunk: unknown): void {
      if (typeof chunk === "string") take(chunk, false);
      else if (chunk instanceof Uint8Array) {
        take(decoder.decode(chunk, { stream: true }), false);
      }
    },
    end(): void {
      take(decoder.decode(), true);
    },
  };
}

export interface LogsDeps {
  connections: Connections;
  containers: Containers;
  /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
  run?: SshRunner;
}

type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

/**
 * Container logs. A snapshot comes from Coolify's API when the API rules
 * allow it (coolify.operate, checked by the route or the action, an owner or
 * operate or configure Grant, and a token with read:sensitive), else from
 * `docker logs` over SSH on the Linked host, which needs coolify.operate and
 * the actor's own connect access to that host. A follow is always SSH.
 * Both need lifecycle's authorize. Every read is about one snapshot of the
 * connection, checked again right before each fetch or SSH, and every line
 * goes through redactLog before it leaves.
 */

export function createLogs(ctx: PluginContext, deps: LogsDeps) {
  const run = deps.run ?? sshRunner(ctx);

  /** Logs through Coolify, or null when the API rules send this to SSH. */
  async function fromCoolify(
    snap: Snapshot,
    res: ResourceDto,
    request: LogsRequest,
  ): Promise<string | null> {
    // A container from an SSH choices answer is read over SSH; Coolify reads
    // a whole service only one sub-service at a time.
    if (request.container || res.kind === "service") return null;
    // The grant level was checked by authorize; the token needs read:sensitive.
    if (!snap.view.abilities.sensitive) return null;
    try {
      return await snap.api.logs(res.kind, res.uuid, {
        lines: request.lines,
        timestamps: request.timestamps,
        parentUuid: res.parentUuid ?? undefined,
        // Right before each fetch, after the budget's and retries' waits.
        beforeFetch: () =>
          deps.containers.assertSnapshotHolds(snap.view.id, snap),
      });
    } catch (err) {
      // The token lost read:sensitive since the last probe.
      if (err instanceof CoolifyError && err.cause === "forbidden-ability") {
        return null;
      }
      throw err;
    }
  }

  async function fromSsh(
    connectionId: number,
    snap: Snapshot,
    uuid: string,
    request: LogsRequest,
    signal?: AbortSignal,
  ): Promise<LogsAnswer | LogsChoices> {
    const located = await deps.containers.locate(
      connectionId,
      snap,
      uuid,
      request,
    );
    signal?.throwIfAborted();
    if (located.kind === "choices") return { choices: located.choices };
    const { where, sudo, container } = located;
    let command: string;
    try {
      command = logsCommand(container.name, {
        sudo,
        lines: request.lines,
        timestamps: request.timestamps,
      });
    } catch {
      throw new ContainerError(
        "container-not-found",
        "That container can't be read.",
      );
    }
    await deps.containers.assertSnapshotHolds(connectionId, snap);
    // Last check, with no await before the command: guard calls its callback
    // synchronously, so a cancel during the revision check above never starts
    // docker logs. Checked here, not inside the callback, because guard turns
    // anything the callback throws into ssh-failed.
    signal?.throwIfAborted();
    const result = await deps.containers.guard(where, () =>
      run(where.hostId, command, {
        timeoutMs: LOGS_TIMEOUT_MS,
        maxOutputBytes: MAX_LOG_BYTES,
      }),
    );
    signal?.throwIfAborted();
    if (result.code !== 0) {
      // Only a fixed message: the output could hold anything.
      throw new ContainerError(
        "ssh-failed",
        "docker logs failed on the Linked host.",
      );
    }
    return {
      source: "ssh",
      text: redactLog(
        lastLines(result.stdout, request.lines),
        await snap.secrets(),
      ),
      container: container.name,
    };
  }

  return {
    /**
     * A route query or an operation input in; a labelled snapshot out. An
     * aborted signal (a cancelled run) stops it at its next await, so it
     * never starts docker logs after the abort.
     */
    async snapshot(
      connectionId: number,
      uuid: string,
      raw: unknown,
      signal?: AbortSignal,
    ): Promise<LogsAnswer | LogsChoices> {
      const request = readLogsRequest(raw);
      // Read once: every later step is checked against this target.
      const snap = await deps.connections.snapshot(connectionId);
      const { res } = await deps.containers.target(
        connectionId,
        uuid,
        request.part,
      );
      signal?.throwIfAborted();
      const text = await fromCoolify(snap, res, request);
      signal?.throwIfAborted();
      if (text !== null) {
        return {
          source: "coolify",
          text: redactLog(lastLines(text, request.lines), await snap.secrets()),
        };
      }
      return fromSsh(connectionId, snap, uuid, request, signal);
    },

    /**
     * Streams new lines of a container's logs over SSH as the actor, with
     * the same checks as a snapshot over SSH. Starts at now.
     */
    async follow(
      connectionId: number,
      uuid: string,
      request: { part?: string; container?: string; timestamps: boolean },
      sink: FollowSink,
    ): Promise<Following | LogsChoices> {
      const snap = await deps.connections.snapshot(connectionId);
      const located = await deps.containers.locate(
        connectionId,
        snap,
        uuid,
        request,
      );
      if (located.kind === "choices") return { choices: located.choices };
      const { where, sudo, container } = located;
      const command = logsCommand(container.name, {
        sudo,
        lines: 0,
        timestamps: request.timestamps,
        follow: true,
      });
      const secrets = await snap.secrets();
      await deps.containers.assertSnapshotHolds(connectionId, snap);
      const connection = await deps.containers.guard(where, () =>
        ctx.ssh.connect(where.hostId, {
          purpose: "coolify",
          profile: "background",
        }),
      );
      const client = connection.client as ExecClient;
      let stream: ExecStream | null = null;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        // A pty ties docker logs to the channel: closing it hangs it up.
        try {
          stream?.signal?.("KILL");
        } catch {
          // The channel may already be gone.
        }
        try {
          stream?.close?.();
        } catch {
          // As above.
        }
        connection.dispose();
      };
      try {
        stream = await new Promise<ExecStream>((resolve, reject) => {
          client.exec(command, { pty: true }, (err, opened) =>
            err ? reject(err) : resolve(opened),
          );
        });
      } catch {
        stop();
        throw new ContainerError(
          "ssh-failed",
          "docker logs could not start on the Linked host.",
        );
      }
      // stdout and stderr each keep their own partial line and decoder.
      const emit = (lines: string[]) => {
        if (!stopped) sink.lines(lines);
      };
      const out = lineSplitter(secrets, emit);
      const err = lineSplitter(secrets, emit);
      stream.on("data", (chunk) => {
        if (!stopped) out.data(chunk);
      });
      stream.stderr?.on("data", (chunk) => {
        if (!stopped) err.data(chunk);
      });
      stream.on("close", () => {
        if (stopped) return;
        out.end();
        err.end();
        stop();
        sink.end();
      });
      const recheck = async () => {
        await deps.containers.target(connectionId, uuid, request.part);
        await deps.containers.assertSnapshotHolds(connectionId, snap);
        await deps.containers.assertHostAccess(where.hostId);
      };
      return {
        kind: "following",
        container: container.name,
        where,
        recheck,
        stop,
      };
    },
  };
}

export type Logs = ReturnType<typeof createLogs>;
