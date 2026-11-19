import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import {
  manifest,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import {
  EXTRA_TOOLS,
  MAX_DATA_CHARS,
  MCP_CHANGES_EXEMPT,
  handleMcp,
  mcpChangesRefused,
  toolName,
} from "../../../src/backend/mcp/server.js";

const TOKEN = "fake-token-mcp-test";
const ACTIONS = manifest.contributes!.operations!.actions!;
const LIST_TOOLS = ["list_connections", "list_hosts", "list_resources"];
const EXTRA = [...LIST_TOOLS, "take_status_page_url"];

type Run = (
  actionId: string,
  options?: PluginOperationInvokeOptions,
) => Promise<PluginOperationOutcome>;

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  vi.restoreAllMocks();
});

async function start(settings: Record<string, unknown> = {}) {
  const fake = healthyCoolify();
  harness = await startPlugin({ fetch: fake.fetch, serve: false, settings });
  return { harness, fake, ctx: harness.mock.ctx };
}

/** The plugin's ctx with ctx.operations.run answered by `run`, as core's gate would. */
function withRun(ctx: PluginContext, run: Run): PluginContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "operations") return { run };
      return Reflect.get(target, prop);
    },
  });
}

function call(id: number, name: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function textOf(answer: Record<string, unknown> | null): string {
  const result = answer?.result as { content: { text: string }[] };
  return result.content[0].text;
}

function parsed(answer: Record<string, unknown> | null): any {
  return JSON.parse(textOf(answer));
}

function isError(answer: Record<string, unknown> | null): boolean {
  return (answer?.result as { isError: boolean }).isError;
}

describe("the MCP endpoint", () => {
  it("initialize names the server termix-coolify and offers tools", async () => {
    const { ctx } = await start();
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        serverInfo: { name: "termix-coolify" },
        capabilities: { tools: {} },
      },
    });
  });

  it("ping answers an empty result", async () => {
    const { ctx } = await start();
    expect(
      await handleMcp(ctx, { jsonrpc: "2.0", id: "p", method: "ping" }),
    ).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  it("tools/list lists one tool per declared coolify operation plus the three list tools", async () => {
    const { ctx } = await start();
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (answer!.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    const expected = [
      ...ACTIONS.map((a) => "coolify__" + a.id.slice("coolify.".length)),
      ...EXTRA,
    ]
      .map((n) => n.replace(/[.-]/g, "_"))
      .sort();
    expect(names).toEqual(expected);
    expect(new Set(names).size).toBe(names.length);
    expect(toolName("coolify.connection-probe")).toBe(
      "coolify__connection_probe",
    );
    expect(EXTRA_TOOLS.map((t) => t.name).sort()).toEqual([...EXTRA].sort());
  });

  it("read tool annotations set readOnlyHint, destructive set destructiveHint", async () => {
    const { ctx } = await start();
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const tools = (
      answer!.result as {
        tools: {
          name: string;
          description: string;
          inputSchema: { type: string; properties: Record<string, unknown> };
          annotations: { readOnlyHint: boolean; destructiveHint: boolean };
        }[];
      }
    ).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const action of ACTIONS) {
      const tool = byName.get(toolName(action.id))!;
      expect(tool.annotations.readOnlyHint, action.id).toBe(
        action.risk === "read",
      );
      expect(tool.annotations.destructiveHint, action.id).toBe(
        action.risk === "destructive",
      );
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
      for (const field of action.inputs ?? []) {
        expect(
          tool.inputSchema.properties,
          `${action.id} ${field.key}`,
        ).toHaveProperty(field.key);
      }
    }
    for (const name of LIST_TOOLS) {
      expect(byName.get(name)!.annotations.readOnlyHint).toBe(true);
    }
    const create = byName.get("coolify__connection_create")!;
    expect(create.inputSchema).toMatchObject({
      required: expect.arrayContaining(["name", "baseUrl", "token"]),
    });
  });

  it("tools/call runs through ctx.operations.run with via mcp", async () => {
    const { ctx } = await start();
    const run = vi.fn<Run>(async () => ({
      runId: "run-1",
      status: "success",
      summary: "Prod: Coolify v4.7.5 answered",
      data: { probe: { ok: true } },
    }));
    const answer = await handleMcp(
      withRun(ctx, run),
      call(4, "coolify__connection_probe", { connectionId: "7" }),
    );
    expect(run).toHaveBeenCalledWith("coolify.connection-probe", {
      input: { connectionId: "7" },
      dryRun: false,
      via: "mcp",
    });
    expect(isError(answer)).toBe(false);
    expect(parsed(answer)).toEqual({
      status: "success",
      summary: "Prod: Coolify v4.7.5 answered",
      data: { probe: { ok: true } },
    });
  });

  it("change and destructive tools refuse with mcp-changes-off unless allowMcpChanges is on", async () => {
    const { ctx } = await start({ allowMcpChanges: false });
    const run = vi.fn<Run>(async () => ({ runId: "r", status: "success" }));
    for (const action of ACTIONS.filter((a) => a.risk !== "read")) {
      const answer = await handleMcp(
        withRun(ctx, run),
        call(5, toolName(action.id), { connectionId: "1" }),
      );
      expect(isError(answer), action.id).toBe(true);
      expect(parsed(answer)).toMatchObject({
        status: "refused",
        errorCode: "mcp-changes-off",
      });
    }
    expect(run).not.toHaveBeenCalled();
    // Reads always work.
    await handleMcp(withRun(ctx, run), call(6, "coolify__list_connections"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("with allowMcpChanges on, a change tool runs, and connection-create never echoes the token", async () => {
    const { ctx, harness } = await start({ allowMcpChanges: true });
    const answer = await handleMcp(
      ctx,
      call(7, "coolify__connection_create", {
        name: "Prod",
        baseUrl: "https://coolify.example.test",
        token: TOKEN,
      }),
    );
    expect(isError(answer)).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(parsed(answer).data).toMatchObject({ name: "Prod" });
    const row = harness.db.sqlite
      .prepare("SELECT token_sealed FROM p_coolify_connections")
      .get() as { token_sealed: string };
    expect(row.token_sealed).not.toContain(TOKEN);
  });

  it("mcpChangesRefused lets an exempt change through and the exemption list names only declared changes", () => {
    const update = ACTIONS.find((a) => a.id === "coolify.connection-update")!;
    const probe = ACTIONS.find((a) => a.id === "coolify.connection-probe")!;
    expect(mcpChangesRefused(update, false)).toBe(true);
    expect(mcpChangesRefused(update, true)).toBe(false);
    expect(mcpChangesRefused(probe, false)).toBe(false);
    expect(mcpChangesRefused(update, false, [update.id])).toBe(false);
    for (const id of MCP_CHANGES_EXEMPT) {
      const action = ACTIONS.find((a) => a.id === id);
      expect(action, id).toBeTruthy();
      expect(action!.risk, id).not.toBe("read");
    }
  });

  it("destructive tools pass confirmed only when the client sets it", async () => {
    const { ctx } = await start({ allowMcpChanges: true });
    const run = vi.fn<Run>(async () => ({ runId: "r", status: "success" }));
    await handleMcp(
      withRun(ctx, run),
      call(8, "coolify__connection_delete", {
        connectionId: "1",
        confirmed: true,
      }),
    );
    expect(run).toHaveBeenLastCalledWith("coolify.connection-delete", {
      input: { connectionId: "1" },
      dryRun: false,
      confirmed: true,
      via: "mcp",
    });
  });

  it("operations:read key cannot call a change tool: the gate refuses and the answer is isError", async () => {
    const { ctx } = await start({ allowMcpChanges: true });
    const refused = vi.fn<Run>(async () => ({
      runId: null,
      status: "denied",
      error: "This API key may only run read actions",
      errorCode: "key-scope",
    }));
    const answer = await handleMcp(
      withRun(ctx, refused),
      call(9, "coolify__connection_update", {
        connectionId: "1",
        name: "x",
      }),
    );
    expect(refused).toHaveBeenCalled();
    expect(isError(answer)).toBe(true);
    expect(parsed(answer)).toMatchObject({
      status: "denied",
      errorCode: "key-scope",
    });

    const thrown = vi.fn<Run>(async () => {
      throw Object.assign(new Error("Forbidden by key scope"), {
        code: "forbidden",
      });
    });
    const second = await handleMcp(
      withRun(ctx, thrown),
      call(10, "coolify__connection_update", { connectionId: "1" }),
    );
    expect(isError(second)).toBe(true);
    expect(textOf(second)).toContain("Forbidden by key scope");
  });

  it("pending approval returns run id text", async () => {
    const { ctx } = await start({ allowMcpChanges: true });
    const run = vi.fn<Run>(async () => ({
      runId: "run-awaiting-42",
      status: "awaiting_approval",
      approvalId: "approval-9",
    }));
    const answer = await handleMcp(
      withRun(ctx, run),
      call(11, "coolify__connection_update", { connectionId: "1" }),
    );
    expect(isError(answer)).toBe(false);
    expect(textOf(answer)).toContain("run-awaiting-42");
    expect(textOf(answer).toLowerCase()).toContain("approval");
  });

  it("output is redacted at any depth and truncated with a note", async () => {
    const { ctx } = await start();
    const big = Array.from({ length: 400 }, (_, i) => ({
      uuid: `u-${i}`,
      env: [{ key: "DB_URL", value: `fake-env-value-${i}` }],
      deep: { nested: { password: `fake-password-${i}` } },
    }));
    const run = vi.fn<Run>(async () => ({
      runId: "r",
      status: "success",
      summary: "many",
      data: { rows: big },
    }));
    const answer = await handleMcp(
      withRun(ctx, run),
      call(12, "coolify__connection_probe", { connectionId: "1" }),
    );
    const text = textOf(answer);
    expect(text).not.toMatch(/fake-env-value|fake-password/);
    const body = JSON.parse(text);
    expect(typeof body.data).toBe("string");
    expect(body.data.length).toBe(MAX_DATA_CHARS);
    expect(body.data).toContain(REDACTED_VALUE);
    expect(body.note).toMatch(/8,?000/);

    const small = vi.fn<Run>(async () => ({
      runId: "r",
      status: "success",
      data: { a: { b: [{ c: { token: "fake-token-deep" } }] } },
    }));
    const smallAnswer = await handleMcp(
      withRun(ctx, small),
      call(13, "coolify__connection_probe", { connectionId: "1" }),
    );
    expect(parsed(smallAnswer).data).toEqual({
      a: { b: [{ c: { token: REDACTED_VALUE } }] },
    });
    expect(parsed(smallAnswer).note).toBeUndefined();
  });

  it("unknown method -32601, notification gets no reply", async () => {
    const { ctx } = await start();
    expect(
      await handleMcp(ctx, {
        jsonrpc: "2.0",
        id: 14,
        method: "resources/list",
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 14,
      error: { code: -32601, message: expect.any(String) },
    });
    expect(
      await handleMcp(ctx, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeNull();
    const run = vi.fn<Run>();
    expect(
      await handleMcp(withRun(ctx, run), {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "coolify__list_connections", arguments: {} },
      }),
    ).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("an unknown tool or bad arguments answer -32602", async () => {
    const { ctx } = await start();
    expect(await handleMcp(ctx, call(15, "coolify__nope"))).toMatchObject({
      error: { code: -32602 },
    });
    expect(
      await handleMcp(ctx, {
        jsonrpc: "2.0",
        id: 16,
        method: "tools/call",
        params: { name: "coolify__list_connections", arguments: [] },
      }),
    ).toMatchObject({ error: { code: -32602 } });
  });

  it("list_connections runs the list action over mcp and returns rows without secrets", async () => {
    const { ctx } = await start({ allowMcpChanges: true });
    await handleMcp(
      ctx,
      call(17, "coolify__connection_create", {
        name: "Prod",
        baseUrl: "https://coolify.example.test",
        token: TOKEN,
      }),
    );
    const answer = await handleMcp(ctx, call(18, "list_connections"));
    expect(isError(answer)).toBe(false);
    const body = parsed(answer);
    expect(body.data.rows).toMatchObject([{ name: "Prod" }]);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it("list_hosts and list_resources answer empty lists without calling Coolify or hosts", async () => {
    const { ctx, fake } = await start();
    const run = vi.fn<Run>();
    const before = fake.calls.length;
    for (const name of ["list_hosts", "list_resources"]) {
      const answer = await handleMcp(withRun(ctx, run), call(19, name));
      expect(isError(answer), name).toBe(false);
      expect(parsed(answer).data.rows, name).toEqual([]);
    }
    expect(run).not.toHaveBeenCalled();
    expect(fake.calls.length).toBe(before);
  });

  it("refuses a message that is not JSON-RPC 2.0 with -32600", async () => {
    const { ctx } = await start();
    expect(
      await handleMcp(ctx, { jsonrpc: "1.0", id: 20, method: "ping" } as never),
    ).toMatchObject({ id: 20, error: { code: -32600 } });
  });
});
