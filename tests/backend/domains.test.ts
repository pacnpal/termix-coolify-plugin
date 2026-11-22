import { describe, expect, it } from "vitest";
import {
  checkDomains,
  isHostname,
  withoutTrailingSlashes,
} from "../../src/shared/domains.js";

describe("isHostname", () => {
  it("accepts and refuses the cases DNS records and domains rely on", () => {
    for (const ok of [
      "example.com",
      "a.bc",
      "pr-42.example.test",
      "xn--bcher-kva.example",
      "a.b.c.d.e.example",
      "1.example.com",
      "example.-a",
      `${"a".repeat(63)}.com`,
      `${"a".repeat(61)}.${"b".repeat(61)}.${"c".repeat(61)}.${"d".repeat(61)}.com`,
    ]) {
      expect(isHostname(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "localhost",
      "a.b",
      "-a.example",
      "a-.example",
      "a..example",
      ".example.com",
      "example.com.",
      "Example.com",
      "exa_mple.com",
      "203.0.113.5",
      `${"a".repeat(64)}.com`,
      `example.${"a".repeat(64)}`,
      `${"a.".repeat(126)}ab`,
      "example.com\n",
    ]) {
      expect(isHostname(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("drops trailing slashes from a long path quickly", () => {
    expect(withoutTrailingSlashes("/api///")).toBe("/api");
    expect(withoutTrailingSlashes("/")).toBe("");
    expect(withoutTrailingSlashes("/a/b")).toBe("/a/b");
    const hostile = `${"/".repeat(100_000)}x`;
    const started = performance.now();
    expect(withoutTrailingSlashes(hostile)).toBe(hostile);
    expect(withoutTrailingSlashes(`/a${"/".repeat(100_000)}`)).toBe("/a");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("answers hostile input quickly", () => {
    const hostile = [
      `a${"-".repeat(100_000)}!`,
      `${"a".repeat(100_000)}!`,
      `${"a-".repeat(50_000)}.`,
      `${"a.".repeat(50_000)}!`,
      `${`a${"-".repeat(61)}a.`.repeat(4)}${"-".repeat(64)}!`,
    ];
    const started = performance.now();
    for (const text of hostile) expect(isHostname(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("checkDomains", () => {
  it("accepts http and https URLs with a port or path, normalized", () => {
    expect(
      checkDomains(
        " https://PR-1.Example.test:3000 ,http://a.example.test/api/ ",
      ),
    ).toEqual({
      ok: true,
      domains: ["https://pr-1.example.test:3000", "http://a.example.test/api"],
      value: "https://pr-1.example.test:3000,http://a.example.test/api",
    });
  });

  it("names what is wrong with a bad list", () => {
    const reason = (text: string) => {
      const checked = checkDomains(text);
      return "reason" in checked ? checked.reason : "ok";
    };
    expect(reason("")).toBe("empty");
    expect(reason(" , ")).toBe("empty");
    expect(reason("pr.example.test")).toBe("scheme");
    expect(reason("ftp://pr.example.test")).toBe("scheme");
    expect(reason("https://u:p@pr.example.test")).toBe("credentials");
    expect(reason("https://pr.example.test/?a=1")).toBe("query");
    expect(reason("https://pr.example.test#x")).toBe("query");
    expect(reason("https://pr .example.test")).toBe("not-url");
    expect(reason("https://localhost")).toBe("host");
    expect(reason("https://203.0.113.5")).toBe("host");
    expect(reason("https://-a-.example.test")).toBe("host");
    expect(reason("https://a.example.test,https://A.example.test")).toBe(
      "duplicate",
    );
    expect(
      reason(
        Array.from({ length: 21 }, (_, i) => `https://p${i}.example.test`).join(
          ",",
        ),
      ),
    ).toBe("too-many");
    expect(reason(`https://${"a".repeat(3000)}.test`)).toBe("too-long");
  });
});
