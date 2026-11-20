import { describe, expect, it } from "vitest";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";
import { createCoolifyHttp } from "../../../src/backend/coolify/http.js";
import { runProbe } from "../../../src/backend/connections/probe.js";
import {
  fakeCoolify,
  healthyCoolify,
  type FakeAnswer,
} from "../helpers/fake-coolify.js";

const TOKEN = "fake-token-probe";

function probeWith(fake: ReturnType<typeof fakeCoolify>) {
  const http = createCoolifyHttp(
    fake.fetch,
    {
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
      cfAccess: null,
      allowPrivate: false,
      caCert: null,
    },
    { sleep: async () => {} },
  );
  return runProbe(createCoolifyApi(http), http);
}

const forbidden: FakeAnswer = { status: 403, json: { message: "Forbidden." } };

function step(result: Awaited<ReturnType<typeof runProbe>>, id: string) {
  return result.steps.find((s) => s.id === id);
}

describe("ability probe", () => {
  it("reads version, team, keys, logs and root on a healthy unscoped token", async () => {
    const result = await probeWith(healthyCoolify());
    expect(result).toMatchObject({
      ok: true,
      version: "v4.7.5",
      teamName: "Ops team",
      teamId: "7",
      scoped: false,
      abilities: {
        read: true,
        sensitive: true,
        keys: true,
        root: false,
        mcp: false,
      },
    });
    expect(result.steps.map((s) => s.id)).toEqual([
      "health",
      "version",
      "team",
      "keys",
      "logs",
      "settings",
    ]);
    expect(step(result, "settings")).toEqual({
      id: "settings",
      ok: false,
      cause: "forbidden-ability",
    });
  });

  it("probe treats 403 on /team as scoped and reads team id from projects", async () => {
    const fake = healthyCoolify({
      "GET /team": forbidden,
      "GET /security/keys": forbidden,
      "GET /projects": {
        json: [{ id: 4, uuid: "p1", name: "Shop", team_id: 12 }],
      },
    });
    const result = await probeWith(fake);
    expect(result.ok).toBe(true);
    expect(result.scoped).toBe(true);
    expect(result.teamId).toBe("12");
    expect(result.teamName).toBeNull();
    expect(step(result, "team")).toEqual({ id: "team", ok: true });
    expect(step(result, "projects")).toEqual({ id: "projects", ok: true });
    expect(result.abilities.keys).toBe(false);
    // A scoped token can't reach keys at all, so the probe doesn't try.
    expect(fake.calls.some((c) => c.path.startsWith("/security/keys"))).toBe(
      false,
    );
  });

  it("a scoped token with no visible project leaves the team id empty", async () => {
    const result = await probeWith(
      healthyCoolify({ "GET /team": forbidden, "GET /projects": { json: [] } }),
    );
    expect(result.scoped).toBe(true);
    expect(result.teamId).toBeNull();
  });

  it("probe refuses Coolify older than 4.4.0 with cause unsupported-version", async () => {
    const fake = healthyCoolify({ "GET /version": { text: "v4.3.9" } });
    const result = await probeWith(fake);
    expect(result.ok).toBe(false);
    expect(result.version).toBe("v4.3.9");
    expect(step(result, "version")).toEqual({
      id: "version",
      ok: false,
      cause: "unsupported-version",
    });
    expect(fake.calls.some((c) => c.path === "/team")).toBe(false);
  });

  it("accepts a nightly of a new enough version", async () => {
    const result = await probeWith(
      healthyCoolify({ "GET /version": { text: "4.8.0-nightly.3" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("probe marks keys readable only when private_key is present and discards it", async () => {
    const withKey = await probeWith(healthyCoolify());
    expect(withKey.abilities.keys).toBe(true);
    expect(JSON.stringify(withKey)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(withKey)).not.toContain("not-a-real-key");

    const without = await probeWith(
      healthyCoolify({
        "GET /security/keys/key-uuid": {
          json: { id: 3, uuid: "key-uuid", name: "deploy key" },
        },
        "GET /applications/app-web-uuid/logs": forbidden,
      }),
    );
    expect(without.abilities.keys).toBe(false);
    expect(without.abilities.sensitive).toBe(false);
    expect(step(without, "logs")).toEqual({
      id: "logs",
      ok: false,
      cause: "forbidden-ability",
    });
  });

  it("scoped token with only service parts still detects read:sensitive", async () => {
    const fake = healthyCoolify({
      "GET /team": forbidden,
      "GET /applications": { json: [] },
      "GET /databases": { json: [] },
      "GET /services": {
        json: [
          {
            id: 5,
            uuid: "svc-uuid",
            name: "stack",
            applications: [{ id: 6, uuid: "svc-app-uuid", name: "web" }],
            databases: [],
          },
        ],
      },
      "GET /services/svc-uuid/applications/svc-app-uuid/logs": {
        json: { logs: "a line" },
      },
    });
    const result = await probeWith(fake);
    expect(result.scoped).toBe(true);
    expect(result.abilities.sensitive).toBe(true);
    expect(step(result, "logs")).toEqual({ id: "logs", ok: true });
    expect(
      fake.calls.some(
        (c) => c.path === "/services/svc-uuid/applications/svc-app-uuid/logs",
      ),
    ).toBe(true);
  });

  it("says there was nothing to probe instead of claiming the token can't read logs", async () => {
    const result = await probeWith(
      healthyCoolify({
        "GET /team": forbidden,
        "GET /applications": { json: [] },
        "GET /databases": { json: [] },
        "GET /services": { json: [] },
      }),
    );
    expect(result.abilities.sensitive).toBe(false);
    expect(step(result, "logs")).toEqual({
      id: "logs",
      ok: false,
      skipped: "nothing-to-probe",
    });

    const noKeys = await probeWith(
      healthyCoolify({ "GET /security/keys": { json: [] } }),
    );
    expect(noKeys.abilities.keys).toBe(false);
    expect(step(noKeys, "keys")).toEqual({
      id: "keys",
      ok: false,
      skipped: "nothing-to-probe",
    });
  });

  it("email settings access does not imply root or sensitive", async () => {
    const result = await probeWith(
      healthyCoolify({
        "GET /settings/email": { json: { smtp_enabled: false } },
        "GET /security/keys/key-uuid": {
          json: { id: 3, uuid: "key-uuid", name: "deploy key" },
        },
        "GET /applications/app-web-uuid/logs": forbidden,
      }),
    );
    expect(result.abilities).toMatchObject({
      keys: false,
      sensitive: false,
      root: false,
    });
    // Reading instance settings is recorded as its own step, not an ability.
    expect(step(result, "settings")).toEqual({ id: "settings", ok: true });
    expect(step(result, "root")).toBeUndefined();
  });

  it("stops at the first step when Coolify can't be reached, with a cause", async () => {
    const fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const http = createCoolifyHttp(
      fetch,
      {
        baseUrl: "https://coolify.example.test",
        token: TOKEN,
        cfAccess: null,
        allowPrivate: false,
        caCert: null,
      },
      { sleep: async () => {} },
    );
    const result = await runProbe(createCoolifyApi(http), http);
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      { id: "health", ok: false, cause: "unreachable" },
    ]);
  });

  it("names Cloudflare Access, a disabled API and a bad token", async () => {
    const access = await probeWith(
      fakeCoolify({
        "GET /health": () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://t.cloudflareaccess.com/login" },
          }),
      }),
    );
    expect(access.steps[0]).toEqual({
      id: "health",
      ok: false,
      cause: "access-redirect",
    });

    const disabled = await probeWith(
      healthyCoolify({
        "GET /version": {
          status: 403,
          json: { message: "API is disabled." },
        },
      }),
    );
    expect(step(disabled, "version")?.cause).toBe("api-disabled");

    const badToken = await probeWith(
      healthyCoolify({
        "GET /version": { status: 401, json: { message: "Unauthenticated." } },
      }),
    );
    expect(badToken.ok).toBe(false);
    expect(step(badToken, "version")?.cause).toBe("unauthorized");
  });

  it("answers not-coolify for an HTML page instead of a version", async () => {
    const result = await probeWith(
      healthyCoolify({
        "GET /version": { text: "<!doctype html><title>Login</title>" },
      }),
    );
    expect(step(result, "version")?.cause).toBe("not-coolify");
  });
});
