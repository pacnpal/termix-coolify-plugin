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
import { fakeDocker, HOST_ID, startShell } from "../containers/fixtures.js";

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
