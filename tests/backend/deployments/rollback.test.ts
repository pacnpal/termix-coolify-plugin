import { afterEach, describe, expect, it } from "vitest";
import type { PluginOperationContext } from "@termix-ssh/plugin-sdk/backend";
import { handleMcp, toolName } from "../../../src/backend/mcp/server.js";
import {
  deploymentAnswers,
  rollbackAnswers,
  rollbackImagesRaw,
} from "../helpers/deployments.js";
import { changes, grant, link, startLifecycle } from "../helpers/lifecycle.js";
import {
  manifest,
  OTHER,
  OWNER,
  type PluginHarness,
} from "../helpers/plugin.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(
  opts: { permissions?: string[]; settings?: Record<string, unknown> } = {},
) {
  const started = await startLifecycle({
    permissions: opts.permissions,
    settings: opts.settings,
    overrides: { ...deploymentAnswers(), ...rollbackAnswers() },
  });
  harness = started.harness;
  return started;
}

function context(
  over: Partial<PluginOperationContext> = {},
): PluginOperationContext {
  return {
    runId: "run-test",
    dryRun: false,
    signal: new AbortController().signal,
    log: () => {},
    ...over,
  };
}

function handler(h: PluginHarness, id: string) {
  const found = h.mock.operationHandlers.get(id);
  if (!found) throw new Error(`${id} has no handler`);
  return found;
}

function action(id: string) {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id);
}

/** A Coolify answer that runs `before` first, as if it happened meanwhile. */
function answerAfter(before: () => void, json: unknown) {
  return () => {
    before();
    return new Response(JSON.stringify(json), {
      headers: { "content-type": "application/json" },
    });
  };
}

const web = (id: number) => `/connections/${id}/resources/app-web-uuid`;
const IMAGES = "GET /applications/app-web-uuid/rollback-images";

describe("rollback declarations", () => {
  it("declares the reads and the rollbacks, apps only, with operate and a confirm", () => {
    expect(action("coolify.rollback-images")).toMatchObject({
      scope: "resource",
      resource: "coolify.resource",
      risk: "read",
      permission: "view",
      hostAccess: "connect",
    });
    expect(action("coolify.resource-rollback-images")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "view",
    });
    expect(action("coolify.rollback")).toMatchObject({
      scope: "resource",
      resource: "coolify.resource",
      risk: "destructive",
      permission: "operate",
      hostAccess: "edit",
      dryRun: "describe",
      check: "coolify.rollback-images",
      surfaces: { mcp: true },
    });
    expect(
      action("coolify.rollback")!.inputs!.find((i) => i.key === "image"),
    ).toMatchObject({
      type: "select",
      optionsFrom: "coolify.rollback-images",
      required: true,
    });
    expect(action("coolify.resource-rollback")).toMatchObject({
      scope: "server",
      risk: "destructive",
      permission: "operate",
      dryRun: "describe",
      check: "coolify.resource-rollback-images",
      surfaces: { mcp: true },
    });
    expect(
      action("coolify.resource-rollback")!.inputs!.find(
        (i) => i.key === "image",
      ),
    ).toMatchObject({
      optionsFrom: "coolify.resource-rollback-images",
      required: true,
    });
  });

  it("registers rollback as deploy's undo", () => {
    expect(action("coolify.deploy")).toMatchObject({
      undo: "coolify.rollback",
    });
    expect(action("coolify.resource-deploy")).toMatchObject({
      undo: "coolify.resource-rollback",
    });
  });
});

describe("rollback images", () => {
  it("lists an app's images, current marked, and offers the others", async () => {
    const { harness, id } = await start({ permissions: ["coolify.view"] });
    const answer = await harness.request("GET", `${web(id)}/rollback-images`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      uuid: "app-web-uuid",
      name: "web",
      current: "abc1234",
      images: [
        {
          tag: "abc1234",
          createdAt: "2026-11-19T10:00:00.000000Z",
          current: true,
          source: "local",
        },
        {
          tag: "0ld3r00",
          createdAt: "2026-11-18T09:00:00.000000Z",
          current: false,
          source: "local",
        },
        {
          tag: "0ld3st0",
          createdAt: "2026-11-17T08:00:00.000000Z",
          current: false,
          source: "registry",
        },
      ],
    });

    const outcome = await harness.mock.ctx.operations.run(
      "coolify.resource-rollback-images",
      { input: { connectionId: String(id), uuid: "app-web-uuid" } },
    );
    const options = (outcome.data as { options: { value: string }[] }).options;
    expect(options.map((o) => o.value)).toEqual(["0ld3r00", "0ld3st0"]);
  });

  it("is not offered for services or databases", async () => {
    const { harness, fake, id } = await start();
    for (const uuid of ["svc-n8n-uuid", "db-cache-uuid"]) {
      const answer = await harness.request(
        "GET",
        `/connections/${id}/resources/${uuid}/rollback-images`,
      );
      expect(answer.status, uuid).toBe(404);
    }
    expect(fake.calls.filter((c) => c.path.includes("rollback"))).toEqual([]);
  });

  it("the resource-scope read lists the images of a Linked host's app", async () => {
    const { harness, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.rollback-images",
      { hostId: 7, resourceKey: "app-web-uuid" },
    );
    expect(outcome.data).toMatchObject({ current: "abc1234" });
    // An app on another server is not this host's.
    link(harness, id, "srv-edge-uuid", 8);
    await expect(
      harness.mock.ctx.operations.run("coolify.rollback-images", {
        hostId: 8,
        resourceKey: "app-web-uuid",
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("rolling back", () => {
  it("rolls back through the route, as a confirmed coolify.resource-rollback", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request("POST", `${web(id)}/rollback`, {
      image: "0ld3r00",
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      uuid: "app-web-uuid",
      image: "0ld3r00",
      deploymentUuid: "dep-rollback",
    });
    const posted = changes(fake);
    expect(posted.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /applications/app-web-uuid/rollback",
    ]);
    expect(JSON.parse(String(posted[0].init?.body))).toEqual({
      commit: "0ld3r00",
    });
  });

  it("works through the Operations API in both scopes", async () => {
    const { harness, fake, id } = await start();
    const server = await harness.mock.ctx.operations.run(
      "coolify.resource-rollback",
      {
        input: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          image: "0ld3st0",
        },
        confirmed: true,
      },
    );
    expect(server).toMatchObject({
      changed: true,
      data: { image: "0ld3st0", deploymentUuid: "dep-rollback" },
    });
    expect(server.summary).toContain("0ld3st0");

    link(harness, id, "srv-vps1-uuid", 7);
    const scoped = await harness.mock.ctx.operations.run("coolify.rollback", {
      hostId: 7,
      resourceKey: "app-web-uuid",
      input: { image: "0ld3r00" },
      confirmed: true,
    });
    expect(scoped.data).toMatchObject({ image: "0ld3r00" });
    expect(
      changes(fake).map((c) => JSON.parse(String(c.init?.body)).commit),
    ).toEqual(["0ld3st0", "0ld3r00"]);
  });

  it("the confirm (dry run) names the image tag", async () => {
    const { harness, fake, id } = await start();
    const text = await handler(harness, "coolify.resource-rollback").describe!(
      { connectionId: String(id), uuid: "app-web-uuid", image: "0ld3r00" },
      context(),
    );
    expect(text).toContain("0ld3r00");
    expect(text).toContain("web");
    link(harness, id, "srv-vps1-uuid", 7);
    const scoped = await handler(harness, "coolify.rollback").describe!(
      { image: "0ld3st0" },
      context({ hostId: 7, resourceKey: "app-web-uuid" }),
    );
    expect(scoped).toContain("0ld3st0");
    expect(changes(fake)).toEqual([]);
  });

  it("refuses a service, a database and an unlisted image before Coolify is asked", async () => {
    const { harness, fake, id } = await start();
    for (const uuid of ["svc-n8n-uuid", "db-cache-uuid"]) {
      const answer = await harness.request(
        "POST",
        `/connections/${id}/resources/${uuid}/rollback`,
        { image: "0ld3r00" },
      );
      expect(answer.status, uuid).toBe(404);
    }
    const unlisted = await harness.request("POST", `${web(id)}/rollback`, {
      image: "n0tth3r3",
    });
    expect(unlisted.status).toBe(400);
    const bad = await harness.request("POST", `${web(id)}/rollback`, {
      image: "../etc",
    });
    expect(bad.status).toBe(400);
    expect(changes(fake)).toEqual([]);
  });

  it("is refused without coolify.operate, and for a view grant", async () => {
    const viewOnly = await start({ permissions: ["coolify.view"] });
    const refused = await viewOnly.harness.request(
      "POST",
      `${web(viewOnly.id)}/rollback`,
      { image: "0ld3r00" },
    );
    expect(refused.status).toBe(403);
    await expect(
      handler(viewOnly.harness, "coolify.resource-rollback").run(
        {
          connectionId: String(viewOnly.id),
          uuid: "app-web-uuid",
          image: "0ld3r00",
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(changes(viewOnly.fake)).toEqual([]);
    await viewOnly.harness.close();

    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "view");
    const viewGrant = await harness.request(
      "POST",
      `${web(id)}/rollback`,
      { image: "0ld3r00" },
      OTHER,
    );
    expect(viewGrant.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the connection's target changes mid-call", async () => {
    const { harness, fake, id } = await start();
    fake.set(
      IMAGES,
      answerAfter(() => {
        harness.db.sqlite
          .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
          .run("https://other.example.test", id);
      }, rollbackImagesRaw()),
    );
    const refused = await harness.request("POST", `${web(id)}/rollback`, {
      image: "0ld3r00",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.cause).toBe("target-changed");
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the actor's grant drops below operate mid-call", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "operate");
    fake.set(
      IMAGES,
      answerAfter(() => {
        harness.db.sqlite
          .prepare(
            "UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?",
          )
          .run(OTHER);
      }, rollbackImagesRaw()),
    );
    const refused = await harness.request(
      "POST",
      `${web(id)}/rollback`,
      { image: "0ld3r00" },
      OTHER,
    );
    expect(refused.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("stops before Coolify is asked once its run is cancelled", async () => {
    const { harness, fake, id } = await start();
    const controller = new AbortController();
    fake.set(
      IMAGES,
      answerAfter(() => controller.abort(), rollbackImagesRaw()),
    );
    await expect(
      handler(harness, "coolify.resource-rollback").run(
        { connectionId: String(id), uuid: "app-web-uuid", image: "0ld3r00" },
        context({ signal: controller.signal }),
      ),
    ).rejects.toBeTruthy();
    expect(changes(fake)).toEqual([]);
  });
});

describe("deploy's undo", () => {
  /** Runs a deploy handler as core would, keeping the run's undoInput. */
  function deploy(
    h: PluginHarness,
    id: string,
    input: Record<string, unknown>,
    over: Partial<PluginOperationContext> = {},
  ) {
    return handler(h, id).run(input, context(over));
  }

  it("a deploy of an app records the image it replaced as the undo input", async () => {
    const { harness, id } = await start();
    const server = await deploy(harness, "coolify.resource-deploy", {
      connectionId: String(id),
      uuid: "app-web-uuid",
    });
    expect(server.undoInput).toEqual({
      connectionId: String(id),
      uuid: "app-web-uuid",
      image: "abc1234",
    });
    link(harness, id, "srv-vps1-uuid", 7);
    const scoped = await deploy(
      harness,
      "coolify.deploy",
      {},
      { hostId: 7, resourceKey: "app-web-uuid" },
    );
    expect(scoped.undoInput).toEqual({ image: "abc1234" });
  });

  it("records no undo when nothing is running, or for a service", async () => {
    const { harness, fake, id } = await start();
    fake.set(IMAGES, { json: { current: null, images: [] } });
    const none = await deploy(harness, "coolify.resource-deploy", {
      connectionId: String(id),
      uuid: "app-web-uuid",
    });
    expect(none.undoInput).toBeUndefined();
    const service = await deploy(harness, "coolify.resource-deploy", {
      connectionId: String(id),
      uuid: "svc-n8n-uuid",
    });
    expect(service.undoInput).toBeUndefined();
  });

  it("deploys anyway when the image list can't be read", async () => {
    const { harness, fake, id } = await start();
    fake.set(IMAGES, { status: 500, json: { message: "boom" } });
    const outcome = await deploy(harness, "coolify.resource-deploy", {
      connectionId: String(id),
      uuid: "app-web-uuid",
    });
    expect(outcome.undoInput).toBeUndefined();
    expect(changes(fake).map((c) => c.path)).toEqual(["/deploy"]);
  });
});

describe("rollback over MCP", () => {
  it("needs confirmed: true, then rolls back", async () => {
    const { harness, fake, id } = await start({
      settings: { allowMcpChanges: true },
    });
    harness.mock.setActor(OWNER);
    const call = (args: Record<string, unknown>) =>
      handleMcp(harness.mock.ctx, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName("coolify.resource-rollback"),
          arguments: args,
        },
      });
    const args = {
      connectionId: String(id),
      uuid: "app-web-uuid",
      image: "0ld3r00",
    };
    const refused = (await call(args))?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("confirm-required");
    expect(changes(fake)).toEqual([]);

    const done = (await call({ ...args, confirmed: true }))?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(done.isError).toBe(false);
    expect(done.content.map((c) => c.text).join("\n")).toContain("0ld3r00");
    expect(changes(fake).map((c) => c.path)).toEqual([
      "/applications/app-web-uuid/rollback",
    ]);
  });
});
