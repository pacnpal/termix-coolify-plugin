import { describe, expect, it } from "vitest";
import { trimTrailing } from "../../src/backend/text.js";

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

  it("stays linear on a long run that isn't at the end", () => {
    const value = `a${"/".repeat(200_000)}b`;
    const started = performance.now();
    expect(trimTrailing(value, "/")).toBe(value);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("takes exactly one character", () => {
    expect(() => trimTrailing("a", "//")).toThrow();
  });
});
