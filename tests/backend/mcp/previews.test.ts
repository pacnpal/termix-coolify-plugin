import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import {
  changes,
  LIFECYCLE_TOKEN,
  startLifecycle,
} from "../helpers/lifecycle.js";
import { OWNER, type PluginHarness } from "../helpers/plugin.js";
import { previewAnswers } from "../helpers/previews.js";
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

async function start() {
  const started = await startLifecycle({
    overrides: previewAnswers(),
    settings: { allowMcpChanges: true },
    serve: false,
  });
  harness = started.harness;
  harness.mock.setActor(OWNER);
  return started;
}

async function call(
  ctx: PluginContext,
  name: string,
  args: Record<string, unknown>,
) {
  const answer = await handleMcp(ctx, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return answer?.result as { isError: boolean; content: { text: string }[] };
}

describe("previews over MCP", () => {
  it("coolify__preview_logs answers the redacted logs once and the run keeps none of it", async () => {
    const { harness, id } = await start();
    const runs = withRunHistory(harness.mock);
    const ctx = withRun(harness.mock.ctx, (actionId, options) =>
      runs.run(actionId, options?.input ?? {}),
    );
    const result = await call(ctx, "coolify__preview_logs", {
      connectionId: String(id),
      uuid: "app-web-uuid",
      pullRequestId: 42,
      confirm: true,
    });
    expect(result.isError).toBe(false);
    const shown = result.content.map((c) => c.text).join("\n");
    expect(shown).toContain("preview listening on 3000");
    expect(shown).toContain("preview ready");
    expect(shown).not.toContain("fake-preview-pass");
    expect(shown).not.toContain("fake-preview-key-body");
    expect(shown).not.toContain(LIFECYCLE_TOKEN);
    expect(runs.history).toHaveLength(1);
    const history = JSON.stringify(runs.history);
    expect(history).not.toContain("preview ready");
    expect(history).not.toContain("fake-preview-pass");
  });

  it("create and domain changes need confirmed: true, before core is asked", async () => {
    const { harness, fake, id } = await start();
    const asked: string[] = [];
    const ctx = withRun(harness.mock.ctx, async (actionId, options) => {
      asked.push(actionId);
      return harness.mock.ctx.operations.run(actionId, options);
    });
    const base = { connectionId: String(id), uuid: "app-web-uuid" };
    for (const [name, args] of [
      ["coolify__preview_create", { ...base, pullRequestId: 51 }],
      [
        "coolify__preview_domains",
        { ...base, pullRequestId: 42, domains: "https://pr-42.example.test" },
      ],
    ] as const) {
      const refused = await call(ctx, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.content[0].text, name).toContain("confirm-required");
    }
    expect(asked).toEqual([]);
    expect(changes(fake)).toEqual([]);

    const made = await call(ctx, "coolify__preview_create", {
      ...base,
      pullRequestId: 51,
      confirmed: true,
    });
    expect(made.isError).toBe(false);
    expect(changes(fake).map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /applications/app-web-uuid/previews",
    ]);
  });

  it("delete is destructive: it reaches core confirmed only when the caller said so", async () => {
    const { harness, id } = await start();
    const seen: PluginOperationInvokeOptions[] = [];
    const ctx = withRun(harness.mock.ctx, async (_actionId, options) => {
      seen.push(options ?? {});
      return { runId: "run-1", status: "waiting-approval", approvalId: "a1" };
    });
    const base = {
      connectionId: String(id),
      uuid: "app-web-uuid",
      pullRequestId: 42,
    };
    await call(ctx, "coolify__preview_delete", base);
    await call(ctx, "coolify__preview_delete", { ...base, confirmed: true });
    expect(seen.map((o) => o.confirmed === true)).toEqual([false, true]);
    const listed = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tool = (
      listed?.result as {
        tools: { name: string; annotations: { destructiveHint: boolean } }[];
      }
    ).tools.find((t) => t.name === "coolify__preview_delete");
    expect(tool?.annotations.destructiveHint).toBe(true);
  });
});
