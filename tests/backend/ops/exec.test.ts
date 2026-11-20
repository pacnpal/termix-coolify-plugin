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
import {
  EXEC_RATE_PER_MINUTE,
  readExecRequest,
} from "../../../src/backend/containers/exec.js";
import { MAX_LINE } from "../../../src/backend/containers/logs.js";

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
    // Without confirmed it never reaches core.
    expect(run).not.toHaveBeenCalled();
    await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "coolify__exec",
        arguments: { ...args, confirmed: true },
      },
    });
    expect(run.mock.calls[0]).toEqual([
      "coolify.exec",
      expect.objectContaining({ confirmed: true }),
    ]);
  });

  it("timeout capped at 120s", () => {
    for (const [asked, expected] of [
      [999, 120],
      [5, 5],
      [0, 1],
      [undefined, 30],
    ] as const) {
      expect(
        readExecRequest({
          command: "sleep 1",
          ...(asked === undefined ? {} : { timeoutSec: asked }),
        }).timeoutSec,
      ).toBe(expected);
    }
  });

  it("output truncated at 64KB", async () => {
    const big = "a".repeat(70 * 1024);
    const { runs, id } = await start({
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
    ).toBe(64 * 1024);
    // A line longer than 16 KB comes back in pieces, one per line.
    expect(data.stdout).toMatch(/^[a\n]+$/);
    expect(data.truncated).toBe(true);
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
      expect(docker.connect, c.name).not.toHaveBeenCalled();
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

  it("toggling needs coolify.configure, even for the owner", async () => {
    const { h, id, runs, connectionId } = await start({ execEnabled: false });
    vi.spyOn(h.mock.ctx.rbac, "has").mockImplementation(
      async (p) => !/configure$/.test(p),
    );
    await expect(
      runs.run("coolify.connection-set-exec", {
        connectionId: id,
        execEnabled: true,
      }),
    ).rejects.toThrow();
    const res = await h.request("PATCH", `/connections/${id}`, {
      execEnabled: true,
    });
    expect(res.status).toBe(403);
    const row = h.db.sqlite
      .prepare("SELECT exec_enabled FROM p_coolify_connections WHERE id = ?")
      .get(connectionId) as { exec_enabled: number };
    expect(row.exec_enabled).toBe(0);
  });
});

/** The handler as core calls it, with a signal the test controls. */
function handler(h: PluginHarness, signal: AbortSignal) {
  const found = h.mock.operationHandlers.get("coolify.exec")!;
  return (input: Record<string, unknown>) =>
    Promise.resolve(
      found.run(input, { runId: null, dryRun: false, signal, log: () => {} }),
    );
}

function setBaseUrl(h: PluginHarness, connectionId: number) {
  h.db.sqlite
    .prepare(
      "UPDATE p_coolify_connections SET base_url = 'https://other.example.test' WHERE id = ?",
    )
    .run(connectionId);
}

describe("coolify.exec hardening", () => {
  it("over MCP exec is refused without confirmed, before it runs", async () => {
    const { h, id } = await start({
      settings: { allowExec: true, allowMcpChanges: true },
    });
    const run = vi.fn(async () => ({ runId: "r1", status: "success" }));
    const ctx = new Proxy(h.mock.ctx, {
      get: (target, prop) =>
        prop === "operations" ? { run } : Reflect.get(target, prop),
    });
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__exec",
        arguments: { connectionId: id, uuid: WEB, command: "ls" },
      },
    });
    const result = answer!.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).errorCode).toBe(
      "confirm-required",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs over ctx.ssh.connect with the command on stdin only", async () => {
    const { runs, id, docker } = await start();
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "echo $(id); rm -rf /tmp/x",
    });
    expect(outcome.data).toMatchObject({ exitCode: 0, stdout: "hello\n" });
    expect(docker.connect).toHaveBeenCalledWith(HOST_ID, expect.anything());
    expect(docker.channels).toHaveLength(1);
    expect(docker.channels[0].options).toMatchObject({ pty: false });
    const call = execCalls(docker)[0];
    expect(call.command).toBe("docker exec -i web-abc sh -s");
    expect(call.options?.stdin).toBe("echo $(id); rm -rf /tmp/x");
    expect(docker.dispose).toHaveBeenCalled();
  });

  it("a target change before connect ends with target-changed and sends nothing", async () => {
    const { h, id, docker, connectionId } = await start();
    const fallback = docker.exec.getMockImplementation()!;
    // The address changes while docker ps runs, after locate's own check.
    docker.exec.mockImplementation(async (target, command, options) => {
      if (/docker ps /.test(command)) setBaseUrl(h, connectionId);
      return fallback(target, command, options);
    });
    await expect(
      h.mock.ctx.operations.run("coolify.exec", {
        input: { connectionId: id, uuid: WEB, command: "ls" },
      }),
    ).rejects.toThrow(/changed/i);
    expect(docker.connect).not.toHaveBeenCalled();
    expect(execCalls(docker)).toEqual([]);
  });

  it("a target change after connect ends with target-changed before the exec is written", async () => {
    const { h, id, docker, connectionId } = await start();
    const connect = docker.connect.getMockImplementation()!;
    docker.connect.mockImplementation(async (...args) => {
      const opened = await connect(...args);
      setBaseUrl(h, connectionId);
      return opened;
    });
    await expect(
      h.mock.ctx.operations.run("coolify.exec", {
        input: { connectionId: id, uuid: WEB, command: "ls" },
      }),
    ).rejects.toThrow(/changed/i);
    expect(docker.connect).toHaveBeenCalled();
    expect(execCalls(docker)).toEqual([]);
    expect(docker.dispose).toHaveBeenCalled();
  });

  it("the timeout kills the remote process and closes the session", async () => {
    const { runs, id, docker } = await start({
      docker: { exec: () => "hang" },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "sleep 600",
      timeoutSec: 1,
    });
    expect(outcome.data).toMatchObject({ timedOut: true, exitCode: null });
    expect(docker.channels[0].signals).toContain("KILL");
    expect(docker.channels[0].closed).toBe(true);
    expect(docker.dispose).toHaveBeenCalled();
  });

  it("an abort kills the remote process and closes the session", async () => {
    const { h, id, docker } = await start({ docker: { exec: () => "hang" } });
    const abort = new AbortController();
    const running = handler(
      h,
      abort.signal,
    )({ connectionId: id, uuid: WEB, command: "sleep 600", timeoutSec: 60 });
    await vi.waitFor(() => expect(docker.channels).toHaveLength(1));
    abort.abort();
    await expect(running).rejects.toThrow(/cancel/i);
    expect(docker.channels[0].signals).toContain("KILL");
    expect(docker.channels[0].closed).toBe(true);
    expect(docker.dispose).toHaveBeenCalled();
  });

  it("one exec per actor per resource at a time", async () => {
    let hang = true;
    const { h, id, docker } = await start({
      docker: { exec: () => (hang ? "hang" : ran("ok\n")) },
    });
    const abort = new AbortController();
    const first = handler(
      h,
      abort.signal,
    )({ connectionId: id, uuid: WEB, command: "sleep 600", timeoutSec: 60 });
    await vi.waitFor(() => expect(docker.channels).toHaveLength(1));
    await expect(
      h.mock.ctx.operations.run("coolify.exec", {
        input: { connectionId: id, uuid: WEB, command: "ls" },
      }),
    ).rejects.toThrow(/already running/i);
    expect(docker.channels).toHaveLength(1);
    abort.abort();
    await expect(first).rejects.toThrow();
    hang = false;
    const next = await h.mock.ctx.operations.run("coolify.exec", {
      input: { connectionId: id, uuid: WEB, command: "ls" },
    });
    expect(next.data).toMatchObject({ stdout: "ok\n" });
  });

  it("an actor's runs are rate limited", async () => {
    const { h, id, docker } = await start();
    const run = () =>
      h.mock.ctx.operations.run("coolify.exec", {
        input: { connectionId: id, uuid: WEB, command: "ls" },
      });
    for (let i = 0; i < EXEC_RATE_PER_MINUTE; i += 1) await run();
    const before = docker.commands.length;
    await expect(run()).rejects.toThrow(/too many/i);
    expect(docker.commands).toHaveLength(before);
  });

  it("invalidates the resources and server status caches", async () => {
    const { h, id, runs, connectionId } = await start();
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_cache (connection_id, kind, json, fetched_at) VALUES (?, 'servers', '{}', CURRENT_TIMESTAMP)",
      )
      .run(connectionId);
    await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "ls",
    });
    const kinds = (
      h.db.sqlite
        .prepare("SELECT kind FROM p_coolify_cache WHERE connection_id = ?")
        .all(connectionId) as { kind: string }[]
    ).map((r) => r.kind);
    expect(kinds).not.toContain("resources");
    expect(kinds).not.toContain("servers");
  });

  it("the audit holds only lengths and the exit code", async () => {
    const { h, runs, id } = await start({
      docker: { exec: () => ran("out\n", { stderr: "err!\n", code: 3 }) },
    });
    await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "secret-command-text",
    });
    const audit = h.mock.audits.find(
      (a) => a.action === "coolify_container_exec",
    )!;
    expect(JSON.parse(String(audit.details))).toEqual({
      commandLength: "secret-command-text".length,
      stdoutLength: 4,
      stderrLength: 5,
      exitCode: 3,
    });
    expect(JSON.stringify(h.mock.audits)).not.toContain("secret-command-text");
    expect(JSON.stringify(h.mock.audits)).not.toContain("err!");
  });

  it("run history keeps no output; the MCP caller gets it once", async () => {
    const { h, runs, id } = await start({
      docker: {
        exec: () => ran("visible-output\n", { stderr: "warn-text\n" }),
      },
    });
    await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "ls",
    });
    const kept = JSON.stringify(runs.history);
    expect(kept).not.toContain("visible-output");
    expect(kept).not.toContain("warn-text");

    await h.mock.ctx.settings.set("allowMcpChanges", true);
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
    const text = (answer!.result as { content: { text: string }[] }).content[0]
      .text;
    expect(JSON.parse(text).data).toMatchObject({
      stdout: "visible-output\n",
      stderr: "warn-text\n",
    });
  });

  it("output is masked with the connection's own secrets, also in long lines", async () => {
    const token = "fake-token-shell-test";
    const long = `${"x".repeat(MAX_LINE - 10)} DB_PASSWORD=fake-long-line-secret ${"y".repeat(MAX_LINE)}`;
    const { runs, id } = await start({
      docker: { exec: () => ran(`token is ${token}\n${long}\n`) },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "env",
    });
    const text = JSON.stringify(outcome.data);
    expect(text).not.toContain(token);
    expect(text).not.toContain("fake-long-line-secret");
    expect(text).toContain(REDACTED_VALUE);
  });
});

function groupKills(docker: ReturnType<typeof fakeDocker>): string[] {
  return docker.commands.filter((c) => / kill -KILL /.test(c));
}

describe("coolify.exec kills the command's own process group", () => {
  it("a timed-out exec sends the group kill with the marker's pid", async () => {
    const { runs, id, docker } = await start({
      docker: { exec: () => "hang", pgid: 777 },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "sleep 600",
      timeoutSec: 1,
    });
    expect(outcome.data).toMatchObject({ timedOut: true });
    expect(groupKills(docker)).toEqual([
      "docker exec web-abc sh -c 'kill -KILL -777 2>/dev/null || kill -KILL 777'",
    ]);
    // On the same connection, before it is disposed.
    expect(docker.connect).toHaveBeenCalledTimes(1);
    expect(docker.dispose).toHaveBeenCalledTimes(1);
  });

  it("an abort sends the group kill too", async () => {
    const { h, id, docker } = await start({
      docker: { exec: () => "hang", pgid: 778 },
    });
    const abort = new AbortController();
    const running = handler(
      h,
      abort.signal,
    )({ connectionId: id, uuid: WEB, command: "sleep 600", timeoutSec: 60 });
    await vi.waitFor(() => expect(docker.channels).toHaveLength(1));
    abort.abort();
    await expect(running).rejects.toThrow(/cancel/i);
    expect(groupKills(docker)).toEqual([
      "docker exec web-abc sh -c 'kill -KILL -778 2>/dev/null || kill -KILL 778'",
    ]);
    expect(docker.dispose).toHaveBeenCalled();
  });

  it("a command that ends on its own gets no group kill", async () => {
    const { runs, id, docker } = await start();
    await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "ls",
    });
    expect(groupKills(docker)).toEqual([]);
  });

  it("the marker never appears in the output", async () => {
    const { runs, id, docker } = await start();
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "ls",
    });
    const script = (execCalls(docker)[0] as { script?: string }).script ?? "";
    // The new group's leader prints the marker before the command runs.
    const mark = /echo "(\S+ \S+) \$\$"/.exec(script);
    expect(mark).not.toBeNull();
    expect(outcome.data).toMatchObject({ stdout: "hello\n" });
    expect(JSON.stringify(outcome.data)).not.toContain(mark![1]);
  });

  it("the command goes only into a quoted here-document, never argv", async () => {
    const { runs, id, docker } = await start();
    const payload = "echo $(id) 'x' \"y\"";
    await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: payload,
    });
    const call = execCalls(docker)[0] as { command: string; script?: string };
    expect(call.command).toBe("docker exec -i web-abc sh -s");
    expect(call.script).toMatch(/<<'\w+'/);
    expect(call.script).toContain(`\n${payload}\n`);
  });

  it("a marker forged after the real one isn't trusted", async () => {
    const { runs, id, docker } = await start({
      docker: { exec: () => "hang", pgid: 779, forgedPgid: 1 },
    });
    await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "sleep 600",
      timeoutSec: 1,
    });
    expect(groupKills(docker)).toEqual([
      "docker exec web-abc sh -c 'kill -KILL -779 2>/dev/null || kill -KILL 779'",
    ]);
  });

  it("a line before the marker isn't trusted, and no kill is guessed", async () => {
    const { runs, id, docker } = await start({
      docker: {
        exec: () => "hang",
        pgid: 780,
        beforeMarker: "__COOLIFY_EXEC__ forged 1",
      },
    });
    await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "sleep 600",
      timeoutSec: 1,
    });
    // Only the first line on the channel can be the marker.
    expect(groupKills(docker)).toEqual([]);
    expect(docker.dispose).toHaveBeenCalled();
  });
});

describe("coolify.exec review fixes", () => {
  it("masks every private key in a JSON array on one line", async () => {
    const pem = (body: string) =>
      `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const line = JSON.stringify([
      pem("fake-exec-key-one"),
      pem("fake-exec-key-two"),
      pem("fake-exec-key-three"),
    ]);
    const { runs, id } = await start({
      docker: { exec: () => ran(`${line}\n`) },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "cat keys.json",
    });
    expect(JSON.stringify(outcome.data)).not.toMatch(/fake-exec-key/);
  });

  it("a channel open that never answers ends at the timeout and frees the slot", async () => {
    const { h, runs, id, docker } = await start({
      docker: { exec: () => ran("ok\n"), openHang: true },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "ls",
      timeoutSec: 1,
    });
    expect(outcome.data).toMatchObject({ timedOut: true, exitCode: null });
    expect(docker.dispose).toHaveBeenCalled();
    // The channel opens late: it is closed, and nothing is written to it.
    docker.opens[0]();
    const late = docker.channels[0];
    await vi.waitFor(() => expect(late.closed).toBe(true));
    expect(late.signals).toContain("KILL");
    expect(
      (execCalls(docker)[0] as { script?: string }).script,
    ).toBeUndefined();
    // The slot was released.
    void h;
    await expect(
      runs.run("coolify.exec", {
        connectionId: id,
        uuid: WEB,
        command: "ls",
        timeoutSec: 1,
      }),
    ).resolves.toBeTruthy();
  });

  it("a channel open that never answers ends at an abort", async () => {
    const { h, id, docker } = await start({
      docker: { exec: () => ran("ok\n"), openHang: true },
    });
    const abort = new AbortController();
    const running = handler(
      h,
      abort.signal,
    )({ connectionId: id, uuid: WEB, command: "ls", timeoutSec: 60 });
    await vi.waitFor(() => expect(docker.opens).toHaveLength(1));
    abort.abort();
    await expect(running).rejects.toThrow(/cancel/i);
    expect(docker.dispose).toHaveBeenCalled();
  });

  it("a timeout keeps the output received without a newline, still masked", async () => {
    const { runs, id } = await start({
      docker: {
        exec: () => "hang",
        partial: "starting DB_PASSWORD=fake-partial-secret",
      },
    });
    const outcome = await runs.run("coolify.exec", {
      connectionId: id,
      uuid: WEB,
      command: "printf starting; sleep 10",
      timeoutSec: 1,
    });
    const data = outcome.data as { stdout: string; timedOut: boolean };
    expect(data.timedOut).toBe(true);
    expect(data.stdout).toContain("starting");
    expect(data.stdout).not.toContain("fake-partial-secret");
  });

  it("a rejected PATCH leaves execEnabled unchanged", async () => {
    const { h, id, connectionId } = await start({ execEnabled: false });
    const res = await h.request("PATCH", `/connections/${id}`, {
      execEnabled: true,
      baseUrl: "not-a-url",
    });
    expect(res.status).toBe(400);
    const row = h.db.sqlite
      .prepare("SELECT exec_enabled FROM p_coolify_connections WHERE id = ?")
      .get(connectionId) as { exec_enabled: number };
    expect(row.exec_enabled).toBe(0);
    const ok = await h.request("PATCH", `/connections/${id}`, {
      execEnabled: true,
      name: "Renamed",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Renamed", execEnabled: true });
  });
});
