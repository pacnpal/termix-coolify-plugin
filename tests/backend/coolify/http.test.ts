import { describe, expect, it } from "vitest";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import {
  CoolifyError,
  createCoolifyHttp,
  toRouteError,
  type CoolifyTarget,
} from "../../../src/backend/coolify/http.js";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";

const TOKEN = "fake-token-for-tests-only";

const target: CoolifyTarget = {
  baseUrl: "https://coolify.example.test",
  token: TOKEN,
  cfAccess: { id: "fake-cf-id", secret: "fake-cf-secret" },
  allowPrivate: false,
  caCert: null,
};

interface Call {
  url: string;
  init: PluginFetchInit | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake fetch that answers each call with the next response in the list. */
function scripted(...responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: PluginFetchInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next();
  };
  return { fetch, calls };
}

const noSleep = { sleep: async () => {} };

async function caught(promise: Promise<unknown>): Promise<CoolifyError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CoolifyError) return err;
    throw err;
  }
  throw new Error("expected a CoolifyError");
}

describe("Coolify HTTP layer", () => {
  it("sends bearer and CF access headers", async () => {
    const fake = scripted(() => json(200, []));
    const http = createCoolifyHttp(fake.fetch, target, noSleep);
    await http.request("GET", "/servers");
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.url).toBe("https://coolify.example.test/api/v1/servers");
    expect(call.init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "cf-access-client-id": "fake-cf-id",
      "cf-access-client-secret": "fake-cf-secret",
    });
  });

  it("passes allowPrivateHosts only when allowed, and the CA when set", async () => {
    const fake = scripted(() => json(200, []));
    await createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/x");
    expect(fake.calls[0].init?.allowPrivateHosts).toBeUndefined();
    expect(fake.calls[0].init?.tls).toBeUndefined();

    const local = scripted(() => json(200, []));
    await createCoolifyHttp(
      local.fetch,
      {
        ...target,
        baseUrl: "http://192.168.1.10:8000/",
        allowPrivate: true,
        caCert: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
      },
      noSleep,
    ).request("GET", "/x");
    expect(local.calls[0].url).toBe("http://192.168.1.10:8000/api/v1/x");
    expect(local.calls[0].init?.allowPrivateHosts).toEqual(["192.168.1.10"]);
    expect(local.calls[0].init?.tls?.ca).toContain("BEGIN CERTIFICATE");
  });

  it("maps 401 to unauthorized", async () => {
    const fake = scripted(() => json(401, { message: "Unauthenticated." }));
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/team"),
    );
    expect(err.cause).toBe("unauthorized");
    expect(err.status).toBe(401);
  });

  it('maps 403 "API is disabled." to api-disabled', async () => {
    const fake = scripted(() => json(403, { message: "API is disabled." }));
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/team"),
    );
    expect(err.cause).toBe("api-disabled");
  });

  it("maps any other 403 to forbidden-ability", async () => {
    const fake = scripted(() => json(403, { message: "Missing ability." }));
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/team"),
    );
    expect(err.cause).toBe("forbidden-ability");
  });

  it("toRouteError answers 409 for unsupported-by-instance and unsupported-version, and 502 for upstream", () => {
    expect(
      toRouteError(new CoolifyError("unsupported-by-instance", 405, "x"))
        .status,
    ).toBe(409);
    expect(
      toRouteError(new CoolifyError("unsupported-version", 0, "x")).status,
    ).toBe(409);
    expect(toRouteError(new CoolifyError("upstream", 500, "x")).status).toBe(
      502,
    );
    expect(toRouteError(new CoolifyError("validation", 422, "x")).status).toBe(
      422,
    );
    expect(toRouteError(new CoolifyError("not-found", 404, "x")).status).toBe(
      404,
    );
    expect(
      toRouteError(new CoolifyError("rate-limited", 429, "x")).status,
    ).toBe(429);
    expect(
      toRouteError(new CoolifyError("unauthorized", 401, "x")).status,
    ).toBe(502);
    expect(toRouteError(new Error("boom"))).toEqual({
      status: 502,
      body: { error: expect.any(String), cause: "upstream" },
    });
  });

  it("maps a 302 to *.cloudflareaccess.com to access-redirect", async () => {
    const fake = scripted(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/coolify.example.test",
          },
        }),
    );
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/servers"),
    );
    expect(fake.calls[0].init?.redirect).toBe("manual");
    expect(err.cause).toBe("access-redirect");
  });

  it("maps any other redirect to not-coolify", async () => {
    const fake = scripted(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://elsewhere.example.test/login" },
        }),
    );
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/servers"),
    );
    expect(err.cause).toBe("not-coolify");
  });

  it("maps a 200 text/html body to not-coolify", async () => {
    const fake = scripted(
      () =>
        new Response("<!doctype html><html><body>Sign in</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/servers"),
    );
    expect(err.cause).toBe("not-coolify");
  });

  it("maps a JSON content type with a body that does not parse to not-coolify", async () => {
    const fake = scripted(
      () =>
        new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request("GET", "/servers"),
    );
    expect(err.cause).toBe("not-coolify");
  });

  it("reads a plain text answer when asked, but still refuses an HTML page", async () => {
    const ok = scripted(
      () =>
        new Response("v4.7.5", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const version = await createCoolifyHttp(
      ok.fetch,
      target,
      noSleep,
    ).request<string>("GET", "/version", { text: true });
    expect(version).toBe("v4.7.5");

    const page = scripted(
      () =>
        new Response("<!DOCTYPE html><title>502</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const err = await caught(
      createCoolifyHttp(page.fetch, target, noSleep).request(
        "GET",
        "/version",
        {
          text: true,
        },
      ),
    );
    expect(err.cause).toBe("not-coolify");
  });

  it("maps a network failure to unreachable", async () => {
    const fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND coolify.example.test");
    };
    const err = await caught(
      createCoolifyHttp(fetch, target, noSleep).request("GET", "/servers"),
    );
    expect(err.cause).toBe("unreachable");
  });

  it("maps 422 errors to fields", async () => {
    const fake = scripted(() =>
      json(422, {
        message: "Validation failed.",
        errors: { name: ["The name field is required."], port: "Bad port" },
      }),
    );
    const err = await caught(
      createCoolifyHttp(fake.fetch, target, noSleep).request(
        "POST",
        "/projects",
        { body: {} },
      ),
    );
    expect(err.cause).toBe("validation");
    expect(err.fields).toEqual({
      name: ["The name field is required."],
      port: ["Bad port"],
    });
    expect(toRouteError(err).status).toBe(422);
  });

  it("maps 404 to not-found and 405 to unsupported-by-instance", async () => {
    const missing = scripted(() => json(404, { message: "Not found." }));
    expect(
      (
        await caught(
          createCoolifyHttp(missing.fetch, target, noSleep).request(
            "GET",
            "/servers/x",
          ),
        )
      ).cause,
    ).toBe("not-found");
    const method = scripted(() => json(405, { message: "Method not allowed" }));
    expect(
      (
        await caught(
          createCoolifyHttp(method.fetch, target, noSleep).request(
            "POST",
            "/x",
          ),
        )
      ).cause,
    ).toBe("unsupported-by-instance");
  });

  it("retries GET on 429 and 503 but never POST", async () => {
    const get = scripted(
      () => json(429, { message: "Too Many Attempts." }),
      () => json(503, { message: "busy" }),
      () => json(200, { ok: true }),
    );
    const result = await createCoolifyHttp(get.fetch, target, noSleep).request(
      "GET",
      "/servers",
    );
    expect(result).toEqual({ ok: true });
    expect(get.calls).toHaveLength(3);

    const post = scripted(() => json(503, { message: "busy" }));
    const err = await caught(
      createCoolifyHttp(post.fetch, target, noSleep).request("POST", "/deploy"),
    );
    expect(err.cause).toBe("upstream");
    expect(post.calls).toHaveLength(1);

    const limited = scripted(() =>
      json(429, { message: "Too Many Attempts." }),
    );
    const gaveUp = await caught(
      createCoolifyHttp(limited.fetch, target, noSleep).request("GET", "/x"),
    );
    expect(gaveUp.cause).toBe("rate-limited");
    expect(limited.calls).toHaveLength(3);

    const once = scripted(() => json(503, {}));
    await caught(
      createCoolifyHttp(once.fetch, target, noSleep).request("GET", "/x", {
        retry: false,
      }),
    );
    expect(once.calls).toHaveLength(1);
  });

  it("holds requests to perMinute (default 150, under Coolify's 200)", async () => {
    let clock = 0;
    const slept: number[] = [];
    const fake = scripted(() => json(200, {}));
    const http = createCoolifyHttp(fake.fetch, target, {
      perMinute: 3,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 4; i++) await http.request("GET", "/x");
    expect(fake.calls).toHaveLength(4);
    expect(slept).toEqual([60_000]);

    clock = 0;
    const defaults: number[] = [];
    const many = scripted(() => json(200, {}));
    const budget = createCoolifyHttp(many.fetch, target, {
      now: () => clock,
      sleep: async (ms) => {
        defaults.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 150; i++) await budget.request("GET", "/x");
    expect(defaults).toEqual([]);
    await budget.request("GET", "/x");
    expect(defaults).toHaveLength(1);
  });

  it("adds query parameters and sends a JSON body", async () => {
    const fake = scripted(() => json(200, {}));
    await createCoolifyHttp(fake.fetch, target, noSleep).request(
      "POST",
      "/deploy",
      { query: { uuid: "abc", force: true, skip: undefined }, body: { a: 1 } },
    );
    expect(fake.calls[0].url).toBe(
      "https://coolify.example.test/api/v1/deploy?uuid=abc&force=true",
    );
    expect(fake.calls[0].init?.method).toBe("POST");
    expect(fake.calls[0].init?.body).toBe('{"a":1}');
    expect(fake.calls[0].init?.headers).toMatchObject({
      "content-type": "application/json",
    });
  });

  it("toRouteError never includes the token", async () => {
    const causes = [
      () => json(401, { message: `bad token ${TOKEN}` }),
      () => json(403, { message: `nope ${TOKEN}` }),
      () => json(422, { message: TOKEN, errors: { token: [TOKEN] } }),
      () => json(500, { message: `server error ${TOKEN}` }),
      () =>
        new Response(`<html>${TOKEN}</html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ];
    for (const respond of causes) {
      const fake = scripted(respond);
      const err = await caught(
        createCoolifyHttp(fake.fetch, target, noSleep).request("POST", "/x"),
      );
      const result = toRouteError(err);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(String(err.message)).not.toContain(TOKEN);
    }
    const thrown = toRouteError(new Error(`failed with ${TOKEN}`));
    expect(JSON.stringify(thrown)).not.toContain(TOKEN);
  });
});

describe("path normalisation guard", () => {
  it("http layer refuses a URL whose normalised path differs", async () => {
    for (const path of [
      "/projects/../deployments",
      "/projects/x/..",
      "/applications/%2e%2e/logs",
      "/applications/./envs",
      "/servers/a\\..\\settings",
    ]) {
      const fake = scripted(() => json(200, []));
      const http = createCoolifyHttp(fake.fetch, target, noSleep);
      const err = await caught(http.request("GET", path));
      expect(err.cause, path).toBe("validation");
      expect(fake.calls, path).toEqual([]);
    }
  });

  it("a typed api.ts call with a dot-segment uuid is refused before any request", async () => {
    for (const uuid of ["..", ".", "a/b", "%2e%2e", "...", "a\\b"]) {
      const fake = scripted(() => json(200, {}));
      const api = createCoolifyApi(
        createCoolifyHttp(fake.fetch, target, noSleep),
      );
      const err = await caught(api.server(uuid));
      expect(err.cause, uuid).toBe("validation");
      expect(fake.calls, uuid).toEqual([]);
    }
  });

  it("a plain path still goes through", async () => {
    const fake = scripted(() => json(200, { uuid: "abc123" }));
    const api = createCoolifyApi(
      createCoolifyHttp(fake.fetch, target, noSleep),
    );
    await api.server("abc123");
    expect(fake.calls[0].url).toBe(
      "https://coolify.example.test/api/v1/servers/abc123",
    );
  });
});
