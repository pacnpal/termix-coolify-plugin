import { afterEach, describe, expect, it } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { manifest, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  LOCAL_PRIVATE_MARKER,
  PRIVATE_MARKER,
  startWithConnection,
} from "../sync/fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function declared(id: string): OperationAction {
  const found = manifest.contributes?.operations?.actions?.find(
    (a) => a.id === id,
  );
  if (!found) throw new Error(`${id} is not declared`);
  return found;
}

async function start() {
  const started = await startWithConnection();
  harness = started.harness;
  return {
    ...started,
    runs: withRunHistory(started.harness.mock),
    id: String(started.connectionId),
  };
}

describe("host sync operations", () => {
  it("are declared with the plan's risks and model surfaces only on the read", () => {
    const expected = {
      "coolify.sync-preview": "read",
      "coolify.sync-apply": "change",
      "coolify.unlink": "change",
    } as const;
    for (const [id, risk] of Object.entries(expected)) {
      const action = declared(id);
      expect(action.scope, id).toBe("server");
      expect(action.risk, id).toBe(risk);
      const model = risk === "read";
      expect(action.surfaces?.assistant === true, id).toBe(model);
      expect(action.surfaces?.mcp === true, id).toBe(model);
      expect(
        action.inputs?.find((i) => i.key === "connectionId")?.optionsFrom,
        id,
      ).toBe("coolify.list-connections");
    }
    expect(declared("coolify.sync-preview").permission).toBe("view");
    expect(declared("coolify.sync-apply").permission).toBe("configure");
    expect(declared("coolify.unlink").permission).toBe("configure");
  });

  it("sync-preview returns the same rows as the route", async () => {
    const { harness: h, runs, id } = await start();
    const outcome = await runs.run("coolify.sync-preview", {
      connectionId: id,
    });
    const route = await h.request("GET", `/connections/${id}/servers`);
    expect((outcome.data as { rows: unknown[] }).rows).toEqual(route.body);
    expect(outcome.summary).toContain("4");
  });

  it("sync-apply without choices syncs every server that is ready and reports the rest", async () => {
    const { harness: h, runs, id } = await start();
    const outcome = await runs.run("coolify.sync-apply", { connectionId: id });
    const results = (outcome.data as { results: any[] }).results;
    const status = Object.fromEntries(
      results.map((r) => [r.uuid, r.cause ?? r.status]),
    );
    expect(status).toEqual({
      "srv-web1": "created",
      "srv-web2": "created",
      "srv-local": "needs-address",
      "srv-vps1": "needs-tunnel-support",
    });
    expect(outcome.changed).toBe(true);
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(2);
  });

  it("sync-apply takes choices as JSON", async () => {
    const { harness: h, runs, id } = await start();
    await runs.run("coolify.sync-apply", {
      connectionId: id,
      choices: JSON.stringify([
        { uuid: "srv-local", include: true, addressOverride: "10.0.0.2" },
      ]),
    });
    const hosts = await h.mock.ctx.hosts.listOwned();
    expect(hosts.map((x) => x.ip)).toEqual(["10.0.0.2"]);
  });

  it("unlink makes the host ordinary and keeps it", async () => {
    const { harness: h, runs, id } = await start();
    await runs.run("coolify.sync-apply", { connectionId: id });
    const outcome = await runs.run("coolify.unlink", {
      connectionId: id,
      serverUuid: "srv-web1",
    });
    expect(outcome.changed).toBe(true);
    const hostId = (outcome.data as { hostId: number }).hostId;
    expect(h.mock.hostLockProviders[0].isLocked(hostId)).toBe(false);
    expect(await h.mock.ctx.hosts.listOwned()).toHaveLength(2);
  });

  it("no private key reaches run history", async () => {
    const { harness: h, runs, id } = await start();
    await runs.run("coolify.sync-preview", { connectionId: id });
    await runs.run("coolify.sync-apply", {
      connectionId: id,
      choices: [
        { uuid: "srv-web1", include: true },
        { uuid: "srv-local", include: true, addressOverride: "10.0.0.2" },
      ],
    });
    await runs.run("coolify.unlink", {
      connectionId: id,
      serverUuid: "srv-web1",
    });
    expect(h.mock.createdSshKeys).toHaveLength(2);
    const history = JSON.stringify(runs.history);
    for (const marker of [
      PRIVATE_MARKER,
      LOCAL_PRIVATE_MARKER,
      "PRIVATE KEY",
    ]) {
      expect(history).not.toContain(marker);
    }
  });
});
