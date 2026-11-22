import { redactLog } from "../containers/logs.js";

/** One line of a deployment's build log, as the plugin passes it on. */
export interface BuildLogLine {
  /** Coolify's order within the deployment, from 1. */
  order: number;
  timestamp: string | null;
  stream: "stdout" | "stderr";
  /** Coolify hides these in its own UI unless debug is on. */
  hidden: boolean;
  /** The command that printed the line, when Coolify kept it. */
  command: string | null;
  output: string;
}

export interface BuildLog {
  lines: BuildLogLine[];
  /** Older lines were left out to keep the answer at MAX_BUILD_LOG_LINES. */
  truncated: boolean;
}

/** The most lines a build log answer carries; the last ones are kept. */
export const MAX_BUILD_LOG_LINES = 5_000;

type Raw = Record<string, unknown>;

function entryOf(value: unknown): Raw | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Coolify's build log (a JSON list of `{ command, output, type, timestamp,
 * hidden, order }` entries, kept as one string) as lines in Coolify's order.
 * A log that isn't such a list is read as plain text, one line each. Only
 * named fields are read, so nothing else in an entry comes along.
 */
export function parseBuildLog(raw: unknown): BuildLogLine[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    return raw
      .replace(/\r?\n$/, "")
      .split(/\r?\n/)
      .map((output, i) => ({
        order: i + 1,
        timestamp: null,
        stream: "stdout" as const,
        hidden: false,
        command: null,
        output,
      }));
  }
  const lines: (BuildLogLine & { at: number })[] = [];
  for (const value of parsed) {
    const entry = entryOf(value);
    if (!entry) continue;
    const at = lines.length;
    const order = entry.order;
    lines.push({
      at,
      order:
        typeof order === "number" && Number.isFinite(order) ? order : at + 1,
      timestamp: text(entry.timestamp),
      stream: entry.type === "stderr" ? "stderr" : "stdout",
      hidden: entry.hidden === true,
      command: text(entry.command),
      output: typeof entry.output === "string" ? entry.output : "",
    });
  }
  lines.sort((a, b) => a.order - b.order || a.at - b.at);
  return lines.map(({ at: _at, ...line }) => line);
}

/**
 * A raw build log parsed, cut to its last MAX_BUILD_LOG_LINES lines and
 * redacted as container logs are: the connection's own `secrets` anywhere,
 * URL passwords, credential query parameters, secret-named fields and
 * Authorization credentials, in every output and command.
 */
export function buildLog(raw: unknown, secrets: readonly string[]): BuildLog {
  const all = parseBuildLog(raw);
  const kept = all.slice(-MAX_BUILD_LOG_LINES);
  return {
    truncated: kept.length < all.length,
    lines: kept.map((line) => ({
      ...line,
      command: line.command === null ? null : redactLog(line.command, secrets),
      output: redactLog(line.output, secrets),
    })),
  };
}
