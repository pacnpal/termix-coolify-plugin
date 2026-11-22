import { afterEach, describe, expect, it } from "vitest";
import type { PluginOperationContext } from "@termix-ssh/plugin-sdk/backend";
import { changes, grant, startLifecycle } from "../helpers/lifecycle.js";
import { manifest, OTHER, type PluginHarness } from "../helpers/plugin.js";
import { previewAnswers } from "../helpers/previews.js";
import { resourceLists } from "../helpers/resources.js";
import { withRunHistory } from "../helpers/run-history.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(permissions?: string[]) {
  const started = await startLifecycle({
    permissions,
    overrides: previewAnswers(),
    serve: false,
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

describe("preview operations", () => {
  it("declares list, create, domains, delete and logs with their risk and permission", () => {
    expect(action("coolify.preview-list")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "view",
      surfaces: { assistant: true, mcp: true },
    });
    expect(action("coolify.preview-create")).toMatchObject({
      scope: "server",
      risk: "change",
      permission: "operate",
      surfaces: { assistant: false, mcp: false },
    });
    expect(action("coolify.preview-domains")).toMatchObject({
      scope: "server",
      risk: "change",
      permission: "operate",
      surfaces: { assistant: false, mcp: false },
    });
    expect(action("coolify.preview-delete")).toMatchObject({
      scope: "server",
      risk: "destructive",
      permission: "operate",
      surfaces: { assistant: false, mcp: false },
    });
    expect(action("coolify.preview-logs")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "operate",
    });
    expect(
      action("coolify.preview-logs")!.outputs!.find((o) => o.key === "text"),
    ).toMatchObject({ sensitive: true });
  });

  it("coolify.preview-list lists an application's previews", async () => {
    const { harness, id } = await start(["coolify.view"]);
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.preview-list",
      { input: { connectionId: String(id), uuid: "app-web-uuid" } },
    );
    const data = outcome.data as { rows: { pullRequestId: number }[] };
    expect(data.rows.map((r) => r.pullRequestId)).toEqual([42, 7]);
    expect(outcome.summary).toContain("2");
  });

  it("each mutation is refused without coolify.operate, whatever calls it", async () => {
    const { harness, fake, id } = await start(["coolify.view"]);
    const base = { connectionId: String(id), uuid: "app-web-uuid" };
    for (const [actionId, input] of [
      ["coolify.preview-create", { ...base, pullRequestId: 51 }],
      ["coolify.preview-delete", { ...base, pullRequestId: 42 }],
      [
        "coolify.preview-domains",
        { ...base, pullRequestId: 42, domains: "https://pr.example.test" },
      ],
    ] as const) {
      await expect(
        handler(harness, actionId).run(input, context()),
        actionId,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(changes(fake)).toEqual([]);
  });

  it("each mutation stops before Coolify is asked once its run is cancelled", async () => {
    const list = (resourceLists()["GET /applications"] as { json: unknown })
      .json;
    for (const [actionId, extra] of [
      ["coolify.preview-create", { pullRequestId: 51 }],
      ["coolify.preview-delete", { pullRequestId: 42 }],
      [
        "coolify.preview-domains",
        { pullRequestId: 42, domains: "https://pr.example.test" },
      ],
    ] as const) {
      const { harness: h, fake, id } = await start();
      const controller = new AbortController();
      // Cancelled while the application is read, before the change is sent.
      fake.set("GET /applications", () => {
        controller.abort();
        return new Response(JSON.stringify(list), {
          headers: { "content-type": "application/json" },
        });
      });
      await expect(
        handler(h, actionId).run(
          { connectionId: String(id), uuid: "app-web-uuid", ...extra },
          context({ signal: controller.signal }),
        ),
        actionId,
      ).rejects.toBeTruthy();
      expect(controller.signal.aborted, actionId).toBe(true);
      expect(changes(fake), actionId).toEqual([]);
      await h.close();
      harness = null;
    }
  });

  it("each mutation stops when the target changes or the grant drops mid-call", async () => {
    const list = (resourceLists()["GET /applications"] as { json: unknown })
      .json;
    for (const change of ["target", "grant"] as const) {
      for (const [actionId, extra] of [
        ["coolify.preview-create", { pullRequestId: 51 }],
        ["coolify.preview-delete", { pullRequestId: 42 }],
        [
          "coolify.preview-domains",
          { pullRequestId: 42, domains: "https://pr.example.test" },
        ],
      ] as const) {
        const { harness: h, fake, id } = await start();
        grant(h, id, OTHER, "operate");
        h.mock.setActor(OTHER);
        fake.set("GET /applications", () => {
          if (change === "target") {
            h.db.sqlite
              .prepare(
                "UPDATE p_coolify_connections SET base_url = ? WHERE id = ?",
              )
              .run("https://other.example.test", id);
          } else {
            h.db.sqlite
              .prepare(
                "UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?",
              )
              .run(OTHER);
          }
          return new Response(JSON.stringify(list), {
            headers: { "content-type": "application/json" },
          });
        });
        await expect(
          handler(h, actionId).run(
            { connectionId: String(id), uuid: "app-web-uuid", ...extra },
            context(),
          ),
          `${change} ${actionId}`,
        ).rejects.toMatchObject({
          code: change === "target" ? "target-changed" : "forbidden",
        });
        expect(changes(fake), `${change} ${actionId}`).toEqual([]);
        await h.close();
        harness = null;
      }
    }
  });

  it("coolify.preview-domains refuses invalid domains before any Coolify call", async () => {
    const { harness, fake, id } = await start();
    const before = fake.calls.length;
    await expect(
      harness.mock.ctx.operations.run("coolify.preview-domains", {
        input: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          pullRequestId: 42,
          domains: "https://bad host.example.test",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fake.calls.length).toBe(before);
  });

  it("coolify.preview-logs needs confirm: true and keeps the log out of run history", async () => {
    const { harness, fake, id } = await start();
    const before = fake.calls.length;
    await expect(
      handler(harness, "coolify.preview-logs").run(
        { connectionId: String(id), uuid: "app-web-uuid", pullRequestId: 42 },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fake.calls.length).toBe(before);

    const runs = withRunHistory(harness.mock);
    const outcome = await runs.run("coolify.preview-logs", {
      connectionId: String(id),
      uuid: "app-web-uuid",
      pullRequestId: 42,
      confirm: true,
    });
    const text = (outcome.data as { text: string }).text;
    expect(text).toContain("preview ready");
    expect(text).not.toContain("fake-preview-pass");
    expect(text).not.toContain("fake-preview-key-body");
    const history = JSON.stringify(runs.history);
    expect(history).not.toContain("preview ready");
    expect(history).not.toContain("fake-preview-pass");
  });
});
