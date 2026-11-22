import { afterEach, describe, expect, it } from "vitest";
import { changes, grant, startLifecycle } from "../helpers/lifecycle.js";
import {
  declaredAction as action,
  operationContext as context,
  operationHandler as handler,
  OTHER,
  type PluginHarness,
} from "../helpers/plugin.js";
import {
  dropGrant,
  duringResourceRead,
  KEY_TAIL_LOGS,
  moveTarget,
  PREVIEW_CHANGES,
  previewAnswers,
} from "../helpers/previews.js";
import { withRunHistory } from "../helpers/run-history.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(permissions?: string[]) {
  await harness?.close();
  const started = await startLifecycle({
    permissions,
    overrides: previewAnswers(),
    serve: false,
  });
  harness = started.harness;
  return started;
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

  /** A change's handler input on web. */
  const inputOf = (id: number, change: (typeof PREVIEW_CHANGES)[number]) => ({
    connectionId: String(id),
    uuid: "app-web-uuid",
    ...change.input,
  });

  it("each mutation is refused without coolify.operate, whatever calls it", async () => {
    const { harness, fake, id } = await start(["coolify.view"]);
    for (const change of PREVIEW_CHANGES) {
      await expect(
        handler(harness, change.actionId).run(inputOf(id, change), context()),
        change.actionId,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(changes(fake)).toEqual([]);
  });

  it("each mutation stops before Coolify is asked when cancelled, the target changes or the grant drops", async () => {
    for (const which of ["cancel", "target", "grant"] as const) {
      for (const change of PREVIEW_CHANGES) {
        const { harness: h, fake, id } = await start();
        grant(h, id, OTHER, "operate");
        h.mock.setActor(OTHER);
        const controller = new AbortController();
        // While the application is read, before the change is sent.
        duringResourceRead(fake, () => {
          if (which === "cancel") controller.abort();
          else if (which === "target") moveTarget(h, id);
          else dropGrant(h, OTHER);
        });
        const label = `${which} ${change.actionId}`;
        const run = handler(h, change.actionId).run(
          inputOf(id, change),
          context({ signal: controller.signal }),
        );
        if (which === "cancel") await expect(run, label).rejects.toBeTruthy();
        else {
          await expect(run, label).rejects.toMatchObject({
            code: which === "target" ? "target-changed" : "forbidden",
          });
        }
        expect(changes(fake), label).toEqual([]);
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

  it("coolify.preview-logs masks logs that start inside a private key", async () => {
    const { harness, fake, id } = await start();
    for (const [route, answer] of Object.entries(KEY_TAIL_LOGS)) {
      fake.set(route, answer);
    }
    const outcome = await withRunHistory(harness.mock).run(
      "coolify.preview-logs",
      {
        connectionId: String(id),
        uuid: "app-web-uuid",
        pullRequestId: 42,
        lines: 3,
        confirm: true,
      },
    );
    const text = (outcome.data as { text: string }).text;
    expect(text).toContain("preview ready");
    expect(text).not.toContain("fake-preview-key-body");
  });
});
