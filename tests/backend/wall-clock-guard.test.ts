import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #105: no test is bound to wall-clock time. A busy machine stretches fixed
 * work, so a millisecond budget or a short wait fails with nothing wrong.
 * Linear-time checks go through tests/shared/linear-cost.ts (growth, by the
 * thread's CPU time), waits through tests/shared/timing.ts (WAIT_MS), and the
 * frontend's findBy and waitFor get WAIT_MS from tests/frontend/setup.ts.
 */
const TESTS = join(__dirname, "..");

const RULES: { pattern: RegExp; allowedIn: string; why: string }[] = [
  {
    pattern: /\bperformance\.now\(/,
    allowedIn: "shared/linear-cost.ts",
    why: "times work in milliseconds; use growth() from shared/linear-cost.ts",
  },
  {
    pattern: /expect\(\s*Date\.now\(\)/,
    allowedIn: "",
    why: "budgets wall-clock time; count the work instead",
  },
  {
    pattern: /\bvi\.waitFor\(/,
    allowedIn: "shared/timing.ts",
    why: "waits vi.waitFor's 1 s; use eventually() from shared/timing.ts",
  },
  {
    pattern: /\{\s*timeout:\s*\d/,
    allowedIn: "shared/timing.ts",
    why: "a findBy or waitFor with its own short timeout; WAIT_MS applies",
  },
  {
    pattern: /asyncUtilTimeout\s*:/,
    allowedIn: "frontend/setup.ts",
    why: "sets Testing Library's wait in one file; tests/frontend/setup.ts sets it",
  },
];

/** What a test file does that binds it to wall-clock time. */
function wallClockProblems(path: string, text: string): string[] {
  return RULES.filter(
    (rule) => path !== rule.allowedIn && rule.pattern.test(text),
  ).map((rule) => `${path}: ${rule.why}`);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const SELF = "backend/wall-clock-guard.test.ts";

describe("wall-clock guard (#105)", () => {
  it("no test budgets milliseconds or waits a short fixed time", () => {
    const problems = files(TESTS)
      .map((file) => relative(TESTS, file).replaceAll("\\", "/"))
      .filter((path) => path !== SELF)
      .flatMap((path) =>
        wallClockProblems(path, readFileSync(join(TESTS, path), "utf8")),
      );
    expect(problems).toEqual([]);
  });

  it("finds planted sites", () => {
    const planted = [
      "const started = performance.now();",
      "expect(Date.now() - started).toBeLessThan(2_000);",
      "await vi.waitFor(() => expect(x).toBe(1));",
      'await screen.findByRole("alertdialog", {}, { timeout: 200 });',
      "configure({ asyncUtilTimeout: 3000 });",
    ];
    for (const line of planted) {
      expect(
        wallClockProblems("views/Planted.test.tsx", line),
        line,
      ).toHaveLength(1);
    }
    expect(
      wallClockProblems(
        "views/Fine.test.tsx",
        "vi.setSystemTime(Date.now() + 60_000); await eventually(() => {});",
      ),
    ).toEqual([]);
  });
});
