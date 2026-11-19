import { afterEach, describe, expect, it } from "vitest";
import { healthyCoolify, type FakeAnswer } from "../helpers/fake-coolify.js";
import { OTHER, startPlugin, type PluginHarness } from "../helpers/plugin.js";

const TOKEN = "fake-token-api-console";
const ENV_VALUE = "fake-env-value-console";
const ALL = ["view", "operate", "configure", "administer"];

const ROUTES: Record<string, FakeAnswer> = {
  "GET /applications/app-web-uuid/envs": {
    json: [
      { uuid: "env-1", key: "API_SECRET", value: ENV_VALUE, is_preview: false },
    ],
  },
  "GET /servers": { json: [{ uuid: "srv-1", name: "one" }] },
  "POST /deploy": { json: { deployments: [] } },
  "DELETE /applications/app-web-uuid": { json: { message: "deleted" } },
};

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(
  options: {
    permissions?: string[];
    overrides?: Record<string, FakeAnswer>;
  } = {},
) {
  const fake = healthyCoolify({ ...ROUTES, ...options.overrides });
  harness = await startPlugin({
    fetch: fake.fetch,
    permissions: options.permissions ?? ALL,
  });
  const created = await harness.mock.ctx.operations.run(
    "coolify.connection-create",
    {
      input: {
        name: "Prod",
        baseUrl: "https://coolify.example.test",
        token: TOKEN,
      },
    },
  );
  const id = (created.data as { id: number }).id;
  fake.calls.length = 0;
  return { h: harness, fake, id };
}

const ENVS = {
  operationId: "list-envs-by-application-uuid",
  params: { uuid: "app-web-uuid" },
};

describe("API console routes", () => {
  it("GET /connections/:id/api/operations lists operations with their form schema", async () => {
    const { h, id } = await start();
    const answer = await h.request("GET", `/connections/${id}/api/operations`);
    expect(answer.status).toBe(200);
    const ops = answer.body.operations as {
      id: string;
      method: string;
      params: { name: string; in: string }[];
      body: { name: string }[] | null;
    }[];
    const envUpdate = ops.find(
      (o) => o.id === "update-env-by-application-uuid",
    )!;
    expect(envUpdate.method).toBe("PATCH");
    expect(envUpdate.params).toContainEqual(
      expect.objectContaining({ name: "uuid", in: "path" }),
    );
    expect(envUpdate.body!.map((f) => f.name)).toContain("value");
    expect(ops.map((o) => o.id)).not.toContain("disable-api");
  });

  it("refuses without coolify.view, and another user's connection is 404", async () => {
    {
      const { h, id } = await start({ permissions: [] });
      expect(
        (await h.request("GET", `/connections/${id}/api/operations`)).status,
      ).toBe(403);
      expect(
        (
          await h.request("POST", `/connections/${id}/api/call`, {
            operationId: "list-servers",
          })
        ).status,
      ).toBe(403);
      await h.close();
      harness = null;
    }
    const { h, id } = await start();
    expect(
      (
        await h.request(
          "GET",
          `/connections/${id}/api/operations`,
          undefined,
          OTHER,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(
          "POST",
          `/connections/${id}/api/call`,
          { operationId: "list-servers" },
          OTHER,
        )
      ).status,
    ).toBe(404);
  });

  it("a GET operation runs without confirm and answers masked values with their paths", async () => {
    const { h, id, fake } = await start();
    const answer = await h.request("POST", `/connections/${id}/api/call`, ENVS);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      method: "GET",
      operationId: "list-envs-by-application-uuid",
      path: "/applications/{uuid}/envs",
      data: [{ key: "API_SECRET", value: "[redacted]" }],
      masked: [[0, "value"]],
    });
    expect(JSON.stringify(answer.body)).not.toContain(ENV_VALUE);
    expect(fake.calls).toHaveLength(1);
  });

  it("api-call requires confirmed: a change without it is refused before Coolify is asked", async () => {
    const { h, id, fake } = await start();
    const refused = await h.request("POST", `/connections/${id}/api/call`, {
      operationId: "deploy-by-tag-or-uuid",
      params: { uuid: "app-web-uuid" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.cause).toBe("confirm-required");
    expect(fake.calls).toEqual([]);
    const done = await h.request("POST", `/connections/${id}/api/call`, {
      operationId: "deploy-by-tag-or-uuid",
      params: { uuid: "app-web-uuid" },
      confirmed: true,
    });
    expect(done.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it("a DELETE needs the typed confirm and coolify.administer", async () => {
    {
      const { h, id, fake } = await start({
        permissions: ["view", "operate", "configure"],
      });
      const refused = await h.request("POST", `/connections/${id}/api/call`, {
        operationId: "delete-application-by-uuid",
        params: { uuid: "app-web-uuid" },
        confirmed: true,
        confirmText: "delete-application-by-uuid",
      });
      expect(refused.status).toBe(403);
      expect(fake.calls).toEqual([]);
      await h.close();
      harness = null;
    }
    const { h, id, fake } = await start();
    const untyped = await h.request("POST", `/connections/${id}/api/call`, {
      operationId: "delete-application-by-uuid",
      params: { uuid: "app-web-uuid" },
      confirmed: true,
    });
    expect(untyped.status).toBe(400);
    expect(untyped.body.cause).toBe("confirm-required");
    const wrong = await h.request("POST", `/connections/${id}/api/call`, {
      operationId: "delete-application-by-uuid",
      params: { uuid: "app-web-uuid" },
      confirmed: true,
      confirmText: "delete",
    });
    expect(wrong.status).toBe(400);
    expect(fake.calls).toEqual([]);
    const done = await h.request("POST", `/connections/${id}/api/call`, {
      operationId: "delete-application-by-uuid",
      params: { uuid: "app-web-uuid" },
      confirmed: true,
      confirmText: "delete-application-by-uuid",
    });
    expect(done.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it("the disable-API operation is refused even when named directly", async () => {
    const { h, id, fake } = await start();
    const answer = await h.request("POST", `/connections/${id}/api/call`, {
      operationId: "disable-api",
      confirmed: true,
    });
    expect(answer.status).toBe(403);
    expect(answer.body.cause).toBe("excluded");
    expect(fake.calls).toEqual([]);
  });

  it("a 404 for an operation an older Coolify lacks answers 409 unsupported-by-instance", async () => {
    const { h, id } = await start({
      overrides: { "GET /version": { text: "v4.4.0" } },
    });
    const answer = await h.request("POST", `/connections/${id}/api/call`, {
      operationId: "get-server-sentinel",
      params: { uuid: "srv-1" },
    });
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("unsupported-by-instance");
  });

  it("reveal shows one value, audited, never cached", async () => {
    const { h, id, fake } = await start();
    const answer = await h.request("POST", `/connections/${id}/api/reveal`, {
      ...ENVS,
      pointer: [0, "value"],
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ value: ENV_VALUE });
    expect(fake.calls).toHaveLength(1);
    const audit = h.mock.audits.find((a) => a.action === "coolify.api.reveal");
    expect(audit).toMatchObject({ success: true });
    expect(JSON.stringify(h.mock.audits)).not.toContain(ENV_VALUE);
    // Asked again, it reads Coolify again: nothing was kept.
    await h.request("POST", `/connections/${id}/api/reveal`, {
      ...ENVS,
      pointer: [0, "value"],
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("reveal answers Cache-Control no-store", async () => {
    const { id } = await start();
    const response = await fetchRaw(id);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reveal needs coolify.configure", async () => {
    const { h, id, fake } = await start({ permissions: ["view", "operate"] });
    const answer = await h.request("POST", `/connections/${id}/api/reveal`, {
      ...ENVS,
      pointer: [0, "value"],
    });
    expect(answer.status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("reveal needs configure access: a view grant is refused", async () => {
    const { h, id, fake } = await start();
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
      )
      .run(id, OTHER, "view");
    const answer = await h.request(
      "POST",
      `/connections/${id}/api/reveal`,
      { ...ENVS, pointer: [0, "value"] },
      OTHER,
    );
    expect(answer.status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("reveal needs a token that reads secrets", async () => {
    const { h, id, fake } = await start({
      overrides: {
        "GET /applications/app-web-uuid/logs": {
          status: 403,
          json: { message: "Missing ability." },
        },
        "GET /security/keys/key-uuid": {
          json: { id: 3, uuid: "key-uuid", name: "deploy key" },
        },
        "GET /settings/email": { status: 403, json: { message: "No." } },
      },
    });
    const answer = await h.request("POST", `/connections/${id}/api/reveal`, {
      ...ENVS,
      pointer: [0, "value"],
    });
    expect(answer.status).toBe(403);
    expect(answer.body.cause).toBe("secrets-unreadable");
    expect(fake.calls).toEqual([]);
  });

  it("reveal refuses a value that is not masked, and non-GET operations", async () => {
    const { h, id } = await start();
    const plain = await h.request("POST", `/connections/${id}/api/reveal`, {
      ...ENVS,
      pointer: [0, "key"],
    });
    expect(plain.status).toBe(400);
    expect(plain.body.cause).toBe("not-masked");
    const write = await h.request("POST", `/connections/${id}/api/reveal`, {
      operationId: "update-env-by-application-uuid",
      params: { uuid: "app-web-uuid" },
      pointer: ["value"],
    });
    expect(write.status).toBe(400);
    expect(write.body.cause).toBe("not-a-read");
  });
});

async function fetchRaw(id: number): Promise<Response> {
  // The harness's request() drops headers; read them through the same server.
  const h = harness!;
  const original = globalThis.fetch;
  let seen: Response | null = null;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    seen = response.clone();
    return response;
  }) as typeof fetch;
  try {
    await h.request("POST", `/connections/${id}/api/reveal`, {
      ...ENVS,
      pointer: [0, "value"],
    });
  } finally {
    globalThis.fetch = original;
  }
  return seen!;
}
