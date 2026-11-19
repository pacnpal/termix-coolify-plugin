import { afterEach, describe, expect, it } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import {
  manifest,
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists, SECRET } from "../helpers/resources.js";
import { withRunHistory } from "../helpers/run-history.js";

const TOKEN = "fake-token-resource-ops";
const READS = ["coolify.list-resources-all", "coolify.resource-get"];

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start() {
  const fake = healthyCoolify(resourceLists());
  harness = await startPlugin({ fetch: fake.fetch, serve: false });
  const runs = withRunHistory(harness.mock);
  const created = await runs.run("coolify.connection-create", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: TOKEN,
  });
  const id = String((created.data as { id: number }).id);
  return { harness, fake, runs, id };
}

function declared(id: string): OperationAction {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id)!;
}

describe("resource operations", () => {
  it("are server-scope reads offered to the assistant and MCP", () => {
    for (const id of READS) {
      const action = declared(id);
      expect(action, id).toBeTruthy();
      expect(action.scope).toBe("server");
      expect(action.risk).toBe("read");
      expect(action.permission).toBe("view");
      expect(action.surfaces).toMatchObject({ assistant: true, mcp: true });
      const input = action.inputs!.find((f) => f.key === "connectionId");
      expect(input).toMatchObject({
        type: "select",
        optionsFrom: "coolify.list-connections",
        required: true,
      });
    }
    expect(
      declared("coolify.resource-get").inputs!.find((f) => f.key === "uuid"),
    ).toMatchObject({ type: "string", required: true });
  });

  it("list-resources-all returns stripped rows and counts, with no secret in run history", async () => {
    const { runs, id } = await start();
    const outcome = await runs.run("coolify.list-resources-all", {
      connectionId: id,
    });
    const data = outcome.data as {
      rows: { uuid: string; parentUuid: string | null }[];
      counts: Record<string, number>;
    };
    expect(data.rows).toHaveLength(13);
    expect(data.rows.filter((r) => r.parentUuid)).toHaveLength(5);
    expect(data.counts).toEqual({
      running: 3,
      degraded: 3,
      stopped: 1,
      deploying: 1,
    });
    expect(outcome.summary).toContain("8 resources");
    const recorded = JSON.stringify(runs.history);
    expect(recorded).not.toContain(SECRET);
    expect(recorded).not.toContain(TOKEN);
  });

  it("list-resources-all narrows to one server", async () => {
    const { runs, id } = await start();
    const outcome = await runs.run("coolify.list-resources-all", {
      connectionId: id,
      serverUuid: "srv-edge-uuid",
    });
    expect(
      (outcome.data as { rows: { uuid: string }[] }).rows.map((r) => r.uuid),
    ).toEqual(["app-api-uuid"]);
  });

  it("resource-get returns one stripped row, and refuses an unknown uuid", async () => {
    const { runs, id } = await start();
    const outcome = await runs.run("coolify.resource-get", {
      connectionId: id,
      uuid: "db-main-uuid",
    });
    expect(outcome.data).toMatchObject({
      uuid: "db-main-uuid",
      kind: "database",
      engine: "standalone-postgresql",
    });
    expect(outcome.summary).toContain("main-db");
    expect(JSON.stringify(runs.history)).not.toContain(SECRET);
    await expect(
      runs.run("coolify.resource-get", { connectionId: id, uuid: "nope" }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses another user's connection without calling Coolify", async () => {
    const { harness, fake, runs, id } = await start();
    const before = fake.calls.length;
    harness.mock.setActor(OTHER);
    await expect(
      runs.run("coolify.list-resources-all", { connectionId: id }),
    ).rejects.toThrow(/not found/i);
    await expect(
      runs.run("coolify.resource-get", {
        connectionId: id,
        uuid: "app-web-uuid",
      }),
    ).rejects.toThrow(/not found/i);
    expect(fake.calls.length).toBe(before);
    harness.mock.setActor(OWNER);
  });
});
