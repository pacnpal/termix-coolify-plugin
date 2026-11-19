import { describe, expect, it } from "vitest";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";
import {
  CoolifyError,
  createCoolifyHttp,
} from "../../../src/backend/coolify/http.js";
import { lifecycle } from "../../../src/backend/resources/lifecycle.js";
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
