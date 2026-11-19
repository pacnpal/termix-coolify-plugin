import { afterEach, describe, expect, it } from "vitest";
import type { PluginOperationContext } from "@termix-ssh/plugin-sdk/backend";
import { fakeCoolify, healthyCoolify } from "./helpers/fake-coolify.js";
import {
  changes,
  grant,
  LIFECYCLE_TOKEN,
  lifecycleAnswers,
  link,
  startLifecycle,
} from "./helpers/lifecycle.js";
import {
  manifest,
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "./helpers/plugin.js";
import { resourceLists } from "./helpers/resources.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(options: Parameters<typeof startLifecycle>[0] = {}) {
  const started = await startLifecycle({ serve: false, ...options });
  harness = started.harness;
  return started;
}

/** Calls a handler directly, with the context core would give it. */
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

describe("lifecycle, resource and signal operations", () => {
  it("declares the resource, the actions, the signals and the events with their surfaces", () => {
    const ops = manifest.contributes!.operations!;
    expect(ops.resources).toContainEqual(
      expect.objectContaining({
        id: "coolify.resource",
        list: "coolify.list-resources",
        key: "uuid",
        name: "name",
        status: "status",
        url: "fqdn",
        tab: "coolify",
      }),
    );
    expect(action("coolify.list-resources")).toMatchObject({
      scope: "host",
      risk: "read",
      hostAccess: "connect",
    });
    expect(action("coolify.deploy")).toMatchObject({
      scope: "resource",
      resource: "coolify.resource",
      risk: "change",
      dryRun: "describe",
      surfaces: { assistant: true, mcp: true },
    });
    expect(
      action("coolify.deploy")!.inputs!.map((i) => [i.key, i.type]),
    ).toEqual([
      ["force", "boolean"],
      ["wait", "boolean"],
    ]);
    for (const id of ["coolify.start", "coolify.restart"]) {
      expect(action(id), id).toMatchObject({
        scope: "resource",
        risk: "change",
        idempotent: true,
      });
    }
    expect(action("coolify.restart")!.surfaces).toMatchObject({
      assistant: true,
      mcp: true,
    });
    expect(action("coolify.stop")).toMatchObject({
      scope: "resource",
      risk: "destructive",
      hostAccess: "edit",
      surfaces: { assistant: false, mcp: false },
    });
    expect(action("coolify.sync-host")).toMatchObject({
      scope: "host",
      risk: "change",
      surfaces: { assistant: false, mcp: false },
    });
    expect(action("coolify.resource-deploy")).toMatchObject({
      scope: "server",
      risk: "change",
      surfaces: { assistant: true, mcp: true },
    });
    expect(action("coolify.resource-restart")).toMatchObject({
      scope: "server",
      risk: "change",
      idempotent: true,
      surfaces: { assistant: true, mcp: true },
    });
    const resourceAction = action("coolify.resource-action")!;
    expect(resourceAction).toMatchObject({
      scope: "server",
      risk: "destructive",
      surfaces: { assistant: false, mcp: false },
    });
    expect(resourceAction.inputs!.find((i) => i.key === "action")).toEqual(
      expect.objectContaining({
        type: "select",
        options: [
          expect.objectContaining({ value: "start" }),
          expect.objectContaining({ value: "stop" }),
        ],
      }),
    );
    expect(
      resourceAction.inputs!.find((i) => i.key === "connectionId")!.optionsFrom,
    ).toBe("coolify.list-connections");
    expect(ops.signals!.map((s) => [s.id, s.scope, s.kind]).sort()).toEqual([
      ["coolify.degraded", "host", "count"],
      ["coolify.deploying", "server", "count"],
      ["coolify.server", "host", "status"],
      ["coolify.updates", "host", "count"],
    ]);
    expect(ops.events!.map((e) => e.id).sort()).toEqual([
      "coolify.container-restarted",
      "coolify.deployment-failed",
      "coolify.deployment-finished",
      "coolify.server-unreachable",
    ]);
  });

  it("unlinked host lists no rows without fetching", async () => {
    const { harness, fake } = await start();
    const before = fake.calls.length;
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.list-resources",
      { hostId: 99 },
    );
    expect(outcome.data).toEqual({ rows: [] });
    expect(fake.calls.length).toBe(before);
  });

  it("a linked host lists its server's resources with a fqdn column", async () => {
    const { harness, id } = await start();
    link(harness, id, "srv-edge-uuid", 7);
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.list-resources",
      { hostId: 7 },
    );
    const rows = (outcome.data as { rows: Record<string, unknown>[] }).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        uuid: "app-api-uuid",
        name: "api",
        status: "exited:unhealthy",
        fqdn: "https://api.x",
      }),
    ]);
  });

  it("deploy with wait emits deployment-finished", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const outcome = await harness.mock.ctx.operations.run("coolify.deploy", {
      hostId: 7,
      resourceKey: "app-web-uuid",
      input: { force: true, wait: true },
    });
    expect(outcome.data).toMatchObject({
      deploymentUuid: "dep-uuid",
      status: "finished",
    });
    expect(
      changes(fake).map((c) => new URL(c.url).searchParams.get("force")),
    ).toEqual(["true"]);
    expect(harness.mock.operationEvents).toEqual([
      {
        eventId: "coolify.deployment-finished",
        hostId: 7,
        payload: expect.objectContaining({
          connectionId: id,
          uuid: "app-web-uuid",
          name: "web",
          deploymentUuid: "dep-uuid",
          status: "finished",
        }),
      },
    ]);
    expect(JSON.stringify(outcome)).not.toContain("build log");
  });

  it("a failed deployment emits deployment-failed and fails the run", async () => {
    const { harness, id } = await start({
      overrides: {
        "GET /deployments/dep-uuid": {
          json: { deployment_uuid: "dep-uuid", status: "failed" },
        },
      },
    });
    await expect(
      harness.mock.ctx.operations.run("coolify.resource-deploy", {
        input: { connectionId: String(id), uuid: "app-web-uuid", wait: true },
      }),
    ).rejects.toMatchObject({ code: "deployment-failed" });
    expect(harness.mock.operationEvents.map((e) => e.eventId)).toEqual([
      "coolify.deployment-failed",
    ]);
  });

  it("deploy honours signal: an aborted signal throws", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler(harness, "coolify.deploy").run(
        { wait: true },
        context({
          hostId: 7,
          resourceKey: "app-web-uuid",
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow();
    expect(changes(fake)).toEqual([]);
  });

  it("deploy describes a dry run as Would deploy <name> on <server>", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const text = await handler(harness, "coolify.deploy").describe!(
      {},
      context({ hostId: 7, resourceKey: "app-web-uuid", dryRun: true }),
    );
    expect(text).toBe("Would deploy web on vps1");
    expect(changes(fake)).toEqual([]);
  });

  it("resource-action refuses another user's connection", async () => {
    const { harness, fake, id } = await start();
    harness.mock.setActor(OTHER);
    await expect(
      harness.mock.ctx.operations.run("coolify.resource-action", {
        input: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          action: "stop",
        },
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(changes(fake)).toEqual([]);
  });

  it("resource-action starts and stops for the owner", async () => {
    const { harness, fake, id } = await start();
    for (const verb of ["stop", "start"]) {
      await harness.mock.ctx.operations.run("coolify.resource-action", {
        input: { connectionId: String(id), uuid: "app-web-uuid", action: verb },
        confirmed: true,
      });
    }
    expect(changes(fake).map((c) => c.path)).toEqual([
      "/applications/app-web-uuid/stop",
      "/applications/app-web-uuid/start",
    ]);
  });

  it("a view grant can't operate a connection; an operate grant can", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "view");
    harness.mock.setActor(OTHER);
    await expect(
      harness.mock.ctx.operations.run("coolify.resource-restart", {
        input: { connectionId: String(id), uuid: "app-web-uuid" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(changes(fake)).toEqual([]);
    harness.db.sqlite
      .prepare("UPDATE p_coolify_grants SET level = 'operate'")
      .run();
    await harness.mock.ctx.operations.run("coolify.resource-restart", {
      input: { connectionId: String(id), uuid: "app-web-uuid" },
    });
    expect(changes(fake).map((c) => c.path)).toEqual([
      "/applications/app-web-uuid/restart",
    ]);
  });

  it("refuses without coolify.operate before calling Coolify", async () => {
    const { harness, fake, id } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    await expect(
      harness.mock.ctx.operations.run("coolify.resource-deploy", {
        input: { connectionId: String(id), uuid: "app-web-uuid" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(changes(fake)).toEqual([]);
  });

  it("resource uuid from another connection is refused", async () => {
    // Two Coolify instances, both the owner's: the uuid exists only on B.
    const a = healthyCoolify({ ...resourceLists(), ...lifecycleAnswers() });
    const b = fakeCoolify(
      {
        "GET /health": { text: "OK" },
        "GET /version": { text: "v4.7.5" },
        "GET /applications": {
          json: [{ id: 90, uuid: "app-b-only", name: "b-app" }],
        },
        "GET /services": { json: [] },
        "GET /databases": { json: [] },
        "POST /deploy": { json: { deployments: [] } },
        "POST /applications/app-b-only/restart": { json: { message: "ok" } },
      },
      "https://b.example.test",
    );
    harness = await startPlugin({
      serve: false,
      fetch: (url, init) =>
        url.startsWith("https://b.example.test")
          ? b.fetch(url, init)
          : a.fetch(url, init),
    });
    const created = [];
    for (const base of [
      "https://coolify.example.test",
      "https://b.example.test",
    ]) {
      const outcome = await harness.mock.ctx.operations.run(
        "coolify.connection-create",
        { input: { name: base, baseUrl: base, token: LIFECYCLE_TOKEN } },
      );
      created.push((outcome.data as { id: number }).id);
    }
    const [idA] = created;
    for (const [actionId, input] of [
      ["coolify.resource-deploy", {}],
      ["coolify.resource-restart", {}],
      ["coolify.resource-action", { action: "stop" }],
    ] as const) {
      await expect(
        harness.mock.ctx.operations.run(actionId, {
          input: { connectionId: String(idA), uuid: "app-b-only", ...input },
          confirmed: true,
        }),
        actionId,
      ).rejects.toMatchObject({ code: "not-found" });
    }
    // A linked host of connection A can't reach B's resource either.
    link(harness, idA, "srv-vps1-uuid", 7);
    await expect(
      harness.mock.ctx.operations.run("coolify.restart", {
        hostId: 7,
        resourceKey: "app-b-only",
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect([...changes(a), ...changes(b)]).toEqual([]);
  });

  it("a resource on another server than the host's is refused", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-edge-uuid", 8);
    await expect(
      harness.mock.ctx.operations.run("coolify.stop", {
        hostId: 8,
        resourceKey: "app-web-uuid",
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(changes(fake)).toEqual([]);
  });

  it("signals read from cache: one fetch for three hosts on the same connection", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    link(harness, id, "srv-edge-uuid", 8);
    link(harness, id, "srv-gone-uuid", 9);
    // The probe read the lists once when the connection was added.
    const listed = () =>
      fake.calls.filter((c) => c.path === "/applications").length;
    const before = listed();
    const values = [];
    for (const hostId of [7, 8, 9]) {
      const outcome = await harness.mock.ctx.operations.run(
        "coolify.signal-degraded",
        { hostId },
      );
      values.push(outcome.data);
    }
    expect(values).toEqual([
      expect.objectContaining({ value: 2, status: "warn" }),
      expect.objectContaining({ value: 1, status: "warn" }),
      expect.objectContaining({ value: 0, status: "ok" }),
    ]);
    expect(listed() - before).toBe(1);
    for (const hostId of [7, 8]) {
      await harness.mock.ctx.operations.run("coolify.signal-server", {
        hostId,
      });
    }
    expect(fake.calls.filter((c) => c.path === "/servers")).toHaveLength(1);
  });

  it("the server signal reads reachability and an unlinked host is unknown", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-edge-uuid", 8);
    const edge = await harness.mock.ctx.operations.run(
      "coolify.signal-server",
      { hostId: 8 },
    );
    expect(edge.data).toMatchObject({ status: "fail" });
    const before = fake.calls.length;
    const none = await harness.mock.ctx.operations.run(
      "coolify.signal-server",
      { hostId: 99 },
    );
    expect(none.data).toMatchObject({ status: "unknown" });
    expect(fake.calls.length).toBe(before);
  });

  it("the deploying signal counts deploying resources across the actor's connections", async () => {
    const { harness } = await start();
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.signal-deploying",
      {},
    );
    expect(outcome.data).toMatchObject({ value: 1, status: "ok" });
  });

  it("sync-host re-syncs only the host's own server and needs the owner", async () => {
    const { harness, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    grant(harness, id, OTHER, "configure");
    harness.mock.setActor(OTHER);
    await expect(
      harness.mock.ctx.operations.run("coolify.sync-host", { hostId: 7 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    harness.mock.setActor(OWNER);
    await expect(
      harness.mock.ctx.operations.run("coolify.sync-host", { hostId: 99 }),
    ).rejects.toMatchObject({ code: "not-linked" });
  });

  it("no lifecycle answer carries the token", async () => {
    const { harness, id } = await start();
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.resource-deploy",
      { input: { connectionId: String(id), uuid: "app-web-uuid" } },
    );
    expect(JSON.stringify(outcome)).not.toContain(LIFECYCLE_TOKEN);
    expect(outcome.data).toMatchObject({ deploymentUuid: "dep-uuid" });
  });
});
