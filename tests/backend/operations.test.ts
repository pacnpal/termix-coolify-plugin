import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginOperationContext } from "@termix-ssh/plugin-sdk/backend";
import { validateManifest } from "@termix-ssh/plugin-sdk/manifest";
import { checkOperationReferences } from "@termix-ssh/plugin-sdk/operations";
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
import { redact } from "../../src/backend/redact.js";

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
        status: "running:unhealthy",
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

  it("deploy events carry only their declared non-secret fields, never Coolify's text", async () => {
    const { harness, id } = await start({
      overrides: {
        "GET /deployments/dep-uuid": {
          json: {
            deployment_uuid: "dep-uuid",
            status: "failed",
            logs: `build log with ${LIFECYCLE_TOKEN}`,
          },
        },
      },
    });
    link(harness, id, "srv-vps1-uuid", 7);
    await expect(
      harness.mock.ctx.operations.run("coolify.deploy", {
        hostId: 7,
        resourceKey: "app-web-uuid",
        input: { wait: true },
      }),
    ).rejects.toMatchObject({ code: "deployment-failed" });
    const [event] = harness.mock.operationEvents;
    const declared = manifest
      .contributes!.operations!.events!.find((e) => e.id === event.eventId)!
      .payload!.map((f) => f.key);
    expect(Object.keys(event.payload ?? {}).sort()).toEqual(
      [...declared].sort(),
    );
    expect(event.payload).toMatchObject({
      uuid: "app-web-uuid",
      status: "failed",
    });
    expect(event.hostId).toBe(7);
    expect(redact(event.payload)).toEqual(event.payload);
    const text = JSON.stringify(event);
    expect(text).not.toContain(LIFECYCLE_TOKEN);
    expect(text).not.toContain("build log");
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
    // vps1: worker is running:unhealthy (degraded); cache is exited, which
    // is stopped, not degraded. edge: api is running:unhealthy.
    expect(values).toEqual([
      expect.objectContaining({ value: 1, status: "warn" }),
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

  it("the degraded signal counts bare unhealthy, never exited with any health suffix", async () => {
    const on = { server: { uuid: "srv-vps1-uuid", name: "vps1" } };
    const app = (id: number, status: string) => ({
      id,
      uuid: `app-${id}-uuid`,
      name: `app-${id}`,
      status,
      destination: on,
    });
    const { harness, id } = await start({
      overrides: {
        "GET /applications": {
          json: [
            app(31, "exited:unhealthy"),
            app(32, "exited:healthy"),
            app(33, "exited"),
            app(34, "unhealthy"),
          ],
        },
        "GET /services": { json: [] },
        "GET /databases": { json: [] },
      },
    });
    link(harness, id, "srv-vps1-uuid", 7);
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.signal-degraded",
      { hostId: 7 },
    );
    expect(outcome.data).toMatchObject({ value: 1, status: "warn" });
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

describe("Operations Center acceptance", () => {
  /** Coolify's servers answer, with its own patch check on vps1 and edge. */
  const patchedServers = {
    "GET /servers": {
      json: [
        {
          uuid: "srv-vps1-uuid",
          name: "vps1",
          ip: "203.0.113.10",
          settings: { is_reachable: true, is_usable: true },
          patch_check_result: { total_updates: 4, security_updates: 2 },
          patch_checked_at: "2026-11-18T08:00:00Z",
        },
        {
          uuid: "srv-edge-uuid",
          name: "edge",
          ip: "203.0.113.20",
          settings: { is_reachable: false, is_usable: false },
          patch_check_result: { total_updates: 1, security_updates: 1 },
          patch_checked_at: "2026-11-18T08:00:00Z",
        },
      ],
    },
  };

  const HOST_SIGNALS = [
    "coolify.signal-degraded",
    "coolify.signal-server",
    "coolify.signal-updates",
  ];

  it("unlinked host lists no rows without a network call", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const exec = vi.spyOn(harness.mock.ctx.ssh, "exec");
    const before = fake.calls.length;
    for (const hostId of [99, undefined]) {
      const listed = await harness.mock.ctx.operations.run(
        "coolify.list-resources",
        { hostId },
      );
      expect(listed.data).toEqual({ rows: [] });
      for (const signal of HOST_SIGNALS) {
        const read = await harness.mock.ctx.operations.run(signal, {
          hostId,
        });
        expect(read.data, signal).toMatchObject({
          status: "unknown",
          label: "Not linked to Coolify",
        });
      }
    }
    expect(fake.calls.length).toBe(before);
    expect(exec).not.toHaveBeenCalled();
  });

  it("signals read from cache: one fetch for several hosts on one connection", async () => {
    const { harness, fake, id } = await start({ overrides: patchedServers });
    link(harness, id, "srv-vps1-uuid", 7);
    link(harness, id, "srv-edge-uuid", 8);
    link(harness, id, "srv-gone-uuid", 9);
    const exec = vi.spyOn(harness.mock.ctx.ssh, "exec");
    const count = (path: string) =>
      fake.calls.filter((c) => c.path === path).length;
    const before = { apps: count("/applications"), servers: count("/servers") };
    for (const hostId of [7, 8, 9]) {
      for (const signal of HOST_SIGNALS) {
        await harness.mock.ctx.operations.run(signal, { hostId });
      }
    }
    expect(count("/applications") - before.apps).toBe(1);
    expect(count("/servers") - before.servers).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it("signals check access per host: another user's connection is never read, even cached", async () => {
    const { harness, fake, id } = await start({ overrides: patchedServers });
    link(harness, id, "srv-vps1-uuid", 7);
    // The owner's reads warm the caches.
    for (const signal of HOST_SIGNALS) {
      await harness.mock.ctx.operations.run(signal, { hostId: 7 });
    }
    const before = fake.calls.length;
    harness.mock.setActor(OTHER);
    for (const signal of HOST_SIGNALS) {
      const read = await harness.mock.ctx.operations.run(signal, {
        hostId: 7,
      });
      expect(read.data, signal).toMatchObject({ status: "unknown" });
      expect(JSON.stringify(read.data), signal).not.toContain("vps1");
    }
    const deploying = await harness.mock.ctx.operations.run(
      "coolify.signal-deploying",
      {},
    );
    expect(deploying.data).toMatchObject({ value: 0 });
    expect(fake.calls.length).toBe(before);
  });

  it("deploy with wait emits deployment-finished or deployment-failed with hostId when linked", async () => {
    // Server scope, on a resource whose server has a Linked host: hostId 7.
    const finished = await start();
    link(finished.harness, finished.id, "srv-vps1-uuid", 7);
    await finished.harness.mock.ctx.operations.run("coolify.resource-deploy", {
      input: {
        connectionId: String(finished.id),
        uuid: "app-web-uuid",
        wait: true,
      },
    });
    expect(finished.harness.mock.operationEvents).toEqual([
      expect.objectContaining({
        eventId: "coolify.deployment-finished",
        hostId: 7,
      }),
    ]);
    await finished.harness.close();

    const failed = await start({
      overrides: {
        "GET /deployments/dep-uuid": {
          json: { deployment_uuid: "dep-uuid", status: "failed" },
        },
      },
    });
    link(failed.harness, failed.id, "srv-vps1-uuid", 7);
    await expect(
      failed.harness.mock.ctx.operations.run("coolify.deploy", {
        hostId: 7,
        resourceKey: "app-web-uuid",
        input: { wait: true },
      }),
    ).rejects.toMatchObject({ code: "deployment-failed" });
    expect(failed.harness.mock.operationEvents).toEqual([
      expect.objectContaining({
        eventId: "coolify.deployment-failed",
        hostId: 7,
        payload: expect.objectContaining({
          uuid: "app-web-uuid",
          status: "failed",
        }),
      }),
    ]);
    await failed.harness.close();

    // Without a Linked host the event carries no hostId.
    const unlinked = await start();
    await unlinked.harness.mock.ctx.operations.run("coolify.resource-deploy", {
      input: {
        connectionId: String(unlinked.id),
        uuid: "app-web-uuid",
        wait: true,
      },
    });
    expect(unlinked.harness.mock.operationEvents).toEqual([
      expect.objectContaining({ eventId: "coolify.deployment-finished" }),
    ]);
    expect(unlinked.harness.mock.operationEvents[0]?.hostId).toBeUndefined();
  });

  it("handlers honour the abort signal", async () => {
    const { harness, fake, id } = await start();
    link(harness, id, "srv-vps1-uuid", 7);
    const exec = vi.spyOn(harness.mock.ctx.ssh, "exec");
    const invoke = vi.spyOn(harness.mock.ctx.operations, "invoke");
    const before = fake.calls.length;
    const actions = manifest.contributes!.operations!.actions!;
    expect(actions.length).toBeGreaterThan(0);
    const input = {
      connectionId: String(id),
      uuid: "app-web-uuid",
      serverUuid: "srv-vps1-uuid",
    };
    for (const declared of actions) {
      const registered = handler(harness, declared.id);
      const controller = new AbortController();
      const reason = new Error(`cancelled ${declared.id}`);
      controller.abort(reason);
      const c = context({
        hostId: 7,
        resourceKey: "app-web-uuid",
        signal: controller.signal,
      });
      await expect(
        (async () => registered.run(input, c))(),
        declared.id,
      ).rejects.toBe(reason);
      if (registered.describe) {
        await expect(
          (async () => registered.describe!(input, c))(),
          `${declared.id} describe`,
        ).rejects.toBe(reason);
      }
    }
    expect(fake.calls.length).toBe(before);
    expect(exec).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(harness.mock.operationEvents).toEqual([]);
  });

  it("validate passes with every action's permission declared", () => {
    const declared = new Set(
      (manifest.contributes?.permissions ?? []).map((p) => p.name),
    );
    const ops = manifest.contributes!.operations!;
    for (const a of ops.actions!) {
      const short = a.permission.replace(/^coolify\./, "");
      expect(declared.has(short), `${a.id} needs ${a.permission}`).toBe(true);
    }
    expect(validateManifest(manifest)).toEqual([]);
    const errors: string[] = [];
    checkOperationReferences(
      ops,
      manifest.capabilities ?? [],
      (name) => declared.has(name.replace(/^coolify\./, "")),
      errors,
    );
    expect(errors).toEqual([]);
  });
});
