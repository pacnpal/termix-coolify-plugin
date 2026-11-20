import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HANDOFF_TTL_MS,
  hashToken,
  newToken,
  stashOnceUrl,
  takeOnceUrl,
  tokenMatches,
} from "../../../src/backend/status/service.js";

const URL_A = "https://termix.test/plugin-api/coolify/status/fake-token-a";
const URL_B = "https://termix.test/plugin-api/coolify/status/fake-token-b";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("status page tokens", () => {
  it("are 32 random bytes in base64url, and only their sha256 is kept", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(newToken()).not.toBe(token);
    expect(hashToken(token)).toBe(
      crypto.createHash("sha256").update(token).digest("hex"),
    );
  });

  it("token compared in constant time", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    const token = newToken();
    expect(tokenMatches(hashToken(token), token)).toBe(true);
    expect(tokenMatches(hashToken(token), newToken())).toBe(false);
    expect(tokenMatches("not-hex", token)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("one-time URL handoff", () => {
  it("hands the URL over once, to the same user and handoff id only", () => {
    stashOnceUrl("user-a", "run-1", URL_A);
    expect(takeOnceUrl("user-b", "run-1")).toBeNull();
    expect(takeOnceUrl("user-a", "run-2")).toBeNull();
    expect(takeOnceUrl("user-a", "run-1")).toBe(URL_A);
    expect(takeOnceUrl("user-a", "run-1")).toBeNull();
  });

  it("keeps two runs apart", () => {
    stashOnceUrl("user-a", "run-x", URL_A);
    stashOnceUrl("user-a", "run-y", URL_B);
    expect(takeOnceUrl("user-a", "run-y")).toBe(URL_B);
    expect(takeOnceUrl("user-a", "run-x")).toBe(URL_A);
  });

  it("forgets an entry after 5 minutes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start);
    stashOnceUrl("user-a", "run-old", URL_A);
    stashOnceUrl("user-a", "run-edge", URL_B);
    vi.setSystemTime(start + HANDOFF_TTL_MS - 1);
    expect(takeOnceUrl("user-a", "run-edge")).toBe(URL_B);
    vi.setSystemTime(start + HANDOFF_TTL_MS + 1);
    expect(takeOnceUrl("user-a", "run-old")).toBeNull();
    expect(HANDOFF_TTL_MS).toBe(5 * 60_000);
  });

  it("refuses an empty user or handoff id", () => {
    stashOnceUrl("", "run-e", URL_A);
    expect(takeOnceUrl("", "run-e")).toBeNull();
    stashOnceUrl("user-a", "", URL_A);
    expect(takeOnceUrl("user-a", "")).toBeNull();
  });
});
