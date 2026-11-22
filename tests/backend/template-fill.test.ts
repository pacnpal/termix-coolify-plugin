import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { fill } from "../../src/shared/template.js";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");
/** The one place a `{{key}}` template is filled. */
const FILLER = "src/shared/template.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** The literal text of the string or regex starting at `at`, or null. */
function literalAt(source: string, at: number): string | null {
  const open = source[at];
  if (open !== '"' && open !== "'" && open !== "`" && open !== "/") {
    return null;
  }
  let inClass = false;
  for (let i = at + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (open === "/") {
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) return source.slice(at + 1, i);
      else if (c === "\n") return null;
    } else if (c === open) {
      return source.slice(at + 1, i);
    }
  }
  return null;
}

/**
 * Lines with a `.replace(...)` or `.replaceAll(...)` whose pattern is a
 * string or regex literal for a `{{` placeholder. Filling one that way
 * expands `$&`, `$1` and `$$` in the value, and chained calls fill
 * placeholders that came in with an earlier value; `fill` does neither.
 */
function placeholderReplaces(source: string): number[] {
  const lines: number[] = [];
  for (const match of source.matchAll(/\.replace(?:All)?\(\s*/g)) {
    const at = match.index + match[0].length;
    const literal = literalAt(source, at);
    if (literal?.replace(/\\/g, "").includes("{{")) {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

describe("fill", () => {
  it("fills every placeholder in one pass", () => {
    expect(fill("{{a}} and {{b}} and {{a}}", { a: "x", b: 2 })).toBe(
      "x and 2 and x",
    );
  });

  it("keeps $ patterns in a value as they are", () => {
    expect(fill("<{{a}}>", { a: "$& $1 $$ $` $'" })).toBe("<$& $1 $$ $` $'>");
  });

  it("never reads an inserted value again", () => {
    expect(fill("{{a}} {{b}}", { a: "{{b}}", b: "{{a}}" })).toBe("{{b}} {{a}}");
  });

  it("leaves a placeholder it has no value for", () => {
    expect(fill("{{a}} {{toString}}", {})).toBe("{{a}} {{toString}}");
  });
});

describe("placeholder guard", () => {
  it("finds every way of filling a placeholder by hand", () => {
    const planted = [
      'en.x.replace("{{name}}", name)',
      "en.x.replace('{{name}}', name)",
      "en.x.replace(`{{name}}`, name)",
      'en.x.replaceAll("{{name}}", name)',
      'en.x\n  .replace("{{a}}", a)\n  .replace(\n    "{{b}}",\n    b,\n  )',
      "t.replace(/\\{\\{(\\w+)\\}\\}/g, (_m, k) => v[k])",
      "t.replace(/{{name}}/, name)",
    ].join("\n");
    expect(placeholderReplaces(planted)).toEqual([1, 2, 3, 4, 6, 7, 11, 12]);
  });

  it("leaves other replaces alone", () => {
    const fine = [
      'path.replace(/\\/+$/, "")',
      'id.replace(/-/g, "")',
      's.replace(/[.+?^${}()|[\\]\\\\]/g, "\\\\$&")',
      'fmt = "{{json .}}"; s.replace(/x/, "y")',
      "tpl.replace(/\\{(\\w+)\\}/g, (_, n) => n)",
    ].join("\n");
    expect(placeholderReplaces(fine)).toEqual([]);
  });

  it("only the shared filler fills a placeholder in src/", () => {
    const found = sourceFiles(SRC).flatMap((file) => {
      const path = relative(ROOT, file).split("\\").join("/");
      if (path === FILLER) return [];
      return placeholderReplaces(readFileSync(file, "utf8")).map(
        (line) => `${path}:${line}`,
      );
    });
    expect(found).toEqual([]);
  });
});
