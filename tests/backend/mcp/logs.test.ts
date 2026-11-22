import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { OWNER, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import {
  fakeDocker,
  KEY_TAIL_LOG,
  setSensitive,
  startShell,
} from "../containers/fixtures.js";

type Run = (
  actionId: string,
  options?: PluginOperationInvokeOptions,
) => Promise<PluginOperationOutcome>;

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("logs over MCP", () => {
  it("coolify__logs_tail returns the redacted lines and the run keeps none of them", async () => {
    const started = await startShell();
    harness = started.harness;
    const { fake, connectionId } = started;
    setSensitive(harness, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", {
      json: {
        logs: "first mcp line\nDB_PASSWORD=fake-mcp-pass\nlast mcp line\n",
      },
    });
    const runs = withRunHistory(harness.mock);
    const ctx = withRun(harness.mock.ctx, (id, options) =>
      runs.run(id, options?.input ?? {}),
    );
    harness.mock.setActor(OWNER);
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__logs_tail",
        arguments: {
          connectionId: String(connectionId),
          uuid: "app-web-uuid",
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
    expect(shown).toContain("first mcp line");
    expect(shown).toContain("last mcp line");
    expect(shown).not.toContain("fake-mcp-pass");

    const history = JSON.stringify(runs.history);
    expect(runs.history).toHaveLength(1);
    expect(history).not.toContain("first mcp line");
    expect(history).not.toContain("fake-mcp-pass");
  });

  it("coolify__logs_tail shows no key body when the tail starts inside a key, from Coolify or SSH", async () => {
    const started = await startShell();
    harness = started.harness;
    const { fake, connectionId } = started;
    fake.set("GET /applications/app-web-uuid/logs", {
      json: { logs: KEY_TAIL_LOG },
    });
    fakeDocker(harness, {
      ps: [[/applicationUuid=app-web-uuid/, "web-abc|running||\n"]],
      logs: KEY_TAIL_LOG,
    });
    const runs = withRunHistory(harness.mock);
    const ctx = withRun(harness.mock.ctx, (id, options) =>
      runs.run(id, options?.input ?? {}),
    );
    harness.mock.setActor(OWNER);
    for (const sensitive of [true, false]) {
      setSensitive(harness, connectionId, sensitive);
      const answer = await handleMcp(ctx, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "coolify__logs_tail",
          arguments: {
            connectionId: String(connectionId),
            uuid: "app-web-uuid",
            lines: 4,
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
      expect(shown).toContain(sensitive ? "coolify" : "ssh");
      expect(shown).toContain("after the key");
      expect(shown).not.toContain("fake-snapshot-key-body");
    }
  });
});

describe("Coolify's /logs through the generic API over MCP", () => {
  it("coolify__api_call of a logs read shows no key body when the tail starts inside a key", async () => {
    const started = await startShell({ settings: { allowMcpChanges: true } });
    harness = started.harness;
    const { fake, connectionId } = started;
    setSensitive(harness, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", {
      json: { logs: KEY_TAIL_LOG },
    });
    const runs = withRunHistory(harness.mock);
    const ctx = withRun(harness.mock.ctx, (id, options) =>
      runs.run(id, options?.input ?? {}),
    );
    harness.mock.setActor(OWNER);
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__api_call",
        arguments: {
          connectionId: String(connectionId),
          operationId: "get-application-logs-by-uuid",
          params: JSON.stringify({ uuid: "app-web-uuid" }),
          confirmed: true,
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
    expect(shown).not.toContain("fake-snapshot-key-body");
  });
});
