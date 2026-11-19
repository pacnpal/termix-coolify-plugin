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
import { withRunHistory } from "../helpers/run-history.js";

const TOKEN = "fake-token-ops-test";
const NEW_TOKEN = "fake-token-ops-rotated";
const CF_ID = "fake-cf-id-ops-test";
const CF_SECRET = "fake-cf-secret-ops-test";
const SECRETS = [TOKEN, NEW_TOKEN, CF_ID, CF_SECRET];

const CONNECTION_OPS = [
  "coolify.list-connections",
  "coolify.connection-probe",
  "coolify.connection-create",
  "coolify.connection-update",
  "coolify.connection-delete",
];

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start() {
  const fake = healthyCoolify();
  harness = await startPlugin({ fetch: fake.fetch, serve: false });
  return { harness, fake, runs: withRunHistory(harness.mock) };
}

function declared(id: string): OperationAction {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id)!;
}

function rawToken(h: PluginHarness): string {
  const row = h.db.sqlite
    .prepare("SELECT token_sealed FROM p_coolify_connections")
    .get() as { token_sealed: string };
  return row.token_sealed;
}

describe("connection operations", () => {
  it("are declared at server scope, with secret inputs and model surfaces only on reads", () => {
    for (const id of CONNECTION_OPS) {
      const action = declared(id);
      expect(action, id).toBeTruthy();
      expect(action.scope).toBe("server");
      const model = action.risk === "read";
      expect(action.surfaces?.assistant === true, id).toBe(model);
      expect(action.surfaces?.mcp === true, id).toBe(model);
    }
    expect(declared("coolify.connection-delete").risk).toBe("destructive");
    for (const id of [
      "coolify.connection-create",
      "coolify.connection-update",
    ]) {
      const types = Object.fromEntries(
        declared(id).inputs!.map((f) => [f.key, f.type]),
      );
      expect(types).toMatchObject({
        token: "secret",
        cfAccessId: "secret",
        cfAccessSecret: "secret",
      });
    }
    for (const id of [
      "coolify.connection-probe",
      "coolify.connection-update",
      "coolify.connection-delete",
    ]) {
      const input = declared(id).inputs!.find((f) => f.key === "connectionId");
      expect(input?.optionsFrom).toBe("coolify.list-connections");
      expect(input?.required).toBe(true);
    }
  });

  it("registers a handler for every declared action", async () => {
    const { harness } = await start();
    const ids = manifest.contributes!.operations!.actions!.map((a) => a.id);
    expect([...harness.mock.operationHandlers.keys()].sort()).toEqual(
      [...ids].sort(),
    );
  });

  it("connection-create over the operation stores the token sealed and never echoes it in data or summary", async () => {
    const { harness, runs } = await start();
    const outcome = await runs.run("coolify.connection-create", {
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
      cfAccessId: CF_ID,
      cfAccessSecret: CF_SECRET,
    });
    expect(outcome.summary).toContain("Prod");
    expect(outcome.data).toMatchObject({ name: "Prod", version: "v4.7.5" });
    const answer = JSON.stringify(outcome);
    for (const secret of SECRETS) expect(answer).not.toContain(secret);
    const sealed = rawToken(harness);
    expect(sealed).not.toBe(TOKEN);
    expect(sealed).not.toContain(TOKEN);
    expect(await harness.mock.ctx.secrets.unseal(sealed)).toBe(TOKEN);
  });

  it("secret inputs never appear in operation run history", async () => {
    const { runs } = await start();
    const created = await runs.run("coolify.connection-create", {
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
      cfAccessId: CF_ID,
      cfAccessSecret: CF_SECRET,
    });
    const id = String((created.data as { id: number }).id);
    await runs.run("coolify.connection-update", {
      connectionId: id,
      token: NEW_TOKEN,
      cfAccessSecret: CF_SECRET,
    });
    await runs.run("coolify.connection-probe", { connectionId: id });
    await runs.run("coolify.list-connections");
    await runs.run("coolify.connection-delete", { connectionId: id });
    expect(runs.history).toHaveLength(5);
    const stored = JSON.stringify(runs.history);
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
    expect(runs.history[0].input).toMatchObject({ token: "[redacted]" });
  });

  it("refuses inputs it does not declare", async () => {
    const { runs } = await start();
    await expect(
      runs.run("coolify.connection-create", {
        name: "Prod",
        baseUrl: "https://coolify.example.test",
        token: TOKEN,
        userId: OTHER,
      }),
    ).rejects.toThrow(/not an input/);
  });

  it("list-connections fills the connection choices", async () => {
    const { runs } = await start();
    const created = await runs.run("coolify.connection-create", {
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
    });
    const list = await runs.run("coolify.list-connections");
    const id = (created.data as { id: number }).id;
    expect(list.data).toMatchObject({
      options: [{ value: String(id), label: "Prod" }],
      rows: [{ id, name: "Prod" }],
    });
  });

  it("connection-update with an empty token keeps the stored one", async () => {
    const { harness, runs } = await start();
    const created = await runs.run("coolify.connection-create", {
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
    });
    const before = rawToken(harness);
    const id = String((created.data as { id: number }).id);
    const updated = await runs.run("coolify.connection-update", {
      connectionId: id,
      name: "Renamed",
      token: "",
    });
    expect((updated.data as { name: string }).name).toBe("Renamed");
    expect(rawToken(harness)).toBe(before);
  });

  it("connection-probe and connection-delete act on the owner's connection", async () => {
    const { harness, runs } = await start();
    const created = await runs.run("coolify.connection-create", {
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
    });
    const id = String((created.data as { id: number }).id);
    const probed = await runs.run("coolify.connection-probe", {
      connectionId: id,
    });
    expect(probed.data).toMatchObject({ probe: { ok: true } });
    const removed = await runs.run("coolify.connection-delete", {
      connectionId: id,
      removeHosts: false,
    });
    expect(removed.changed).toBe(true);
    expect(removed.summary).toContain("Prod");
    expect(
      harness.db.sqlite.prepare("SELECT id FROM p_coolify_connections").all(),
    ).toEqual([]);
  });

  it("another user's connection answers 404", async () => {
    const { harness, runs } = await start();
    const created = await runs.run("coolify.connection-create", {
      name: "Prod",
      baseUrl: "https://coolify.example.test",
      token: TOKEN,
    });
    const id = String((created.data as { id: number }).id);
    harness.mock.setActor(OTHER);
    for (const [op, input] of [
      ["coolify.connection-probe", { connectionId: id }],
      ["coolify.connection-update", { connectionId: id, name: "x" }],
      ["coolify.connection-delete", { connectionId: id }],
    ] as [string, Record<string, unknown>][]) {
      await expect(runs.run(op, input), op).rejects.toMatchObject({
        status: 404,
      });
    }
    const list = await runs.run("coolify.list-connections");
    expect(list.data).toMatchObject({ options: [], rows: [] });
    harness.mock.setActor(OWNER);
    expect(
      harness.db.sqlite.prepare("SELECT name FROM p_coolify_connections").all(),
    ).toEqual([{ name: "Prod" }]);
  });
});
