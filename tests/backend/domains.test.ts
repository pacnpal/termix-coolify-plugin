import { describe, expect, it } from "vitest";
import {
  checkDomains,
  isHostname,
  withPortOverride,
  withoutTrailingSlashes,
} from "../../src/shared/domains.js";
import { growth, LINEAR_GROWTH } from "../shared/linear-cost.js";
import { HEAVY_TEST_MS } from "../shared/timing.js";

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

  // Fixed work: growth() samples both sizes for a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "drops trailing slashes from a long path quickly",
    () => {
      expect(withoutTrailingSlashes("/api///")).toBe("/api");
      expect(withoutTrailingSlashes("/")).toBe("");
      expect(withoutTrailingSlashes("/a/b")).toBe("/a/b");
      const inputs = (scale: number) => [
        `${"/".repeat(100_000 * scale)}x`,
        `/a${"/".repeat(100_000 * scale)}`,
      ];
      const [hostile, trailing] = inputs(1);
      expect(withoutTrailingSlashes(hostile)).toBe(hostile);
      expect(withoutTrailingSlashes(trailing)).toBe("/a");
      // Growth, not milliseconds: load can't fail it (#105).
      const grew = growth((scale) => {
        const texts = inputs(scale);
        return () => texts.map((text) => withoutTrailingSlashes(text));
      });
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );

  // Fixed work: growth() samples both sizes for a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "answers hostile input quickly",
    () => {
      const inputs = (scale: number) => [
        `a${"-".repeat(100_000 * scale)}!`,
        `${"a".repeat(100_000 * scale)}!`,
        `${"a-".repeat(50_000 * scale)}.`,
        `${"a.".repeat(50_000 * scale)}!`,
        `${`a${"-".repeat(61)}a.`.repeat(4)}${"-".repeat(64)}!`,
      ];
      for (const text of inputs(1)) expect(isHostname(text)).toBe(false);
      // Growth, not milliseconds: load can't fail it (#105).
      const grew = growth((scale) => {
        const texts = inputs(scale);
        return () => texts.map((text) => isHostname(text));
      });
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
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

  it("keeps every port given, a scheme's default one included", () => {
    // Coolify reads a port as an internal routing override, so dropping
    // :80 or :443 would change what it does.
    const value = (text: string) => {
      const checked = checkDomains(text);
      return "reason" in checked ? checked.reason : checked.value;
    };
    expect(value("http://a.example.test:80")).toBe("http://a.example.test:80");
    expect(value("https://a.example.test:443")).toBe(
      "https://a.example.test:443",
    );
    expect(value("https://A.example.test:0443/api/")).toBe(
      "https://a.example.test:443/api",
    );
    expect(value("https://a.example.test:3000")).toBe(
      "https://a.example.test:3000",
    );
    expect(value("http://a.example.test:443")).toBe(
      "http://a.example.test:443",
    );
    expect(value("https://a.example.test")).toBe("https://a.example.test");
    expect(value("https://a.example.test:")).toBe("https://a.example.test");
    // With and without a port, they are two different domains to Coolify.
    expect(value("https://a.example.test,https://a.example.test:443")).toBe(
      "https://a.example.test,https://a.example.test:443",
    );
  });

  it("puts Coolify's port overrides back on its portless domains", () => {
    const overrides = {
      "https://a.example.test": 3000,
      "https://b.example.test/api": 8080,
    };
    expect(withPortOverride("https://a.example.test", overrides)).toBe(
      "https://a.example.test:3000",
    );
    expect(withPortOverride("https://b.example.test/api", overrides)).toBe(
      "https://b.example.test:8080/api",
    );
    expect(withPortOverride("https://c.example.test", overrides)).toBe(
      "https://c.example.test",
    );
    // A domain that names its own port keeps it.
    expect(withPortOverride("https://a.example.test:4000", overrides)).toBe(
      "https://a.example.test:4000",
    );
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
