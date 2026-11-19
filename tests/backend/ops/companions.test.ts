import { afterEach, describe, expect, it } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { manifest, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { DB_PASSWORD, TOKEN, startCompanions } from "../companions/fixtures.js";

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

function kinds(id: string): string[] {
  return (
    declared(id)
      .inputs?.find((i) => i.key === "kind")
      ?.options?.map((o) => o.value) ?? []
  );
}

async function start() {
  const started = await startCompanions();
  harness = started.harness;
  return {
    ...started,
    runs: withRunHistory(started.harness.mock),
    id: String(started.connectionId),
  };
}

describe("companion operations", () => {
  it("are declared as a read and a change, with model surfaces only on the read", () => {
    const read = declared("coolify.companion-read");
    expect(read.risk).toBe("read");
    expect(read.permission).toBe("view");
    expect(read.surfaces?.assistant).toBe(true);
    expect(read.surfaces?.mcp).toBe(true);
    const change = declared("coolify.companion");
    expect(change.risk).toBe("change");
    expect(change.permission).toBe("operate");
    expect(change.surfaces?.assistant).toBe(false);
    expect(change.surfaces?.mcp).toBe(false);
    for (const action of [read, change]) {
      expect(action.scope).toBe("server");
      expect(
        action.inputs?.find((i) => i.key === "connectionId")?.optionsFrom,
      ).toBe("coolify.list-connections");
    }
  });

  it("every companion route has a companion or companion-read kind", () => {
    expect(kinds("coolify.companion-read").sort()).toEqual(
      [
        "companions",
        "uptime",
        "log-search",
        "security",
        "db-login",
        "db-logins",
        "backups-failed",
        "host-metrics",
        "dns-list",
      ].sort(),
    );
    expect(kinds("coolify.companion").sort()).toEqual(
      ["dns", "dns-remove", "uptime-pause", "uptime-resume"].sort(),
    );
  });

  it("security, db-login and backups-failed answer the same through companion-read as their routes", async () => {
    const { harness: h, runs, id } = await start();
    const cases = [
      {
        kind: "security",
        params: { serverUuid: "srv-web1" },
        path: `/connections/${id}/servers/srv-web1/security`,
      },
      {
        kind: "db-login",
        params: { uuid: "db-main-uuid" },
        path: `/connections/${id}/resources/db-main-uuid/db-login`,
      },
      {
        kind: "backups-failed",
        params: { serverUuid: "srv-web1" },
        path: `/connections/${id}/servers/srv-web1/backups-failed`,
      },
      {
        kind: "host-metrics",
        params: { serverUuid: "srv-web1" },
        path: `/connections/${id}/servers/srv-web1/host-metrics`,
      },
      {
        kind: "uptime",
        params: { uuid: "app-web-uuid" },
        path: `/connections/${id}/resources/app-web-uuid/uptime`,
      },
      { kind: "companions", params: {}, path: "/companions" },
    ];
    for (const c of cases) {
      const outcome = await runs.run("coolify.companion-read", {
        connectionId: id,
        kind: c.kind,
        params: c.params,
      });
      const route = await h.request("GET", c.path);
      expect(outcome.data, c.kind).toEqual(route.body);
      expect(outcome.summary, c.kind).toBeTruthy();
    }
    const history = JSON.stringify(runs.history);
    expect(history).not.toContain(DB_PASSWORD);
    expect(history).not.toContain(TOKEN);
  });

  it("log-search through companion-read uses source docker and the uuid", async () => {
    const { runs, id, companions } = await start();
    const outcome = await runs.run("coolify.companion-read", {
      connectionId: id,
      kind: "log-search",
      params: { uuid: "app-web-uuid" },
    });
    expect(
      companions.calls.find((c) => c.name === "log-search.search")?.args[0],
    ).toEqual({ source: "docker", query: "app-web-uuid", limit: 200 });
    expect((outcome.data as { source: string }).source).toBe("docker");
  });

  it("dns and dns-remove store and remove a handle; an unknown one is refused", async () => {
    const { runs, id, companions } = await start();
    const made = await runs.run("coolify.companion", {
      connectionId: id,
      kind: "dns",
      params: { uuid: "app-web-uuid", fqdn: "a.example.test" },
    });
    expect(made.changed).toBe(true);
    const recordId = (made.data as { id: number }).id;
    await expect(
      runs.run("coolify.companion", {
        connectionId: id,
        kind: "dns-remove",
        params: { uuid: "app-web-uuid", recordId: recordId + 100 },
      }),
    ).rejects.toThrow(/no dns record/i);
    const removed = await runs.run("coolify.companion", {
      connectionId: id,
      kind: "dns-remove",
      params: { uuid: "app-web-uuid", recordId },
    });
    expect(removed.data).toEqual({ id: recordId, removed: true });
    expect(
      companions.calls.filter((c) => c.name === "dns.delete-record"),
    ).toHaveLength(1);
  });

  it("uptime-pause and uptime-resume run uptime.pause and uptime.resume for the resource's monitors", async () => {
    const { runs, id, companions } = await start();
    const paused = await runs.run("coolify.companion", {
      connectionId: id,
      kind: "uptime-pause",
      params: { uuid: "app-web-uuid" },
    });
    expect(paused.data).toEqual({ monitors: ["mon-a", "mon-b"] });
    await runs.run("coolify.companion", {
      connectionId: id,
      kind: "uptime-resume",
      params: { uuid: "app-web-uuid" },
    });
    const invoked = companions.calls
      .filter((c) => c.name.startsWith("uptime."))
      .filter((c) => c.name !== "uptime.monitors")
      .map((c) => [c.name, c.args[0]]);
    expect(invoked).toEqual([
      // The reference's input for both is `monitor`.
      ["uptime.pause", { monitor: "mon-a" }],
      ["uptime.pause", { monitor: "mon-b" }],
      ["uptime.resume", { monitor: "mon-a" }],
      ["uptime.resume", { monitor: "mon-b" }],
    ]);
  });

  it("refuses a kind that isn't declared", async () => {
    const { runs, id } = await start();
    await expect(
      runs.run("coolify.companion-read", {
        connectionId: id,
        kind: "dns",
        params: {},
      }),
    ).rejects.toThrow();
  });
});
