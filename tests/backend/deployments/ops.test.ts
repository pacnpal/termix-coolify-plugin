import { afterEach, describe, expect, it } from "vitest";
import {
  deploymentAnswers,
  deploymentRaw,
  KEY_BODY,
  keyEntries,
  keyTailDeployment,
} from "../helpers/deployments.js";
import type { FakeAnswer } from "../helpers/fake-coolify.js";
import { expectKeyTailMasked } from "../helpers/key-tail.js";
import { changes, startLifecycle } from "../helpers/lifecycle.js";
import {
  declaredAction as action,
  operationContext as context,
  operationHandler as handler,
  type PluginHarness,
} from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(permissions?: string[]) {
  const started = await startLifecycle({
    permissions,
    overrides: deploymentAnswers(),
    serve: false,
  });
  harness = started.harness;
  return started;
}

describe("deployment operations", () => {
  it("declares list, get and cancel with their permissions and surfaces", () => {
    expect(action("coolify.deployment-list")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "view",
      surfaces: { assistant: true, mcp: true },
    });
    expect(action("coolify.deployment-get")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "operate",
      surfaces: { assistant: true, mcp: true },
    });
    expect(
      action("coolify.deployment-get")!.outputs!.find((o) => o.key === "text"),
    ).toMatchObject({ sensitive: true });
    expect(action("coolify.deployment-cancel")).toMatchObject({
      scope: "server",
      risk: "destructive",
      permission: "operate",
      surfaces: { assistant: false, mcp: false },
    });
  });

  it("coolify.deployment-list pages through a resource's history", async () => {
    const { harness, fake, id } = await start();
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.deployment-list",
      { input: { connectionId: String(id), uuid: "app-web-uuid", skip: 3 } },
    );
    const data = outcome.data as { rows: { uuid: string }[]; count: number };
    expect(data.count).toBe(23);
    expect(data.rows.map((r) => r.uuid)).toEqual([
      "dep-run",
      "dep-done",
      "dep-failed",
    ]);
    expect(outcome.summary).toContain("23");
    expect(fake.calls.map((c) => c.url)).toContain(
      "https://coolify.example.test/api/v1/deployments/applications/app-web-uuid?skip=3&take=10",
    );
  });

  it("coolify.deployment-get keeps the log out of run history and hides hidden lines unless asked", async () => {
    const { harness, id } = await start();
    const runs = withRunHistory(harness.mock);
    const input = {
      connectionId: String(id),
      uuid: "app-web-uuid",
      deploymentUuid: "dep-run",
      confirm: true,
    };
    const plain = await runs.run("coolify.deployment-get", input);
    const data = plain.data as { text: string; deployment: { status: string } };
    expect(data.deployment.status).toBe("in_progress");
    expect(data.text).toContain("Starting deployment");
    expect(data.text).not.toContain("docker build");
    expect(data.text).not.toContain("fake-build-pass");
    const all = await runs.run("coolify.deployment-get", {
      ...input,
      showHidden: true,
    });
    expect((all.data as { text: string }).text).toContain("docker build");
    const history = JSON.stringify(runs.history);
    expect(history).not.toContain("Starting deployment");
    expect(history).not.toContain("fake-build-pass");
  });

  it.each([
    [
      "a private key printed across several entries",
      (): [string, FakeAnswer] => [
        "GET /deployments/dep-done",
        {
          json: deploymentRaw("dep-done", "finished", {
            entries: keyEntries(1),
          }),
        },
      ],
    ],
    ["a build log that starts inside a private key", keyTailDeployment],
  ])("coolify.deployment-get masks %s", async (_name, answer) => {
    const { harness, fake, id } = await start();
    fake.set(...answer());
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.deployment-get",
      {
        input: {
          connectionId: String(id),
          deploymentUuid: "dep-done",
          showHidden: true,
          confirm: true,
        },
      },
    );
    expectKeyTailMasked((outcome.data as { text: string }).text);
    expectKeyTailMasked(outcome);
    expect(JSON.stringify(outcome)).not.toContain(KEY_BODY);
  });

  it("coolify.deployment-get needs confirm: true, since logs hold secrets", async () => {
    const { harness, fake, id } = await start();
    const before = fake.calls.length;
    await expect(
      handler(harness, "coolify.deployment-get").run(
        { connectionId: String(id), deploymentUuid: "dep-run" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fake.calls.length).toBe(before);
  });

  it("finds a deployment's application itself when no uuid is given", async () => {
    const { harness, id } = await start();
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.deployment-get",
      {
        input: {
          connectionId: String(id),
          deploymentUuid: "dep-done",
          confirm: true,
        },
      },
    );
    expect(outcome.data).toMatchObject({ final: true, cancellable: false });
    await expect(
      harness.mock.ctx.operations.run("coolify.deployment-get", {
        input: {
          connectionId: String(id),
          deploymentUuid: "dep-elsewhere",
          confirm: true,
        },
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("coolify.deployment-cancel is refused without coolify.operate, whatever calls it", async () => {
    const { harness, fake, id } = await start(["coolify.view"]);
    await expect(
      handler(harness, "coolify.deployment-cancel").run(
        { connectionId: String(id), deploymentUuid: "dep-run" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(changes(fake)).toEqual([]);
  });

  it("coolify.deployment-cancel stops before Coolify is asked once its run is cancelled", async () => {
    const { harness, fake, id } = await start();
    const controller = new AbortController();
    fake.set("GET /deployments/dep-run", () => {
      controller.abort();
      return new Response(
        JSON.stringify(deploymentRaw("dep-run", "in_progress")),
        { headers: { "content-type": "application/json" } },
      );
    });
    await expect(
      handler(harness, "coolify.deployment-cancel").run(
        { connectionId: String(id), deploymentUuid: "dep-run" },
        context({ signal: controller.signal }),
      ),
    ).rejects.toBeTruthy();
    expect(changes(fake)).toEqual([]);
  });

  it("coolify.deployment-cancel cancels and says what Coolify answered", async () => {
    const { harness, fake, id } = await start();
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.deployment-cancel",
      {
        input: { connectionId: String(id), deploymentUuid: "dep-run" },
        confirmed: true,
      },
    );
    expect(outcome).toMatchObject({
      changed: true,
      data: { deploymentUuid: "dep-run", status: "cancelled-by-user" },
    });
    expect(changes(fake).map((c) => c.path)).toEqual([
      "/deployments/dep-run/cancel",
    ]);
  });
});
