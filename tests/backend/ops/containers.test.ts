import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import {
  manifest,
  OTHER,
  OWNER,
  type PluginHarness,
} from "../helpers/plugin.js";
import { SECRET } from "../helpers/resources.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  fakeDocker,
  HOST_ID,
  setSensitive,
  startShell,
} from "../containers/fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start() {
  const started = await startShell();
  harness = started.harness;
  const runs = withRunHistory(started.harness.mock);
  return { ...started, runs, id: String(started.connectionId) };
}

function declared(id: string): OperationAction {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id)!;
}

describe("shell-command operation", () => {
  it("is a server-scope read for the assistant and MCP that needs coolify.operate", () => {
    const action = declared("coolify.shell-command");
    expect(action).toBeTruthy();
    expect(action.scope).toBe("server");
    expect(action.risk).toBe("read");
    expect(action.permission).toBe("operate");
    expect(action.surfaces).toMatchObject({ assistant: true, mcp: true });
    const keys = action.inputs!.map((f) => f.key);
    expect(keys).toEqual([
      "connectionId",
      "uuid",
      "part",
      "container",
      "console",
    ]);
    expect(action.inputs!.find((f) => f.key === "connectionId")).toMatchObject({
      type: "select",
      optionsFrom: "coolify.list-connections",
      required: true,
    });
    expect(action.inputs!.find((f) => f.key === "uuid")).toMatchObject({
      required: true,
    });
  });

  it("returns the exact docker exec command", async () => {
    const { runs, id, harness: h } = await start();
    fakeDocker(h, {
      ps: [[/databaseUuid=db-main-uuid/, "db-main-uuid|running||\n"]],
    });
    const outcome = await runs.run("coolify.shell-command", {
      connectionId: id,
      uuid: "db-main-uuid",
      console: "db",
    });
    expect(outcome.data).toEqual({
      hostId: HOST_ID,
      container: "db-main-uuid",
      command: `docker exec -it db-main-uuid sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" "$POSTGRES_DB"'`,
    });
    expect(JSON.stringify(runs.history)).not.toContain(SECRET);
  });

  it("answers choices when several containers match", async () => {
    const { runs, id, harness: h } = await start();
    fakeDocker(h, {
      ps: [
        [
          /serviceUuid=svc-n8n-uuid/,
          "n8n-a|running|part-n8n-uuid|n8n\npg-a|running|part-postgres-uuid|postgresql\n",
        ],
      ],
    });
    const outcome = await runs.run("coolify.shell-command", {
      connectionId: id,
      uuid: "svc-n8n-uuid",
    });
    expect(outcome.data).toEqual({
      choices: [
        { name: "n8n-a", running: true, part: "part-n8n-uuid" },
        { name: "pg-a", running: true, part: "part-postgres-uuid" },
      ],
    });
  });

  it("shell-command refuses a host the actor can't open", async () => {
    const { runs, id, harness: h } = await start();
    const docker = fakeDocker(h, {
      ps: [[/applicationUuid=app-web-uuid/, "web-abc|running||\n"]],
    });
    vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    await expect(
      runs.run("coolify.shell-command", {
        connectionId: id,
        uuid: "app-web-uuid",
      }),
    ).rejects.toThrow(/can't open/i);
    expect(docker.commands).toEqual([]);
  });

  it("refuses a uuid that isn't one of the connection's resources, and another user's connection", async () => {
    const { runs, id, harness: h } = await start();
    const docker = fakeDocker(h, {
      ps: [[/applicationUuid=/, "web-abc|running||\n"]],
    });
    await expect(
      runs.run("coolify.shell-command", {
        connectionId: id,
        uuid: "app-elsewhere",
      }),
    ).rejects.toThrow(/not found/i);
    h.mock.setActor(OTHER);
    await expect(
      runs.run("coolify.shell-command", {
        connectionId: id,
        uuid: "app-web-uuid",
      }),
    ).rejects.toThrow(/not found/i);
    h.mock.setActor(OWNER);
    expect(docker.commands).toEqual([]);
  });

  it("refuses a container name outside the allowed set", async () => {
    const { runs, id, harness: h } = await start();
    const docker = fakeDocker(h, {
      ps: [[/applicationUuid=app-web-uuid/, "web-abc|running||\n"]],
    });
    await expect(
      runs.run("coolify.shell-command", {
        connectionId: id,
        uuid: "app-web-uuid",
        container: "web-abc;reboot",
      }),
    ).rejects.toThrow();
    expect(docker.commands).toEqual([]);
  });
});

describe("logs-tail operation", () => {
  const WEB: [RegExp, string] = [
    /applicationUuid=app-web-uuid/,
    "web-abc|running||\n",
  ];

  it("is a server-scope read with a sensitive text output that needs coolify.operate", () => {
    const action = declared("coolify.logs-tail");
    expect(action).toBeTruthy();
    expect(action.scope).toBe("server");
    expect(action.risk).toBe("read");
    expect(action.permission).toBe("operate");
    expect(action.surfaces).toMatchObject({ assistant: true, mcp: true });
    expect(action.inputs!.map((f) => f.key)).toEqual([
      "connectionId",
      "uuid",
      "part",
      "container",
      "lines",
      "timestamps",
      "confirm",
    ]);
    expect(action.inputs!.find((f) => f.key === "confirm")).toMatchObject({
      type: "boolean",
      required: true,
    });
    expect(action.inputs!.find((f) => f.key === "lines")).toMatchObject({
      type: "number",
      min: 1,
      max: 10000,
    });
    expect(action.outputs!.find((f) => f.key === "text")).toMatchObject({
      sensitive: true,
    });
  });

  it("logs-tail matches the route", async () => {
    const { runs, id, harness: h, fake, connectionId } = await start();
    fake.set("GET /applications/app-web-uuid/logs", {
      json: { logs: "c1\nc2\n" },
    });
    fakeDocker(h, { ps: [WEB], logs: "s1\ns2\n" });
    for (const sensitive of [true, false]) {
      setSensitive(h, connectionId, sensitive);
      const route = await h.request(
        "GET",
        `/connections/${connectionId}/resources/app-web-uuid/logs?lines=20&timestamps=true`,
      );
      expect(route.status).toBe(200);
      const outcome = await runs.run("coolify.logs-tail", {
        connectionId: id,
        uuid: "app-web-uuid",
        lines: 20,
        timestamps: true,
        confirm: true,
      });
      // Plus the handoffId the MCP answer takes the text by.
      const { handoffId, ...data } = outcome.data as Record<string, unknown>;
      expect(typeof handoffId).toBe("string");
      expect(data).toEqual(route.body);
      expect(route.body.source).toBe(sensitive ? "coolify" : "ssh");
    }
    // The text is a sensitive output: run history never keeps it.
    // (Matched as whole lines: a random handoffId can hold "c1".)
    const history = JSON.stringify(runs.history);
    for (const line of ["c1\\n", "c2\\n", "s1\\n", "s2\\n"]) {
      expect(history).not.toContain(line);
    }
  });

  it("logs-tail reads nothing without confirm: true (MCP and ops alike)", async () => {
    const { runs, id, harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", { json: { logs: "c1\n" } });
    const docker = fakeDocker(h, { ps: [WEB], logs: "s1\n" });
    const before = fake.calls.filter((c) => c.path.endsWith("/logs")).length;
    for (const confirm of [undefined, false]) {
      await expect(
        runs.run("coolify.logs-tail", {
          connectionId: id,
          uuid: "app-web-uuid",
          ...(confirm === undefined ? {} : { confirm }),
        }),
      ).rejects.toThrow(/confirm/i);
    }
    expect(fake.calls.filter((c) => c.path.endsWith("/logs")).length).toBe(
      before,
    );
    expect(docker.commands).toEqual([]);
  });

  it("logs-tail aborted while it locates the container stops before docker logs", async () => {
    const { id, harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB], logs: "s1\n" });
    const abort = new AbortController();
    const reason = new Error("cancelled");
    const answer = docker.exec.getMockImplementation()!;
    docker.exec.mockImplementation(async (...args) => {
      const out = await answer(...args);
      if (/docker ps /.test(args[1])) abort.abort(reason);
      return out;
    });
    const handler = h.mock.operationHandlers.get("coolify.logs-tail")!;
    await expect(
      Promise.resolve(
        handler.run(
          { connectionId: id, uuid: "app-web-uuid", confirm: true },
          { runId: "r1", dryRun: false, signal: abort.signal, log: () => {} },
        ),
      ),
    ).rejects.toBe(reason);
    expect(docker.commands.some((c) => /docker ps /.test(c))).toBe(true);
    expect(docker.commands.some((c) => /docker logs /.test(c))).toBe(false);
  });

  it("logs-tail answers choices and refuses another user's connection", async () => {
    const { runs, id, harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, {
      ps: [
        [
          /serviceUuid=svc-n8n-uuid/,
          "n8n-a|running|part-n8n-uuid|n8n\npg-a|running|part-postgres-uuid|postgresql\n",
        ],
      ],
    });
    const outcome = await runs.run("coolify.logs-tail", {
      connectionId: id,
      uuid: "svc-n8n-uuid",
      confirm: true,
    });
    expect(outcome.data).toMatchObject({
      choices: [{ name: "n8n-a" }, { name: "pg-a" }],
    });
    const ran = docker.commands.length;
    h.mock.setActor(OTHER);
    await expect(
      runs.run("coolify.logs-tail", {
        connectionId: id,
        uuid: "app-web-uuid",
        confirm: true,
      }),
    ).rejects.toThrow(/not found/i);
    h.mock.setActor(OWNER);
    expect(docker.commands.length).toBe(ran);
  });
});
