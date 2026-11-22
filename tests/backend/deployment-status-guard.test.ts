import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { growth, LINEAR_GROWTH } from "../shared/linear-cost.js";
import { HEAVY_TEST_MS } from "../shared/timing.js";

const ROOT = join(__dirname, "../..");
const SHARED = "src/shared/deployment-status.ts";

/** Every TypeScript source file under src/, as a repo-relative path. */
function sources(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

/** Coolify's deployment statuses, with the older spellings some send. */
const STATUS =
  "finished|success|failed|error|cancelled|cancelled-by-user|skipped";

/** `status === "failed"` and the like: a decision by a status spelling. */
const COMPARED = new RegExp(
  String.raw`status\s*[!=]==?\s*["'](?:${STATUS}|queued|in_progress)["']`,
);
const LIST_OPEN = /\(\s*\[/y;
const QUOTED_STATUS = new RegExp(String.raw`["'](?:${STATUS})["']`);

/**
 * `new Set(["finished", ...])`: a list of statuses of its own, as
 * `new Set(?:<[^>]*>)?\(\s*\[[^\]]*["'](?:${STATUS})["']` found it, by index
 * scans: that pattern read to the next `]` again from every `new Set(`. Each
 * list body is searched once, from its leftmost start.
 */
function listsStatus(text: string): boolean {
  // The next `>` and `]` at or after the current place; -1 once none is left.
  let gt = -2;
  let bracket = -2;
  let searchedTo = -1;
  for (let at = text.indexOf("new Set"); at >= 0;) {
    let next = at + "new Set".length;
    if (text[next] === "<") {
      if (gt !== -1 && gt < next) gt = text.indexOf(">", next);
      next = gt < 0 ? -1 : gt + 1;
    }
    LIST_OPEN.lastIndex = next;
    if (next >= 0 && LIST_OPEN.test(text)) {
      const start = LIST_OPEN.lastIndex;
      if (bracket !== -1 && bracket < start) {
        bracket = text.indexOf("]", start);
      }
      const end = bracket < 0 ? text.length : bracket;
      if (end !== searchedTo) {
        searchedTo = end;
        if (QUOTED_STATUS.test(text.slice(start, end))) return true;
      }
    }
    at = text.indexOf("new Set", at + 1);
  }
  return false;
}

/** Whether a file decides something by a deployment status spelling. */
function decidesStatus(text: string): boolean {
  return COMPARED.test(text) || listsStatus(text);
}

describe("deployment statuses have one reading", () => {
  it("only src/shared/deployment-status.ts decides what a deployment status means", () => {
    const files = sources();
    expect(files).toContain(SHARED);
    const offenders = files
      .filter((file) => file !== SHARED)
      .filter((file) => {
        const text = readFileSync(join(ROOT, file), "utf8");
        return decidesStatus(text);
      });
    expect(offenders).toEqual([]);
  });
});

describe("the status scan", () => {
  it("finds a status list, with or without a type argument", () => {
    expect(decidesStatus('const done = new Set(["finished", "failed"]);')).toBe(
      true,
    );
    expect(decidesStatus("new Set<string>([\n  'skipped',\n])")).toBe(true);
    expect(decidesStatus('new Set(["queued"]); ["failed"]')).toBe(false);
    expect(decidesStatus('new Set<a>(["x"], "failed")')).toBe(false);
    expect(decidesStatus('status === "error"')).toBe(true);
  });

  // Fixed work: growth() samples each size for 25 clock steps, a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on many unclosed lists",
    () => {
      const hostile = (scale: number) => "new Set([S".repeat(16_000 * scale);
      expect(decidesStatus(hostile(1))).toBe(false);
      // Growth, not milliseconds: load can't fail it (#105).
      const grew = growth((scale) => {
        const text = hostile(scale);
        return () => decidesStatus(text);
      });
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
});
