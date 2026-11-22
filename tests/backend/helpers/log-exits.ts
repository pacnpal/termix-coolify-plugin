// A source-level audit of every backend function that hands log or command
// text to a caller. The registry (in log-exits.test.ts) names each function
// that touches such text; this file checks the source against it.

/** What a registered function does with log or command text. */
export type LogExit =
  /** Returns it to a caller: its body must call a redactor. */
  | { kind: "exit"; what: string }
  /** Returns it raw, only to the named functions of its own file. */
  | { kind: "feeds"; into: readonly string[]; what: string }
  /** Passes on what registered exits (`file#fn`) already redacted. */
  | { kind: "relays"; from: readonly string[]; what: string }
  /** Returns only values parsed from it, never the text. */
  | { kind: "parses"; what: string }
  /** Reads it and drops it. */
  | { kind: "discards"; what: string }
  /** A known exit that still skips the redactor; fails once it is fixed. */
  | { kind: "pending"; issue: string; what: string }
  /** Deliberately unredacted; the reason says why. */
  | { kind: "unredacted"; what: string };

/** The redactors: redactLog itself, or a helper that runs every line through it. */
export const REDACTORS =
  /\b(?:redactLog|keyBlockCarry|lineSplitter|redactLogStream|buildLog)\(/;

/** Where log or command text enters the backend. */
export const SOURCES: readonly RegExp[] = [
  // Coolify's log reads: container, preview and deployment logs.
  /\bapi\.(?:logs|previewLogs|deploymentWithLog)\(/,
  // docker logs over SSH.
  /\blogsCommand\(/,
  // An SSH channel's output.
  /\bclient\.exec\(/,
  // A finished SSH command's output.
  /\b\w+\.std(?:out|err)\b/,
  // Log Search hits.
  /"log-search\.search"/,
  // The generic API's log and output fields.
  /\bLOG_FIELDS\[/,
  // Package Manager's upgrade output.
  /\bPM_UPGRADE\b/,
];

interface Fn {
  name: string;
  /** Line indexes, both inclusive. */
  start: number;
  end: number;
}

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "await",
  "typeof",
  "new",
  "throw",
  "function",
  "super",
  "else",
  "void",
]);
const SIGNATURE =
  /^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\(/;
const ARROW =
  /^(\s*)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;
const COMMENT = /^\s*(?:\*|\/\/|\/\*)/;
const DECLARATION = /^(?:export\s+)?(?:const|function|async\s+function)\s/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Every named function, method and const arrow function in `source`, by
 * its prettier layout: a body closes on a line of its own, at the
 * signature's indentation, holding only `}`, `},` or `};`.
 */
export function functionsOf(source: string): Fn[] {
  const lines = source.split("\n");
  const fns: Fn[] = [];
  lines.forEach((line, start) => {
    if (COMMENT.test(line)) return;
    const m = SIGNATURE.exec(line) ?? ARROW.exec(line);
    if (!m || KEYWORDS.has(m[2])) return;
    const indent = m[1].length;
    for (let j = start + 1; j < lines.length; j += 1) {
      const text = lines[j].trim();
      if (text === "" || indentOf(lines[j]) > indent) continue;
      if (indentOf(lines[j]) < indent) return;
      if (/^\}[,;]?$/.test(text)) {
        fns.push({ name: m[2], start, end: j });
        return;
      }
      // A signature's own closing lines: `): Type {`, `}> {`.
      if (/^[)}]/.test(text)) continue;
      return;
    }
  });
  return fns;
}

/** The functions around line `at`, innermost first. */
function around(fns: Fn[], at: number): Fn[] {
  return fns
    .filter((fn) => fn.start <= at && at <= fn.end)
    .sort((a, b) => b.start - a.start);
}

function body(source: string, fn: Fn): string {
  return source
    .split("\n")
    .slice(fn.start, fn.end + 1)
    .join("\n");
}

/**
 * Checks `files` (path to source) against `registry` (keys `path#fn`).
 * Answers every problem found; none means every exit is redacted.
 */
export function auditLogExits(
  files: Record<string, string>,
  registry: Record<string, LogExit>,
): string[] {
  const problems: string[] = [];
  const fnsOf = new Map(
    Object.entries(files).map(([path, source]) => [path, functionsOf(source)]),
  );
  const find = (key: string) => {
    const [path, name] = key.split("#");
    const source = files[path];
    const fn = fnsOf.get(path)?.find((f) => f.name === name);
    return source !== undefined && fn ? { path, source, fn } : null;
  };

  // Every place log text enters lies in a registered function.
  for (const [path, source] of Object.entries(files)) {
    const fns = fnsOf.get(path) ?? [];
    source.split("\n").forEach((line, at) => {
      if (COMMENT.test(line) || DECLARATION.test(line)) return;
      if (!SOURCES.some((re) => re.test(line))) return;
      const owner = around(fns, at).find(
        (fn) => registry[`${path}#${fn.name}`],
      );
      if (!owner) {
        problems.push(
          `${path}:${at + 1} reads log text outside any registered function: ${line.trim()}`,
        );
      }
    });
  }

  for (const [key, entry] of Object.entries(registry)) {
    const found = find(key);
    if (!found) {
      problems.push(`${key} is registered but not found`);
      continue;
    }
    const text = body(found.source, found.fn);
    const [path, name] = key.split("#");
    switch (entry.kind) {
      case "exit":
        if (!REDACTORS.test(text)) {
          problems.push(`${key} (${entry.what}) skips redactLog`);
        }
        break;
      case "pending":
        if (REDACTORS.test(text)) {
          problems.push(
            `${key} (${entry.what}) now calls a redactor: make it an exit (${entry.issue})`,
          );
        }
        break;
      case "relays":
        for (const from of entry.from) {
          if (registry[from]?.kind !== "exit") {
            problems.push(`${key} relays ${from}, which is not an exit`);
          }
        }
        break;
      case "feeds": {
        for (const into of entry.into) {
          if (!registry[`${path}#${into}`]) {
            problems.push(`${key} feeds ${into}, which is not registered`);
          }
        }
        // Every caller of the feeder is one of the functions it feeds.
        const call = new RegExp(`(?<![\\w.$])${name}\\(`);
        const fns = fnsOf.get(path) ?? [];
        found.source.split("\n").forEach((line, at) => {
          if (COMMENT.test(line) || !call.test(line)) return;
          if (at >= found.fn.start && at <= found.fn.end) return;
          const callers = around(fns, at).map((fn) => fn.name);
          if (!callers.some((c) => entry.into.includes(c))) {
            problems.push(
              `${path}:${at + 1} calls ${name}, whose raw text only ${entry.into.join(", ")} may take`,
            );
          }
        });
        break;
      }
      default:
        break;
    }
  }
  return problems;
}
