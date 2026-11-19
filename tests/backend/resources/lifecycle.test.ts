import { afterEach, describe, expect, it, vi } from "vitest";
import { changes, link, startLifecycle } from "../helpers/lifecycle.js";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  vi.restoreAllMocks();
});

async function start(options: Parameters<typeof startLifecycle>[0] = {}) {
  const started = await startLifecycle(options);
  harness = started.harness;
  const run = vi.spyOn(harness.mock.ctx.operations, "run");
  return { ...started, run };
}

const path = (id: number, uuid: string, verb: string) =>
  `/connections/${id}/resources/${uuid}/${verb}`;

describe("lifecycle routes", () => {
  it("deploy with a linked host runs coolify.deploy and lands in host history", async () => {
    const { harness, fake, id, run } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const answer = await harness.request(
      "POST",
      path(id, "app-web-uuid", "deploy"),
      { force: true },
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ deploymentUuid: "dep-uuid" });
    expect(run).toHaveBeenCalledWith("coolify.deploy", {
      hostId: 7,
      resourceKey: "app-web-uuid",
      input: { force: true },
    });
    const [call] = changes(fake);
    expect(call.path).toBe("/deploy");
    expect(new URL(call.url).searchParams.get("force")).toBe("true");
  });

  it("restart and stop with a linked host run the resource-scope actions", async () => {
    const { harness, fake, id, run } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    for (const verb of ["restart", "stop", "start"]) {
      const answer = await harness.request(
        "POST",
        path(id, "app-web-uuid", verb),
      );
      expect(answer.status, verb).toBe(200);
      expect(answer.body).toEqual({ deploymentUuid: null });
    }
    expect(run.mock.calls.map((c) => [c[0], c[1]?.hostId])).toEqual([
      ["coolify.restart", 7],
      ["coolify.stop", 7],
      ["coolify.start", 7],
    ]);
    expect(run.mock.calls[1][1]).toMatchObject({ confirmed: true });
    expect(changes(fake).map((c) => c.path)).toEqual([
      "/applications/app-web-uuid/restart",
      "/applications/app-web-uuid/stop",
      "/applications/app-web-uuid/start",
    ]);
  });

  it("without coolify.operate 403", async () => {
    const { harness, fake, id } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    for (const verb of ["start", "stop", "restart", "deploy"]) {
      const answer = await harness.request(
        "POST",
        path(id, "app-web-uuid", verb),
      );
      expect(answer.status, verb).toBe(403);
    }
    expect(changes(fake)).toEqual([]);
  });

  it("403 from Coolify maps to a 502 with cause forbidden-ability", async () => {
    const { harness, id } = await start({
      overrides: {
        "POST /applications/app-web-uuid/restart": {
          status: 403,
          json: { message: "You are not allowed to do this." },
        },
      },
    });
    const answer = await harness.request(
      "POST",
      path(id, "app-web-uuid", "restart"),
    );
    expect(answer.status).toBe(502);
    expect(answer.body).toEqual({
      error: expect.any(String),
      cause: "forbidden-ability",
    });
    expect(JSON.stringify(answer.body)).not.toContain("not allowed");
  });

  it("restart works without a linked host via coolify.resource-restart", async () => {
    const { harness, fake, id, run } = await start();
    const answer = await harness.request(
      "POST",
      path(id, "part-n8n-uuid", "restart"),
    );
    expect(answer.status).toBe(200);
    expect(run).toHaveBeenCalledWith("coolify.resource-restart", {
      input: { connectionId: String(id), uuid: "part-n8n-uuid" },
    });
    expect(changes(fake).map((c) => c.path)).toEqual([
      "/services/svc-n8n-uuid/applications/part-n8n-uuid/restart",
    ]);
  });

  it("deploy works without a linked host via coolify.resource-deploy", async () => {
    const { harness, fake, id, run } = await start();
    const answer = await harness.request(
      "POST",
      path(id, "app-web-uuid", "deploy"),
      {},
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ deploymentUuid: "dep-uuid" });
    expect(run).toHaveBeenCalledWith("coolify.resource-deploy", {
      input: { connectionId: String(id), uuid: "app-web-uuid", force: false },
    });
    expect(changes(fake).map((c) => c.path)).toEqual(["/deploy"]);
  });

  it("stop works without a linked host via coolify.resource-action", async () => {
    const { harness, fake, id, run } = await start();
    const answer = await harness.request(
      "POST",
      path(id, "app-web-uuid", "stop"),
    );
    expect(answer.status).toBe(200);
    expect(run).toHaveBeenCalledWith("coolify.resource-action", {
      input: { connectionId: String(id), uuid: "app-web-uuid", action: "stop" },
      confirmed: true,
    });
    expect(changes(fake).map((c) => c.path)).toEqual([
      "/applications/app-web-uuid/stop",
    ]);
  });

  it("another user's connection and an unknown resource answer 404 and change nothing", async () => {
    const { harness, fake, id } = await start();
    const other = await harness.request(
      "POST",
      path(id, "app-web-uuid", "restart"),
      undefined,
      OTHER,
    );
    expect(other.status).toBe(404);
    const missing = await harness.request(
      "POST",
      path(id, "missing-uuid", "restart"),
    );
    expect(missing.status).toBe(404);
    expect(changes(fake)).toEqual([]);
  });

  it("refuses a force that is not true or false", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request(
      "POST",
      path(id, "app-web-uuid", "deploy"),
      { force: "yes" },
    );
    expect(answer.status).toBe(400);
    expect(changes(fake)).toEqual([]);
  });
});
