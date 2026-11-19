import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import en from "../../locales/en.json";

/** Every value under a key ending in "Key" anywhere in the manifest. */
function keysIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      // enableKey names a host setting, not a string.
      if (
        key.endsWith("Key") &&
        key !== "enableKey" &&
        typeof inner === "string"
      ) {
        out.push(inner);
      } else keysIn(inner, out);
    }
  }
  return out;
}

function lookup(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
}

describe("locales", () => {
  it("has a string for every manifest locale key", () => {
    const missing = keysIn(manifest).filter(
      (key) => typeof lookup(key) !== "string",
    );
    expect(missing).toEqual([]);
  });
});
