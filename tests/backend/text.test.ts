import { describe, expect, it } from "vitest";
import { trimTrailing } from "../../src/backend/text.js";
import { growth, LINEAR_GROWTH } from "../shared/linear-cost.js";
import { HEAVY_TEST_MS } from "../shared/timing.js";

describe("trimTrailing", () => {
  it("removes every trailing copy of the character", () => {
    expect(trimTrailing("https://x.test/api///", "/")).toBe(
      "https://x.test/api",
    );
    expect(trimTrailing("abc==", "=")).toBe("abc");
    expect(trimTrailing("abc", "/")).toBe("abc");
    expect(trimTrailing("///", "/")).toBe("");
    expect(trimTrailing("", "/")).toBe("");
  });

  it("keeps the character where it isn't at the end", () => {
    expect(trimTrailing("a//b/", "/")).toBe("a//b");
  });

  // Fixed work: growth() samples both sizes for a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on a long run that isn't at the end",
    () => {
      const hostile = (scale: number) => `a${"/".repeat(200_000 * scale)}b`;
      const value = hostile(1);
      expect(trimTrailing(value, "/")).toBe(value);
      // Growth, not milliseconds: load can't fail it (#105).
      const grew = growth((scale) => {
        const input = hostile(scale);
        return () => trimTrailing(input, "/");
      });
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );

  it("takes exactly one character", () => {
    expect(() => trimTrailing("a", "//")).toThrow();
  });
});
