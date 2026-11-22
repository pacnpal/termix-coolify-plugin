import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #86: every confirm in the frontend goes through src/frontend/confirm.ts,
 * whose answer is false once the view went away or moved to another target.
 * A source scan, so a new site that asks the SDK directly fails here.
 */

const ROOT = join(__dirname, "../../src/frontend");
const HELPER = "confirm.ts";

/** What a file does wrong with confirms; empty when it uses the helper. */
function confirmProblems(path: string, text: string): string[] {
  if (path === HELPER) return [];
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const problems: string[] = [];
  if (/\buseConfirm\b/.test(code)) {
    problems.push(`${path}: useConfirm from the SDK; use useConfirmFor`);
  }
  if (/\.confirm\s*\(/.test(code)) {
    problems.push(`${path}: calls .confirm( directly; use confirm.ts`);
  }
  if (/(?<![\w.$])confirm\s*\(/.test(code)) {
    const bound =
      /\{[^}]*\bconfirm\b[^}]*\}\s*=\s*useConfirmFor\s*\(/.test(code) ||
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
