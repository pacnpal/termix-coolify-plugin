import { describe, expect, it } from "vitest";
import { checkDomains } from "../../src/shared/domains.js";

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
