import { describe, expect, it, vi } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../../manifest.json";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";
import {
  CoolifyError,
  createCoolifyHttp,
} from "../../../src/backend/coolify/http.js";
import type { Connections } from "../../../src/backend/connections/service.js";
import type { ResourceDto } from "../../../src/backend/coolify/dto.js";
import {
  createLifecycle,
  lifecycle,
} from "../../../src/backend/resources/lifecycle.js";
import type { Resources } from "../../../src/backend/resources/service.js";
import { fakeCoolify, type FakeAnswer } from "../helpers/fake-coolify.js";
import { resourceLists } from "../helpers/resources.js";

/** A CoolifyApi over a fake Coolify, so every call is recorded by path. */
function apiWith(routes: Record<string, FakeAnswer>) {
  const fake = fakeCoolify({ ...resourceLists(), ...routes });
  const http = createCoolifyHttp(
    fake.fetch,
    {
      baseUrl: "https://coolify.example.test",
      token: "fake-token-lifecycle",
      cfAccess: null,
      allowPrivate: false,
      caCert: null,
    },
    { sleep: async () => {} },
  );
  return { api: createCoolifyApi(http), fake };
}

function posts(fake: ReturnType<typeof fakeCoolify>) {
  return fake.calls.filter((c) => c.method !== "GET");
}

describe("lifecycle()", () => {
  it("deploy calls /deploy?uuid=&force= and returns deploymentUuid", async () => {
    const { api, fake } = apiWith({
      "POST /deploy": {
        json: {
          deployments: [
            {
              message: "Deployment queued.",
              resource_uuid: "app-web-uuid",
              deployment_uuid: "dep-new-uuid",
            },
          ],
        },
      },
    });
    const result = await lifecycle(api, "app-web-uuid", "deploy", {
      force: true,
    });
    expect(result).toEqual({ deploymentUuid: "dep-new-uuid" });
    const [call] = posts(fake);
    expect(call.path).toBe("/deploy");
    const query = new URL(call.url).searchParams;
    expect(query.get("uuid")).toBe("app-web-uuid");
    expect(query.get("force")).toBe("true");

    await lifecycle(api, "app-web-uuid", "deploy");
    expect(new URL(posts(fake)[1].url).searchParams.get("force")).toBe("false");
  });

  it("service part restart calls /services/{parent}/applications/{uuid}/restart", async () => {
    const { api, fake } = apiWith({
      "POST /services/svc-n8n-uuid/applications/part-n8n-uuid/restart": {
        json: { message: "Restart request queued." },
      },
      "POST /services/svc-n8n-uuid/databases/part-postgres-uuid/stop": {
        json: { message: "Stop request queued." },
      },
    });
    expect(await lifecycle(api, "part-n8n-uuid", "restart")).toEqual({
      deploymentUuid: null,
    });
    await lifecycle(api, "part-postgres-uuid", "stop");
    expect(posts(fake).map((c) => c.path)).toEqual([
      "/services/svc-n8n-uuid/applications/part-n8n-uuid/restart",
      "/services/svc-n8n-uuid/databases/part-postgres-uuid/stop",
    ]);
  });

  it("deploying a Part deploys its service, and a known resource needs no lookup", async () => {
    const { api, fake } = apiWith({
      "POST /deploy": { json: { deployments: [] } },
      "POST /applications/app-web-uuid/start": { json: { message: "ok" } },
    });
    expect(await lifecycle(api, "part-n8n-uuid", "deploy")).toEqual({
      deploymentUuid: null,
    });
    expect(new URL(posts(fake)[0].url).searchParams.get("uuid")).toBe(
      "svc-n8n-uuid",
    );
    const before = fake.calls.length;
    await lifecycle(api, "app-web-uuid", "start", {
      resource: { uuid: "app-web-uuid", kind: "application", parentUuid: null },
    });
    expect(fake.calls.slice(before).map((c) => c.path)).toEqual([
      "/applications/app-web-uuid/start",
    ]);
  });

  it("an unknown uuid is not-found and calls nothing that changes", async () => {
    const { api, fake } = apiWith({});
    const err = await lifecycle(api, "missing-uuid", "stop").catch((e) => e);
    expect(err).toBeInstanceOf(CoolifyError);
    expect(err.cause).toBe("not-found");
    expect(posts(fake)).toEqual([]);
  });

  it("403 from Coolify surfaces as CoolifyError cause forbidden-ability", async () => {
    const { api } = apiWith({
      "POST /applications/app-web-uuid/restart": {
        status: 403,
        json: { message: "You are not allowed to do this." },
      },
    });
    const err = await lifecycle(api, "app-web-uuid", "restart").catch((e) => e);
    expect(err).toBeInstanceOf(CoolifyError);
    expect(err.cause).toBe("forbidden-ability");
    expect(err.status).toBe(403);
  });
});

describe("createLifecycle run", () => {
  const web = {
    uuid: "app-web-uuid",
    name: "web",
    kind: "application",
    parentUuid: null,
    serverUuid: "srv-vps1-uuid",
  } as ResourceDto;

  /** A lifecycle over a fake Coolify that records each resources.invalidate. */
  function runner(routes: Record<string, FakeAnswer>) {
    const { api, fake } = apiWith(routes);
    const order: string[] = [];
    fake.calls.push = new Proxy(fake.calls.push, {
      apply(target, self, args) {
        order.push(`coolify ${args[0].method} ${args[0].path}`);
        return Reflect.apply(target, self, args);
      },
    });
    const invalidate = vi.fn(async (id: number) => {
      order.push(`invalidate ${id}`);
    });
    const { ctx } = createMockCtx({
      pluginId: "coolify",
      manifest: manifestJson as unknown as PluginManifest,
      capabilities: (manifestJson as unknown as PluginManifest).capabilities,
    });
    const life = createLifecycle(ctx, {
      connections: { api: async () => api } as unknown as Connections,
      resources: { invalidate } as unknown as Resources,
      sync: { linkOfHost: async () => null, linkedHostFor: async () => null },
      sleep: async () => {},
    });
    return { life, invalidate, order };
  }

  it("drops the resource list after each action, also when Coolify refuses it", async () => {
    const { life, invalidate, order } = runner({
      "POST /applications/app-web-uuid/stop": {
        json: { message: "Request queued." },
      },
      "POST /applications/app-web-uuid/restart": {
        status: 403,
        json: { message: "You are not allowed to do this." },
      },
    });
    await life.run(1, web, "stop");
    expect(order).toEqual([
      "coolify POST /applications/app-web-uuid/stop",
      "invalidate 1",
    ]);
    await expect(life.run(1, web, "restart")).rejects.toMatchObject({
      cause: "forbidden-ability",
    });
    expect(order.slice(2)).toEqual([
      "coolify POST /applications/app-web-uuid/restart",
      "invalidate 1",
    ]);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("drops the resource list again when a waited deploy ends", async () => {
    const { life, order } = runner({
      "POST /deploy": {
        json: {
          deployments: [
            { resource_uuid: "app-web-uuid", deployment_uuid: "dep-uuid" },
          ],
        },
      },
      "GET /deployments/dep-uuid": {
        json: { deployment_uuid: "dep-uuid", status: "finished" },
      },
    });
    const outcome = await life.run(1, web, "deploy", { wait: true });
    expect(outcome).toEqual({ deploymentUuid: "dep-uuid", status: "finished" });
    expect(order).toEqual([
      "coolify POST /deploy",
      "invalidate 1",
      "coolify GET /deployments/dep-uuid",
      "invalidate 1",
    ]);
  });
});
