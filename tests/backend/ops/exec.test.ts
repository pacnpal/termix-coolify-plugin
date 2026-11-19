import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSshExecResult } from "@termix-ssh/plugin-sdk/backend";
import {
  REDACTED_VALUE,
  type OperationAction,
} from "@termix-ssh/plugin-sdk/operations";
import {
  manifest,
  OTHER,
  OWNER,
  type PluginHarness,
} from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  fakeDocker,
  HOST_ID,
  startShell,
  type DockerHost,
} from "../containers/fixtures.js";
import {
  handleMcp,
  MCP_CHANGES_EXEMPT,
} from "../../../src/backend/mcp/server.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const WEB = "app-web-uuid";
const ON = { allowExec: true };

function ran(stdout: string, extra: Partial<PluginSshExecResult> = {}) {
  return {
    stdout,
    stderr: "",
    code: 0,
    truncated: false,
    timedOut: false,
    ...extra,
  };
}

function declared(id: string): OperationAction {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id)!;
}

/**
 * A connection whose server srv-vps1-uuid is Linked, one running container
 * for app-web-uuid, the admin settings given and execEnabled as given.
 */
async function start(
  options: {
    settings?: Record<string, unknown>;
    execEnabled?: boolean;
    permissions?: string[];
    docker?: DockerHost;
  } = {},
) {
  const started = await startShell({
    settings: options.settings ?? ON,
    permissions: options.permissions,
  });
  harness = started.harness;
  const h = started.harness;
  const id = String(started.connectionId);
  if (options.execEnabled !== false) {
    h.db.sqlite
      .prepare("UPDATE p_coolify_connections SET exec_enabled = 1 WHERE id = ?")
      .run(started.connectionId);
  }
  const docker = fakeDocker(h, {
    ps: [[/applicationUuid=app-web-uuid/, "web-abc|running||\n"]],
    exec: () => ran("hello\n"),
    ...options.docker,
  });
  const runs = withRunHistory(h.mock);
  return { h, id, docker, runs, connectionId: started.connectionId };
}

function execCalls(docker: ReturnType<typeof fakeDocker>) {
  return docker.calls.filter((c) => /docker exec -i /.test(c.command));
}

describe("coolify.exec", () => {
  it("is a destructive server action that needs coolify.operate, off the assistant and MCP surfaces", () => {
    // hostAccess doesn't apply to a server-scope action, so the handler
    // checks edit access to the Linked host itself (see below).
    const action = declared("coolify.exec");
    expect(action).toBeTruthy();
    expect(action.scope).toBe("server");
    expect(action.risk).toBe("destructive");
    expect(action.permission).toBe("operate");
    expect(action.timeoutMs).toBeGreaterThanOrEqual(120_000);
    expect(action.surfaces).toMatchObject({ assistant: false, mcp: false });
    expect(action.inputs!.map((f) => f.key)).toEqual([
      "connectionId",
      "uuid",
      "part",
      "container",
      "command",
      "timeoutSec",
    ]);
    expect(action.inputs!.find((f) => f.key === "command")).toMatchObject({
      type: "secret",
      required: true,
    });
    expect(action.inputs!.find((f) => f.key === "timeoutSec")).toMatchObject({
      type: "number",
      min: 1,
      max: 120,
    });
  });

  it("exec refused unless both allowExec and execEnabled", async () => {
    const cases: Array<{
      settings: Record<string, unknown>;
      execEnabled: boolean;
      error: RegExp;
    }> = [
      { settings: {}, execEnabled: true, error: /turned off by an admin/i },
      {
        settings: { allowExec: false },
        execEnabled: true,
        error: /turned off by an admin/i,
      },
      {
        settings: ON,
        execEnabled: false,
        error: /owner hasn't allowed/i,
      },
      { settings: {}, execEnabled: false, error: /turned off by an admin/i },
    ];
    for (const c of cases) {
      const { runs, id, docker, h } = await start(c);
      await expect(
        runs.run("coolify.exec", {
          connectionId: id,
          uuid: WEB,
          command: "ls",
        }),
      ).rejects.toThrow(c.error);
      expect(docker.commands).toEqual([]);
      await h.close();
      harness = null;
    }
    const { runs, id, docker } = await start();
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "ls",
    });
    expect(outcome.data).toMatchObject({
      hostId: HOST_ID,
      container: "web-abc",
      exitCode: 0,
      stdout: "hello\n",
    });
    expect(execCalls(docker)).toHaveLength(1);
  });

  it("exec needs host edit and confirm", async () => {
    // Core asks a person to confirm every destructive action before the
    // handler runs; MCP passes confirmed only when the caller set it.
    expect(declared("coolify.exec").risk).toBe("destructive");

    const { runs, id, docker, h } = await start();
    const access = vi
      .spyOn(h.mock.ctx.hosts, "checkAccess")
      .mockImplementation(async (_hostId, level) =>
        level === "edit"
          ? { hasAccess: false, isOwner: false, isShared: true }
          : {
              hasAccess: true,
              isOwner: false,
              isShared: true,
              permissionLevel: "connect",
            },
      );
    await expect(
      runs.run("coolify.exec", { connectionId: id, uuid: WEB, command: "ls" }),
    ).rejects.toThrow(/edit access/i);
    expect(access).toHaveBeenCalledWith(HOST_ID, "edit");
    expect(docker.commands).toEqual([]);

    const run = vi.fn(async () => ({ runId: "r1", status: "success" }));
    const ctx = new Proxy(h.mock.ctx, {
      get: (target, prop) =>
        prop === "operations" ? { run } : Reflect.get(target, prop),
    });
    await h.mock.ctx.settings.set("allowMcpChanges", true);
    const args = { connectionId: id, uuid: WEB, command: "ls" };
    await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "coolify__exec", arguments: args },
    });
    expect(run.mock.calls[0]).toEqual([
      "coolify.exec",
      expect.not.objectContaining({ confirmed: true }),
    ]);
    await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "coolify__exec",
        arguments: { ...args, confirmed: true },
      },
    });
    expect(run.mock.calls[1]).toEqual([
      "coolify.exec",
      expect.objectContaining({ confirmed: true }),
    ]);
  });

  it("timeout capped at 120s", async () => {
    const { h, id, docker } = await start();
    for (const [asked, expected] of [
      [999, 120_000],
      [5, 5_000],
      [undefined, 30_000],
    ] as const) {
      await h.mock.ctx.operations.run("coolify.exec", {
        input: {
          connectionId: id,
          uuid: WEB,
          command: "sleep 1",
          ...(asked === undefined ? {} : { timeoutSec: asked }),
        },
      });
      expect(execCalls(docker).at(-1)!.options?.timeoutMs).toBe(expected);
    }
  });

  it("output truncated at 64KB", async () => {
    const big = "a".repeat(70 * 1024);
    const { runs, id, docker } = await start({
      docker: { exec: () => ran(big, { stderr: "warning\n" }) },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "cat big",
    });
    const data = outcome.data as {
      stdout: string;
      stderr: string;
      truncated: boolean;
    };
    expect(
      Buffer.byteLength(data.stdout) + Buffer.byteLength(data.stderr),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(data.stdout).toBe("a".repeat(64 * 1024));
    expect(data.truncated).toBe(true);
    expect(execCalls(docker)[0].options?.maxOutputBytes).toBe(64 * 1024);
  });

  it("command is passed quoted or on stdin, never interpolated", async () => {
    const { runs, id, docker, h } = await start();
    for (const payload of ["ls; rm -rf /", "echo $(id)", "x' ; reboot ; '"]) {
      await runs.run("coolify.exec", {
        connectionId: id,
        uuid: WEB,
        command: payload,
      });
      const call = execCalls(docker).at(-1)!;
      expect(call.command).toBe("docker exec -i web-abc sh -s");
      expect(call.command).not.toContain(payload);
      expect(call.options?.stdin).toBe(payload);
      for (const c of docker.commands) {
        expect(c).not.toContain("rm -rf");
        expect(c).not.toContain("$(id)");
      }
    }
    // The audit line records the length, never the text.
    const audits = h.mock.audits.filter(
      (a) => a.action === "coolify_container_exec",
    );
    expect(audits).toHaveLength(3);
    expect(JSON.parse(String(audits[0].details))).toMatchObject({
      commandLength: "ls; rm -rf /".length,
    });
    expect(JSON.stringify(audits)).not.toContain("rm -rf");
    expect(JSON.stringify(audits)).not.toContain("$(id)");
  });

  it("exec command is a secret input and never appears in run history", async () => {
    const command = "PGPASSWORD=fake-pg-history-test psql -c 'select 1'";
    const { runs, id, docker, h } = await start();
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command,
    });
    // The handler still gets the command, on stdin.
    expect(execCalls(docker)[0].options?.stdin).toBe(command);
    expect(outcome.status).toBe("success");
    expect(runs.history).toHaveLength(1);
    const kept = JSON.stringify(runs.history);
    expect(kept).not.toContain("fake-pg-history-test");
    expect(kept).not.toContain("psql");
    expect((runs.history[0].input as Record<string, unknown>).command).toBe(
      REDACTED_VALUE,
    );

    // MCP clients still send it as a plain string, never echoed back.
    const listed = await handleMcp(h.mock.ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (
      listed!.result as {
        tools: {
          name: string;
          inputSchema: { properties: Record<string, unknown> };
        }[];
      }
    ).tools;
    const schema = tools.find((t) => t.name === "coolify__exec")!.inputSchema;
    expect(schema.properties.command).toMatchObject({
      type: "string",
      writeOnly: true,
    });
  });

  it("output is redacted", async () => {
    const env = [
      "PATH=/usr/local/bin:/usr/bin",
      "POSTGRES_PASSWORD=fake-pass-exec-test",
      "export API_TOKEN=fake-token-exec-test",
      '{"client_secret": "fake-json-secret-exec-test", "name": "web"}',
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "fake-key-body-exec-test",
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n");
    const { runs, id } = await start({
      docker: {
        exec: () => ran(env, { stderr: "DB_PASSWORD: fake-stderr-exec-test" }),
      },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "env",
    });
    const text = JSON.stringify(outcome);
    for (const secret of [
      "fake-pass-exec-test",
      "fake-token-exec-test",
      "fake-json-secret-exec-test",
      "fake-key-body-exec-test",
      "fake-stderr-exec-test",
    ]) {
      expect(text).not.toContain(secret);
    }
    const data = outcome.data as { stdout: string };
    expect(data.stdout).toContain("PATH=/usr/local/bin:/usr/bin");
    expect(data.stdout).toContain(`POSTGRES_PASSWORD=${REDACTED_VALUE}`);
    expect(data.stdout).toContain('"name": "web"');
  });

  it("over MCP exec is refused without allowMcpChanges", async () => {
    expect(MCP_CHANGES_EXEMPT).not.toContain("coolify.exec");
    const { h, id, docker } = await start({
      settings: { allowExec: true, allowMcpChanges: false },
    });
    const answer = await handleMcp(h.mock.ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__exec",
        arguments: {
          connectionId: id,
          uuid: WEB,
          command: "ls",
          confirmed: true,
        },
      },
    });
    const result = answer!.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).errorCode).toBe(
      "mcp-changes-off",
    );
    expect(docker.commands).toEqual([]);
  });

  it("no SSH call happens on any refusal", async () => {
    const base = { uuid: WEB, command: "ls" };
    const cases: Array<{
      name: string;
      start?: Parameters<typeof start>[0];
      prepare?: (h: PluginHarness) => void;
      input?: Record<string, unknown>;
      as?: string;
    }> = [
      { name: "allowExec off", start: { settings: {} } },
      { name: "execEnabled off", start: { execEnabled: false } },
      {
        name: "no coolify.operate",
        prepare: (h) => {
          vi.spyOn(h.mock.ctx.rbac, "has").mockImplementation(
            async (p) => p !== "operate",
          );
        },
      },
      {
        name: "permissions can't be read",
        prepare: (h) => {
          vi.spyOn(h.mock.ctx.rbac, "has").mockRejectedValue(
            new Error("rbac down"),
          );
        },
      },
      {
        name: "settings can't be read",
        prepare: (h) => {
          vi.spyOn(h.mock.ctx.settings, "get").mockRejectedValue(
            new Error("settings store down"),
          );
        },
      },
      {
        name: "host access can't be read",
        prepare: (h) => {
          vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockRejectedValue(
            new Error("hosts down"),
          );
        },
      },
      {
        name: "no host edit",
        prepare: (h) => {
          vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
            hasAccess: false,
            isOwner: false,
            isShared: false,
          });
        },
      },
      {
        name: "server not linked",
        prepare: (h) => {
          h.db.sqlite.prepare("DELETE FROM p_coolify_servers").run();
        },
      },
      { name: "another user's connection", as: OTHER },
      { name: "unknown resource", input: { uuid: "app-elsewhere" } },
      { name: "empty command", input: { command: "   " } },
      { name: "bad container", input: { container: "web;reboot" } },
    ];
    for (const c of cases) {
      const { h, id, docker } = await start(c.start);
      c.prepare?.(h);
      if (c.as) h.mock.setActor(c.as);
      await expect(
        h.mock.ctx.operations.run("coolify.exec", {
          input: { connectionId: id, ...base, ...c.input },
        }),
        c.name,
      ).rejects.toThrow();
      h.mock.setActor(OWNER);
      expect(docker.commands, c.name).toEqual([]);
      vi.restoreAllMocks();
      await h.close();
      harness = null;
    }
  });
});

describe("coolify.connection-set-exec", () => {
  it("is a change action that needs coolify.configure", () => {
    const action = declared("coolify.connection-set-exec");
    expect(action).toBeTruthy();
    expect(action.risk).toBe("change");
    expect(action.permission).toBe("configure");
    expect(action.inputs!.map((f) => f.key)).toEqual([
      "connectionId",
      "execEnabled",
    ]);
  });

  it("only the owner toggles execEnabled", async () => {
    const { h, id, runs, connectionId } = await start({ execEnabled: false });
    const flag = () =>
      (
        h.db.sqlite
          .prepare(
            "SELECT exec_enabled FROM p_coolify_connections WHERE id = ?",
          )
          .get(connectionId) as { exec_enabled: number }
      ).exec_enabled;

    const outcome = await runs.run("coolify.connection-set-exec", {
      connectionId: id,
      execEnabled: true,
    });
    expect(outcome.data).toMatchObject({ id: connectionId, execEnabled: true });
    expect(flag()).toBe(1);
    expect(
      h.mock.audits.some((a) => a.action === "coolify_exec_setting_changed"),
    ).toBe(true);

    // A grantee at the highest grant level is still refused, by the action
    // and by the route.
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level, created_at) VALUES (?, ?, 'configure', CURRENT_TIMESTAMP)",
      )
      .run(connectionId, OTHER);
    h.mock.setActor(OTHER);
    await expect(
      runs.run("coolify.connection-set-exec", {
        connectionId: id,
        execEnabled: false,
      }),
    ).rejects.toThrow(/only the owner/i);
    h.mock.setActor(OWNER);
    const refused = await h.request(
      "PATCH",
      `/connections/${id}`,
      { execEnabled: false },
      OTHER,
    );
    expect(refused.status).toBe(403);
    expect(flag()).toBe(1);

    // The grantee sees the flag but can't change it; the owner can, by route.
    const seen = await h.request("GET", `/connections/${id}`, undefined, OTHER);
    expect(seen.body.execEnabled).toBe(true);
    const off = await h.request("PATCH", `/connections/${id}`, {
      execEnabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.execEnabled).toBe(false);
    expect(flag()).toBe(0);

    const bad = await h.request("PATCH", `/connections/${id}`, {
      execEnabled: "yes",
    });
    expect(bad.status).toBe(400);
  });
});
