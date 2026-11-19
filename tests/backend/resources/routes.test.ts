import { afterEach, describe, expect, it } from "vitest";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { OTHER, startPlugin, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists, SECRET } from "../helpers/resources.js";

const TOKEN = "fake-token-resource-routes";
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
  const fake = healthyCoolify(resourceLists());
  harness = await startPlugin({ fetch: fake.fetch, permissions });
  const created = await harness.request("POST", "/connections", body);
  return { harness, fake, id: created.body?.id ?? 1 };
}

describe("resource routes", () => {
  it("lists a connection's resources with their counts", async () => {
    const { harness, id } = await start();
    const answer = await harness.request("GET", `/connections/${id}/resources`);
    expect(answer.status).toBe(200);
    expect(answer.body.rows).toHaveLength(13);
    expect(answer.body.counts).toEqual({
      running: 3,
      degraded: 3,
      stopped: 1,
      deploying: 1,
    });
    expect(typeof answer.body.fetchedAt).toBe("string");
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
  });

  it("filters by server and refreshes on request", async () => {
    const { harness, fake, id } = await start();
    const edge = await harness.request(
      "GET",
      `/connections/${id}/resources?serverUuid=srv-edge-uuid`,
    );
    expect(edge.body.rows.map((r: { uuid: string }) => r.uuid)).toEqual([
      "app-api-uuid",
    ]);
    expect(edge.body.counts).toEqual({
      running: 0,
      degraded: 1,
      stopped: 0,
      deploying: 0,
    });
    const before = fake.calls.length;
    await harness.request("GET", `/connections/${id}/resources`);
    expect(fake.calls.length).toBe(before);
    await harness.request("GET", `/connections/${id}/resources?refresh=true`);
    expect(fake.calls.length).toBe(before + 3);
  });

  it("reads one resource, and 404s an unknown uuid", async () => {
    const { harness, id } = await start();
    const part = await harness.request(
      "GET",
      `/connections/${id}/resources/part-n8n-uuid`,
    );
    expect(part.status).toBe(200);
    expect(part.body).toMatchObject({
      uuid: "part-n8n-uuid",
      kind: "service-application",
      parentUuid: "svc-n8n-uuid",
      fqdns: ["https://n8n.x"],
    });
    const missing = await harness.request(
      "GET",
      `/connections/${id}/resources/missing-uuid`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.cause).toBe("not-found");
  });

  it("refuses without coolify.view (403)", async () => {
    const { harness } = await start([]);
    for (const path of [
      "/connections/1/resources",
      "/connections/1/resources/app-web-uuid",
    ]) {
      expect((await harness.request("GET", path)).status, path).toBe(403);
    }
  });

  it("another user's connection answers 404 and reaches no Coolify", async () => {
    const { harness, fake, id } = await start();
    await harness.request("GET", `/connections/${id}/resources`);
    const before = fake.calls.length;
    for (const path of [
      `/connections/${id}/resources`,
      `/connections/${id}/resources?refresh=true`,
      `/connections/${id}/resources/app-web-uuid`,
    ]) {
      const answer = await harness.request("GET", path, undefined, OTHER);
      expect(answer.status, path).toBe(404);
      expect(JSON.stringify(answer.body)).not.toContain("app-web");
    }
    expect(fake.calls.length).toBe(before);
  });

  it("maps a Coolify failure to 502 with a cause, never a throw", async () => {
    const { harness, fake, id } = await start();
    fake.set("GET /databases", { status: 401, json: { message: "no" } });
    const answer = await harness.request("GET", `/connections/${id}/resources`);
    expect(answer.status).toBe(502);
    expect(answer.body).toEqual({
      error: expect.any(String),
      cause: "unauthorized",
    });
  });
});
