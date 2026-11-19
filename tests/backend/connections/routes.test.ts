import { afterEach, describe, expect, it } from "vitest";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { OTHER, startPlugin, type PluginHarness } from "../helpers/plugin.js";

const TOKEN = "fake-token-routes-test";
const body = {
  name: "authz-own-connection",
  baseUrl: "https://coolify.example.test",
  token: TOKEN,
};

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(permissions?: string[]) {
  const fake = healthyCoolify();
  harness = await startPlugin({ fetch: fake.fetch, permissions });
  return { harness, fake };
}

describe("connection routes", () => {
  it("creates, lists, reads, updates, probes and deletes a connection", async () => {
    const { harness } = await start();
    const created = await harness.request("POST", "/connections", body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "authz-own-connection",
      version: "v4.7.5",
      scoped: false,
    });
    const id = created.body.id;

    const list = await harness.request("GET", "/connections");
    expect(list.status).toBe(200);
    expect(list.body.map((c: { id: number }) => c.id)).toEqual([id]);

    const one = await harness.request("GET", `/connections/${id}`);
    expect(one.body.name).toBe("authz-own-connection");

    const patched = await harness.request("PATCH", `/connections/${id}`, {
      name: "Renamed",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Renamed");

    const probed = await harness.request("POST", `/connections/${id}/probe`);
    expect(probed.status).toBe(200);
    expect(probed.body.probe.ok).toBe(true);
    expect(probed.body.connection.id).toBe(id);

    const removed = await harness.request("DELETE", `/connections/${id}`);
    expect(removed.status).toBe(200);
    expect((await harness.request("GET", `/connections/${id}`)).status).toBe(
      404,
    );
  });

  it("never returns the token", async () => {
    const { harness } = await start();
    const created = await harness.request("POST", "/connections", body);
    const id = created.body.id;
    const answers = [
      created,
      await harness.request("GET", "/connections"),
      await harness.request("GET", `/connections/${id}`),
      await harness.request("PATCH", `/connections/${id}`, { name: "x" }),
      await harness.request("POST", `/connections/${id}/probe`),
    ];
    for (const answer of answers) {
      expect(JSON.stringify(answer.body)).not.toContain(TOKEN);
    }
  });

  it("routes refuse without coolify.view (403)", async () => {
    const { harness } = await start([]);
    const calls: [string, string, unknown?][] = [
      ["GET", "/connections"],
      ["POST", "/connections", body],
      ["GET", "/connections/1"],
      ["PATCH", "/connections/1", { name: "x" }],
      ["DELETE", "/connections/1"],
      ["POST", "/connections/1/probe"],
    ];
    for (const [method, path, payload] of calls) {
      const answer = await harness.request(method, path, payload);
      expect(answer.status, `${method} ${path}`).toBe(403);
    }
  });

  it("changes need coolify.configure; reads and the probe need only coolify.view", async () => {
    const { harness } = await start(["coolify.view"]);
    const id = 1;
    expect((await harness.request("GET", "/connections")).status).toBe(200);
    expect((await harness.request("GET", `/connections/${id}`)).status).toBe(
      404,
    );
    expect((await harness.request("POST", "/connections", body)).status).toBe(
      403,
    );
    expect(
      (await harness.request("PATCH", `/connections/${id}`, { name: "x" }))
        .status,
    ).toBe(403);
    expect((await harness.request("DELETE", `/connections/${id}`)).status).toBe(
      403,
    );
  });

  it("another user's connection answers 404", async () => {
    const { harness, fake } = await start();
    const id = (await harness.request("POST", "/connections", body)).body.id;
    const calls = fake.calls.length;
    for (const [method, path, payload] of [
      ["GET", `/connections/${id}`],
      ["PATCH", `/connections/${id}`, { name: "x" }],
      ["DELETE", `/connections/${id}`],
      ["POST", `/connections/${id}/probe`],
    ] as [string, string, unknown?][]) {
      const answer = await harness.request(method, path, payload, OTHER);
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(answer.body)).not.toContain("authz-own");
    }
    const list = await harness.request("GET", "/connections", undefined, OTHER);
    expect(list.body).toEqual([]);
    // Nothing reached Coolify on the other user's behalf.
    expect(fake.calls.length).toBe(calls);
    expect((await harness.request("GET", `/connections/${id}`)).status).toBe(
      200,
    );
  });

  it("PATCH with an empty token keeps the stored one", async () => {
    const { harness, fake } = await start();
    const id = (await harness.request("POST", "/connections", body)).body.id;
    const patched = await harness.request("PATCH", `/connections/${id}`, {
      token: "",
      baseUrl: "https://coolify.example.test/",
    });
    expect(patched.status).toBe(200);
    await harness.request("POST", `/connections/${id}/probe`);
    const last = fake.calls[fake.calls.length - 1];
    expect(last.init?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("answers 400 for bad input, 404 for an unknown id and 409 for an old Coolify", async () => {
    const { harness, fake } = await start();
    expect(
      (await harness.request("POST", "/connections", { ...body, token: 5 }))
        .status,
    ).toBe(400);
    expect(
      (await harness.request("POST", "/connections", { name: "x" })).status,
    ).toBe(400);
    expect((await harness.request("GET", "/connections/abc")).status).toBe(404);
    expect((await harness.request("GET", "/connections/999")).status).toBe(404);
    fake.set("GET /version", { text: "v4.3.0" });
    const old = await harness.request("POST", "/connections", body);
    expect(old.status).toBe(409);
    expect(old.body).toEqual({
      error: "This plugin needs Coolify 4.4 or newer",
      cause: "unsupported-version",
    });
  });

  it("maps a Coolify failure during a probe to 502 with a cause, never a throw", async () => {
    const { harness, fake } = await start();
    const id = (await harness.request("POST", "/connections", body)).body.id;
    fake.set("GET /health", () => {
      throw new Error("ECONNREFUSED");
    });
    const probed = await harness.request("POST", `/connections/${id}/probe`);
    expect(probed.status).toBe(200);
    expect(probed.body.probe.steps).toEqual([
      { id: "health", ok: false, cause: "unreachable" },
    ]);
    expect(probed.body.connection.lastError).toBe("unreachable");
  });
});
