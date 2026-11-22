import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

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
/** `new Set(["finished", ...])`: a list of statuses of its own. */
const LISTED = new RegExp(
  String.raw`new Set(?:<[^>]*>)?\(\s*\[[^\]]*["'](?:${STATUS})["']`,
);

describe("deployment statuses have one reading", () => {
  it("only src/shared/deployment-status.ts decides what a deployment status means", () => {
    const files = sources();
    expect(files).toContain(SHARED);
    const offenders = files
      .filter((file) => file !== SHARED)
      .filter((file) => {
        const text = readFileSync(join(ROOT, file), "utf8");
        return COMPARED.test(text) || LISTED.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
