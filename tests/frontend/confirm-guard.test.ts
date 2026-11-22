import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { growth, LINEAR_GROWTH } from "../shared/linear-cost.js";
import { HEAVY_TEST_MS } from "../shared/timing.js";

/**
 * #86: every confirm in the frontend goes through src/frontend/confirm.ts,
 * whose answer is false once the view went away or moved to another target.
 * A source scan, so a new site that asks the SDK directly fails here.
 */

const ROOT = join(__dirname, "../../src/frontend");
const HELPER = "confirm.ts";

/**
 * `text` without its block comments, each `/*` to the next star-slash, as
 * `/\/\*[\s\S]*?\*\//g` removed them, by index scans: that pattern rescanned
 * the rest of the text from every unclosed `/*`.
 */
function withoutBlockComments(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("/*", from);
    if (open < 0) break;
    const close = text.indexOf("*/", open + 2);
    if (close < 0) break;
    out += text.slice(from, open);
    from = close + 2;
  }
  return out + text.slice(from);
}

const SPACE = /\s*/y;

/** Where the whitespace run starting at `at` ends. */
function pastSpace(code: string, at: number): number {
  SPACE.lastIndex = at;
  SPACE.test(code);
  return SPACE.lastIndex;
}

/** `\s*=\s*useConfirmFor\s*\(` starting exactly at `at`. */
function boundTailAt(code: string, at: number): boolean {
  let i = pastSpace(code, at);
  if (code[i] !== "=") return false;
  i = pastSpace(code, i + 1);
  if (!code.startsWith("useConfirmFor", i)) return false;
  return code[pastSpace(code, i + "useConfirmFor".length)] === "(";
}

/**
 * A `{ ... confirm ... } = useConfirmFor(` destructuring, as
 * `/\{[^}]*\bconfirm\b[^}]*\}\s*=\s*useConfirmFor\s*\(/` found it. Each
 * brace group is read once, from the first `{` after the last `}` to the
 * next `}`: a later `{` in the same group only sees less of it.
 */
function destructuresConfirm(code: string): boolean {
  for (let open = code.indexOf("{"); open >= 0;) {
    const close = code.indexOf("}", open + 1);
    if (close < 0) return false;
    if (/\bconfirm\b/.test(code.slice(open + 1, close))) {
      if (boundTailAt(code, close + 1)) return true;
    }
    open = code.indexOf("{", close + 1);
  }
  return false;
}

/** What a file does wrong with confirms; empty when it uses the helper. */
function confirmProblems(path: string, text: string): string[] {
  if (path === HELPER) return [];
  const code = withoutBlockComments(text).replace(/(^|[^:])\/\/.*$/gm, "$1");
  const problems: string[] = [];
  if (/\buseConfirm\b/.test(code)) {
    problems.push(`${path}: useConfirm from the SDK; use useConfirmFor`);
  }
  if (/\.confirm\s*\(/.test(code)) {
    problems.push(`${path}: calls .confirm( directly; use confirm.ts`);
  }
  if (/(?<![\w.$])confirm\s*\(/.test(code)) {
    const bound =
      destructuresConfirm(code) ||
      /\bconfirm\s*=\s*useConfirmFor\s*\(/.test(code);
    if (!bound) {
      problems.push(`${path}: calls confirm( not bound from useConfirmFor`);
    }
  }
  return problems;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("confirm guard (#86)", () => {
  it("no frontend confirm skips useConfirmFor", () => {
    const problems = sources(ROOT).flatMap((file) =>
      confirmProblems(
        relative(ROOT, file).replaceAll("\\", "/"),
        readFileSync(file, "utf8"),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("finds a planted site that asks the SDK directly", () => {
    const planted = [
      'import { useConfirm } from "@termix-ssh/plugin-sdk/ui";',
      "const confirm = useConfirm();",
      "async function go() { const ok = await confirm({ title: 'x' }); }",
    ].join("\n");
    expect(confirmProblems("views/Planted.tsx", planted)).toHaveLength(2);
    expect(
      confirmProblems(
        "index.tsx",
        "void (async () => { await app.confirm({ title: 'x' }); })();",
      ),
    ).toHaveLength(1);
    expect(
      confirmProblems("views/Window.tsx", "if (window.confirm('x')) remove();"),
    ).toHaveLength(1);
  });

  it("accepts a site bound to the helper", () => {
    const fine = [
      'import { useConfirmFor } from "../confirm";',
      "const { confirm, still } = useConfirmFor(target);",
      "async function go() { const ok = await confirm({ title: 'x' }); }",
    ].join("\n");
    expect(confirmProblems("views/Fine.tsx", fine)).toEqual([]);
  });
});

describe("confirm guard scan", () => {
  // Growth, not milliseconds: load can't fail it (#105).
  function grows(hostile: (scale: number) => string): number {
    return growth((scale) => {
      const code = hostile(scale);
      return () => confirmProblems("views/Hostile.tsx", code);
    });
  }

  // Fixed work: growth() samples each size for 25 clock steps, a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on many unclosed block comments",
    () => {
      expect(grows((scale) => "/* ".repeat(40_000 * scale))).toBeLessThan(
        LINEAR_GROWTH,
      );
    },
    HEAVY_TEST_MS,
  );

  // Fixed work: growth() samples each size for 25 clock steps, a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on many braces before an unbound confirm(",
    () => {
      const hostile = (scale: number) =>
        "r({".repeat(600 * scale) + "r(confirm(".repeat(600 * scale);
      expect(grows(hostile)).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
});
