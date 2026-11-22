import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import {
  deploymentAnswers,
  KEY_BODY,
  keyEntries,
  keyTailEntries,
  logEntry,
} from "../helpers/deployments.js";
import { LIFECYCLE_TOKEN, startLifecycle } from "../helpers/lifecycle.js";
import { OWNER, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";

type Run = (
  actionId: string,
  options?: PluginOperationInvokeOptions,
) => Promise<PluginOperationOutcome>;

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** The plugin's ctx with ctx.operations.run answered by `run`, as core's gate would. */
function withRun(ctx: PluginContext, run: Run): PluginContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "operations") return { ...target.operations, run };
      return Reflect.get(target, prop);
    },
  });
}

describe("build logs over MCP", () => {
  it("coolify__deployment_get answers the redacted log once and the run keeps none of it", async () => {
    const started = await startLifecycle({
      overrides: deploymentAnswers(),
      serve: false,
    });
    harness = started.harness;
    const { fake, id } = started;
    fake.set("GET /deployments/dep-done", {
      json: {
        deployment_uuid: "dep-done",
        status: "finished",
        deployment_url:
          "/project/p/environment/e/application/app-web-uuid/deployment/dep-done",
        logs: JSON.stringify([
          logEntry(1, "first mcp build line"),
          logEntry(2, "DB_PASSWORD=fake-mcp-build-pass"),
          logEntry(
            3,
            `git clone https://x:${LIFECYCLE_TOKEN}@git.example.test`,
          ),
          ...keyEntries(5).map((e) => ({ ...e, hidden: false })),
          logEntry(10, "last mcp build line"),
        ]),
      },
    });
    const runs = withRunHistory(harness.mock);
    const ctx = withRun(harness.mock.ctx, (actionId, options) =>
      runs.run(actionId, options?.input ?? {}),
    );
    harness.mock.setActor(OWNER);
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__deployment_get",
        arguments: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          deploymentUuid: "dep-done",
          confirm: true,
        },
      },
    });
    const result = answer?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    const shown = result.content.map((c) => c.text).join("\n");
    expect(shown).toContain("first mcp build line");
    expect(shown).toContain("last mcp build line");
    expect(shown).not.toContain("fake-mcp-build-pass");
    expect(shown).not.toContain(LIFECYCLE_TOKEN);
    expect(shown).not.toContain(KEY_BODY);
    expect(shown).toContain("after the key");

    expect(runs.history).toHaveLength(1);
    const history = JSON.stringify(runs.history);
    expect(history).not.toContain("first mcp build line");
    expect(history).not.toContain("fake-mcp-build-pass");
  });

  it("coolify__deployment_get masks a build log that starts inside a private key", async () => {
    const started = await startLifecycle({
      overrides: deploymentAnswers(),
      serve: false,
    });
    harness = started.harness;
    const { fake, id } = started;
    fake.set("GET /deployments/dep-done", {
      json: {
        deployment_uuid: "dep-done",
        status: "finished",
        deployment_url:
          "/project/p/environment/e/application/app-web-uuid/deployment/dep-done",
        logs: JSON.stringify(
          keyTailEntries(1).map((e) => ({ ...e, hidden: false })),
        ),
      },
    });
    const runs = withRunHistory(harness.mock);
    const ctx = withRun(harness.mock.ctx, (actionId, options) =>
      runs.run(actionId, options?.input ?? {}),
    );
    harness.mock.setActor(OWNER);
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__deployment_get",
        arguments: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          deploymentUuid: "dep-done",
          confirm: true,
        },
      },
    });
    const result = answer?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    const shown = result.content.map((c) => c.text).join("\n");
    expect(shown).toContain("after the key");
    expect(shown).not.toContain(KEY_BODY);
  });
});
