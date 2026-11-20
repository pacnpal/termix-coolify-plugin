import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { manifest, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  DB_PASSWORD,
  TOKEN,
  changeTarget,
  startCompanions,
} from "../companions/fixtures.js";

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
      ["dns", "uptime-pause", "uptime-resume"].sort(),
    );
    // Removing a DNS record is its own destructive action.
    expect(declared("coolify.companion-dns-remove")).toBeDefined();
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

  it("dns-remove is a destructive action with confirm", async () => {
    const action = declared("coolify.companion-dns-remove");
    expect(action.risk).toBe("destructive");
    expect(action.permission).toBe("configure");
    expect(action.scope).toBe("server");
    expect(action.surfaces?.assistant).toBe(false);
    expect(action.surfaces?.mcp).toBe(false);
    expect(action.inputs?.map((i) => i.key)).toEqual([
      "connectionId",
      "uuid",
      "recordId",
    ]);

    const { harness: h, runs, id, companions } = await start();
    const invoke = vi.spyOn(h.mock.ctx.operations, "invoke");
    const made = await runs.run("coolify.companion", {
      connectionId: id,
      kind: "dns",
      params: { uuid: "app-web-uuid", fqdn: "a.example.test" },
    });
    expect(made.changed).toBe(true);
    const recordId = (made.data as { id: number }).id;
    await expect(
      runs.run("coolify.companion-dns-remove", {
        connectionId: id,
        uuid: "app-web-uuid",
        recordId: recordId + 100,
      }),
    ).rejects.toThrow(/no dns record/i);
    const removed = await runs.run("coolify.companion-dns-remove", {
      connectionId: id,
      uuid: "app-web-uuid",
      recordId,
    });
    expect(removed.data).toEqual({ id: recordId, removed: true });
    expect(removed.changed).toBe(true);
    expect(
      companions.calls.filter((c) => c.name === "dns.delete-record"),
    ).toHaveLength(1);
    // Only the destructive delete carries a confirm downstream.
    const confirmed = invoke.mock.calls
      .filter(([, options]) => options?.confirmed === true)
      .map(([actionId]) => actionId);
    expect(confirmed).toEqual(["dns.delete-record"]);
  });

  it("monitors are not paused when the connection's target changes first", async () => {
    const { harness: h, runs, id, companions } = await start();
    const monitors = companions.actions["uptime.monitors"];
    companions.actions["uptime.monitors"] = async (input, hostId) => {
      await changeTarget(h, Number(id));
      return monitors(input, hostId);
    };
    await expect(
      runs.run("coolify.companion", {
        connectionId: id,
        kind: "uptime-pause",
        params: { uuid: "app-web-uuid" },
      }),
    ).rejects.toMatchObject({ code: "target-changed" });
    expect(companions.calls.map((c) => c.name)).toEqual(["uptime.monitors"]);
  });

  it("coolify.companion no longer accepts dns-remove", async () => {
    const { runs, id, companions } = await start();
    await runs.run("coolify.companion", {
      connectionId: id,
      kind: "dns",
      params: { uuid: "app-web-uuid", fqdn: "a.example.test" },
    });
    await expect(
      runs.run("coolify.companion", {
        connectionId: id,
        kind: "dns-remove",
        params: { uuid: "app-web-uuid", recordId: 1 },
      }),
    ).rejects.toThrow();
    expect(
      companions.calls.filter((c) => c.name === "dns.delete-record"),
    ).toEqual([]);
  });

  it("companion-dns-remove answers the same as DELETE …/dns/:recordId", async () => {
    const { harness: h, runs, id } = await start();
    const base = `/connections/${id}/resources/app-web-uuid/dns`;
    const first = await h.request("POST", base, { fqdn: "a.example.test" });
    const second = await h.request("POST", base, { fqdn: "b.example.test" });
    const route = await h.request("DELETE", `${base}/${first.body.id}`, {
      confirm: true,
    });
    const op = await runs.run("coolify.companion-dns-remove", {
      connectionId: id,
      uuid: "app-web-uuid",
      recordId: second.body.id,
    });
    expect(route.status).toBe(200);
    expect(op.data).toEqual({ ...route.body, id: second.body.id });
    expect((await h.request("GET", base)).body).toEqual([]);
    // An unknown record is refused the same way by both.
    const routeMissing = await h.request("DELETE", `${base}/999`, {
      confirm: true,
    });
    expect(routeMissing.body.cause).toBe("dns-record-not-found");
    await expect(
      runs.run("coolify.companion-dns-remove", {
        connectionId: id,
        uuid: "app-web-uuid",
        recordId: 999,
      }),
    ).rejects.toThrow(routeMissing.body.error);
  });

  it("companion-dns-remove and dns-list refuse a record whose resource the current target hides", async () => {
    const { harness: h, runs, id, companions, fake } = await start();
    const base = `/connections/${id}/resources/app-web-uuid/dns`;
    const made = await h.request("POST", base, { fqdn: "a.example.test" });
    companions.calls.length = 0;
    await changeTarget(h, Number(id));
    fake.set("GET /applications", { json: [] });
    await expect(
      runs.run("coolify.companion-dns-remove", {
        connectionId: id,
        uuid: "app-web-uuid",
        recordId: made.body.id,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      runs.run("coolify.companion-read", {
        connectionId: id,
        kind: "dns-list",
        params: { uuid: "app-web-uuid" },
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(companions.calls).toEqual([]);
    expect(
      h.db.sqlite.prepare("SELECT id FROM p_coolify_dns_records").all(),
    ).toHaveLength(1);
  });

  it("a pause that fails part way resumes the monitors it already paused", async () => {
    const { runs, id, companions } = await start();
    let n = 0;
    companions.actions["uptime.pause"] = () => {
      n += 1;
      if (n === 2) throw new Error("uptime down");
      return { summary: "paused", changed: true };
    };
    await expect(
      runs.run("coolify.companion", {
        connectionId: id,
        kind: "uptime-pause",
        params: { uuid: "app-web-uuid" },
      }),
    ).rejects.toMatchObject({ code: "companion-failed" });
    const calls = companions.calls.map((c) => [
      c.name,
      (c.args[0] as { monitor?: string }).monitor,
    ]);
    expect(calls).toEqual([
      ["uptime.monitors", undefined],
      ["uptime.pause", "mon-a"],
      ["uptime.pause", "mon-b"],
      ["uptime.resume", "mon-a"],
    ]);
  });

  it("an unknown critical count reads as unknown, never as zero", async () => {
    const { runs, id, companions } = await start();
    companions.actions["security-center.critical-vulns"] = () => ({
      summary: "?",
      data: { status: "unknown" },
    });
    const outcome = await runs.run("coolify.companion-read", {
      connectionId: id,
      kind: "security",
      params: { serverUuid: "srv-web1" },
    });
    expect(outcome.summary).not.toContain("0 critical");
    expect(outcome.summary).toContain("critical count unknown");
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
