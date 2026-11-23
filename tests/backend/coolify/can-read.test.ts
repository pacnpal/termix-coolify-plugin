import { describe, expect, it } from "vitest";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";
import { createCoolifyHttp } from "../../../src/backend/coolify/http.js";
import { fakeCoolify, type FakeAnswer } from "../helpers/fake-coolify.js";

const target = {
  baseUrl: "https://coolify.example.test",
  token: "fake-token-can-read",
  cfAccess: null,
  allowPrivate: false,
  caCert: null,
};

function apiWith(routes: Record<string, FakeAnswer>) {
  const fake = fakeCoolify(routes);
  const api = createCoolifyApi(
    createCoolifyHttp(fake.fetch, target, { sleep: async () => {} }),
  );
  return { api, fake };
}

describe("canRead: the webhook's visibility check", () => {
  it("GETs the subject itself and passes only on a 200", async () => {
    const { api, fake } = apiWith({
      "GET /applications/app-a": { json: { uuid: "app-a" } },
      "GET /services/svc-a": { json: { uuid: "svc-a" } },
      "GET /databases/db-a": { json: { uuid: "db-a" } },
      "GET /servers/srv-a": { json: { uuid: "srv-a" } },
      "GET /team": { json: { id: 7 } },
    });
    expect(await api.canRead({ type: "application", uuid: "app-a" })).toBe(
      true,
    );
    expect(await api.canRead({ type: "service", uuid: "svc-a" })).toBe(true);
    expect(await api.canRead({ type: "database", uuid: "db-a" })).toBe(true);
    expect(await api.canRead({ type: "server", uuid: "srv-a" })).toBe(true);
    expect(await api.canRead({ type: "team" })).toBe(true);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /applications/app-a",
      "GET /services/svc-a",
      "GET /databases/db-a",
      "GET /servers/srv-a",
      "GET /team",
    ]);
  });

  it("answers false for 401, 403, 404, 204, 500 and a failed fetch, never retrying", async () => {
    for (const answer of [
      { status: 401, json: { message: "Unauthenticated." } },
      { status: 403, json: { message: "Forbidden." } },
      { status: 404, json: { message: "Not found." } },
      () => new Response(null, { status: 204 }),
      { status: 500, json: {} },
      { status: 429, json: {} },
      () => {
        throw new Error("timed out");
      },
    ] as FakeAnswer[]) {
      const { api, fake } = apiWith({ "GET /servers/srv-a": answer });
      expect(await api.canRead({ type: "server", uuid: "srv-a" })).toBe(false);
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("refuses a uuid that isn't one plain segment without a request", async () => {
    const { api, fake } = apiWith({});
    expect(
      await api.canRead({ type: "application", uuid: "../servers/x" }),
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});
