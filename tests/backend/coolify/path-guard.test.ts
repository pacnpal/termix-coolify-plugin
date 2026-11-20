import { describe, expect, it } from "vitest";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";
import {
  CoolifyError,
  createCoolifyHttp,
  type CoolifyTarget,
} from "../../../src/backend/coolify/http.js";

const target: CoolifyTarget = {
  baseUrl: "https://coolify.example.test",
  token: "fake-token-for-tests-only",
  cfAccess: null,
  allowPrivate: false,
  caCert: null,
};

const noSleep = { sleep: async () => {} };

/** A fake fetch that answers every call with `body` and records the URLs. */
function recording(body: unknown) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CoolifyError) return err.cause;
    throw err;
  }
  throw new Error("expected a CoolifyError");
}

describe("secret scrub", () => {
  const withAccess: CoolifyTarget = {
    ...target,
    cfAccess: { id: "fake-cf-id", secret: "fake-cf-secret-value" },
  };

  it("replaces any answer string that holds the token or Access secret", async () => {
    const fake = recording({
      note: `echo ${target.token}`,
      nested: [{ v: "fake-cf-secret-value" }, "plain"],
    });
    const http = createCoolifyHttp(fake.fetch, withAccess, noSleep);
    const answer = await http.request("GET", "/servers", {
      scrubSecrets: true,
    });
    expect(JSON.stringify(answer)).not.toContain(target.token);
    expect(JSON.stringify(answer)).not.toContain("fake-cf-secret-value");
    expect(answer).toEqual({
      note: "[redacted]",
      nested: [{ v: "[redacted]" }, "plain"],
    });
  });

  it("leaves the answer as sent without the option", async () => {
    const fake = recording({ note: target.token });
    const http = createCoolifyHttp(fake.fetch, target, noSleep);
    expect(await http.request("GET", "/servers")).toEqual({
      note: target.token,
    });
  });
});

describe("path normalisation guard", () => {
  it.each([
    "/projects/../deployments",
    "/projects/x/..",
    "/applications/%2e%2e/logs",
    "/applications/./envs",
    "/servers/a\\..\\settings",
  ])(
    "http layer refuses a URL whose normalised path differs: %s",
    async (path) => {
      const fake = recording([]);
      const http = createCoolifyHttp(fake.fetch, target, noSleep);
      expect(await causeOf(http.request("GET", path))).toBe("validation");
      expect(fake.calls).toEqual([]);
    },
  );

  it.each(["..", ".", "a/b", "%2e%2e", "...", "a\\b"])(
    "a typed api.ts call with uuid %s is refused before any request",
    async (uuid) => {
      const fake = recording({});
      const api = createCoolifyApi(
        createCoolifyHttp(fake.fetch, target, noSleep),
      );
      expect(await causeOf(api.server(uuid))).toBe("validation");
      expect(fake.calls).toEqual([]);
    },
  );

  it("a plain path still goes through", async () => {
    const fake = recording({ uuid: "abc123" });
    const api = createCoolifyApi(
      createCoolifyHttp(fake.fetch, target, noSleep),
    );
    await api.server("abc123");
    expect(fake.calls[0]).toBe(
      "https://coolify.example.test/api/v1/servers/abc123",
    );
  });
});
