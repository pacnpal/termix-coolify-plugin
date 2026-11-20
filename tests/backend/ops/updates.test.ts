import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { manifest, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { PLATFORM_PROBE_COMMAND } from "@termix-ssh/plugin-sdk/host-commands";
import { newestSecurity } from "../../../src/backend/ops/signals.js";
import {
  fakePackageManager,
  fakeSsh,
  startLinked,
} from "../updates/fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
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

async function start(options: Parameters<typeof startLinked>[0] = {}) {
  const started = await startLinked(options);
  harness = started.harness;
  return {
    ...started,
    h: started.harness,
    runs: withRunHistory(started.harness.mock),
    id: String(started.connectionId),
  };
}

describe("server update operations", () => {
  it("are declared with the plan's risks, permissions and model surfaces only on the read", () => {
    const expected = {
      "coolify.server-updates": ["read", "view"],
      "coolify.server-updates-check": ["change", "operate"],
      "coolify.server-updates-install": ["change", "operate"],
      "coolify.server-reboot": ["destructive", "administer"],
    } as const;
    for (const [id, [risk, permission]] of Object.entries(expected)) {
      const action = declared(id);
      expect(action.scope, id).toBe("server");
      expect(action.risk, id).toBe(risk);
      expect(action.permission, id).toBe(permission);
      const model = risk === "read";
      expect(action.surfaces?.assistant === true, id).toBe(model);
      expect(action.surfaces?.mcp === true, id).toBe(model);
      expect(
        action.inputs?.find((i) => i.key === "connectionId")?.optionsFrom,
        id,
      ).toBe("coolify.list-connections");
    }
    expect(
      declared("coolify.server-updates-install").inputs?.find(
        (i) => i.key === "confirm",
      ),
    ).toMatchObject({ type: "boolean", required: true });
    expect(
      declared("coolify.server-reboot").inputs?.find(
        (i) => i.key === "confirmName",
      ),
    ).toMatchObject({ type: "string", required: true });
  });

  it("lists exactly the Package Manager actions it invokes", () => {
    const invokes = manifest.contributes?.operations?.invokes ?? [];
    // The other companions' ids are checked in companions/detect.test.ts.
    expect(invokes.filter((id) => id.startsWith("package-manager."))).toEqual([
      "package-manager.list-updates",
      "package-manager.upgrade-all",
    ]);
    expect(manifest.capabilities).toContain("operations:invoke");
  });

  it("server-updates-check runs the same check as POST …/updates/check", async () => {
    const { h, runs, id, connectionId } = await start();
    fakeSsh(h);
    const outcome = await runs.run("coolify.server-updates-check", {
      connectionId: id,
      serverUuid: "srv-web1",
    });
    const data = outcome.data as { via: string; fresh: { updates: number } };
    expect(data.via).toBe("ssh");
    const route = await h.request(
      "POST",
      `/connections/${connectionId}/servers/srv-web1/updates/check`,
      {},
    );
    expect(route.body.via).toBe(data.via);
    expect(route.body.fresh.items).toEqual(
      (data.fresh as unknown as { items: unknown[] }).items,
    );
    expect(outcome.summary).toContain("via ssh");
  });

  it("server-updates-install without confirm is refused", async () => {
    const { h, runs, id } = await start({ plugins: ["package-manager"] });
    const invoke = fakePackageManager(h);
    await expect(
      runs.run("coolify.server-updates-install", {
        connectionId: id,
        serverUuid: "srv-web1",
        confirm: false,
      }),
    ).rejects.toMatchObject({ code: "confirm-required" });
    expect(invoke).not.toHaveBeenCalled();

    const outcome = await runs.run("coolify.server-updates-install", {
      connectionId: id,
      serverUuid: "srv-web1",
      confirm: true,
    });
    expect(outcome.summary).toContain("via package-manager");
    expect(invoke).toHaveBeenCalledWith(
      "package-manager.upgrade-all",
      expect.anything(),
    );
  });

  it("server-reboot needs the exact name and coolify.administer", async () => {
    const { h, runs, id } = await start();
    const ssh = fakeSsh(h);
    await expect(
      runs.run("coolify.server-reboot", {
        connectionId: id,
        serverUuid: "srv-web1",
        confirmName: "web-2",
      }),
    ).rejects.toMatchObject({ code: "name-mismatch" });
    expect(ssh.calls).toEqual([]);
    await harness!.close();

    const limited = await start({
      permissions: ["coolify.view", "coolify.operate", "coolify.configure"],
    });
    const limitedSsh = fakeSsh(limited.h);
    await expect(
      limited.runs.run("coolify.server-reboot", {
        connectionId: limited.id,
        serverUuid: "srv-web1",
        confirmName: "web-1",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(limitedSsh.calls).toEqual([]);
  });

  it("refuses a server with no Linked host with not-linked", async () => {
    const { h, runs, id } = await start();
    fakeSsh(h);
    await expect(
      runs.run("coolify.server-updates-check", {
        connectionId: id,
        serverUuid: "srv-web2",
      }),
    ).rejects.toMatchObject({ code: "not-linked", status: 409 });
  });
});

describe("the security updates signal", () => {
  /** The kept check's cache row, as the updates service wrote it. */
  function keptRow(h: PluginHarness, connectionId: number) {
    const row = h.db.sqlite
      .prepare(
        "SELECT json FROM p_coolify_cache WHERE connection_id = ? AND kind = 'updates:srv-web1'",
      )
      .get(connectionId) as { json: string };
    return JSON.parse(row.json) as Record<string, unknown>;
  }

  function setKept(
    h: PluginHarness,
    connectionId: number,
    value: Record<string, unknown>,
  ) {
    h.db.sqlite
      .prepare(
        "UPDATE p_coolify_cache SET json = ? WHERE connection_id = ? AND kind = 'updates:srv-web1'",
      )
      .run(JSON.stringify(value), connectionId);
  }

  async function checkedOverSsh() {
    const started = await start();
    const { exec } = fakeSsh(started.h);
    await started.runs.run("coolify.server-updates-check", {
      connectionId: started.id,
      serverUuid: "srv-web1",
    });
    exec.mockClear();
    return { ...started, exec };
  }

  it("shows the plugin's own newer check, read from cache: no SSH, no Coolify call", async () => {
    const { h, hostId, exec, fake } = await checkedOverSsh();
    const invoke = vi.spyOn(h.mock.ctx.operations, "invoke");
    const read = () =>
      h.mock.ctx.operations.run("coolify.signal-updates", { hostId });
    expect((await read()).data).toMatchObject({
      value: 1,
      label: "1 security update (checked over SSH)",
    });
    const before = fake.calls.length;
    expect((await read()).data).toMatchObject({
      label: "1 security update (checked over SSH)",
    });
    expect(fake.calls.length).toBe(before);
    expect(exec).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never serves a kept check from another revision or an older generation", async () => {
    const { h, hostId, connectionId } = await checkedOverSsh();
    const kept = keptRow(h, connectionId);
    expect(kept.revision).toEqual(expect.any(String));
    const read = async () =>
      (await h.mock.ctx.operations.run("coolify.signal-updates", { hostId }))
        .data;
    setKept(h, connectionId, { ...kept, revision: "another-target" });
    expect(await read()).toMatchObject({
      status: "unknown",
    });
    setKept(h, connectionId, { ...kept, generation: "older:0" });
    expect(await read()).toMatchObject({
      status: "unknown",
    });
    setKept(h, connectionId, kept);
    expect(await read()).toMatchObject({
      label: "1 security update (checked over SSH)",
    });
  });

  it("another user's connection reads as unknown, without reading Coolify", async () => {
    const { h, hostId, fake } = await checkedOverSsh();
    const before = fake.calls.length;
    h.mock.setActor("someone-else");
    const read = await h.mock.ctx.operations.run("coolify.signal-updates", {
      hostId,
    });
    expect(read.data).toMatchObject({ status: "unknown" });
    expect(fake.calls.length).toBe(before);
  });

  it("takes the newer check by parsed time; an unparsable time counts as older", () => {
    const coolify = (checkedAt: string | null) => ({ security: 2, checkedAt });
    const own = (checkedAt: string | null) => ({
      security: 5,
      checkedAt,
      via: "ssh" as const,
    });
    // Parsed, not compared as text: 09:00+02:00 is before 08:00Z.
    expect(
      newestSecurity(
        coolify("2026-11-18T08:00:00Z"),
        own("2026-11-18T09:00:00+02:00"),
      ),
    ).toEqual({ security: 2, source: "coolify" });
    expect(
      newestSecurity(coolify("2026-11-18T08:00:00Z"), own("not a date")),
    ).toEqual({ security: 2, source: "coolify" });
    expect(
      newestSecurity(coolify("garbage"), own("2026-11-18T08:00:00Z")),
    ).toEqual({ security: 5, source: "ssh" });
    expect(newestSecurity(null, own(null))).toEqual({
      security: 5,
      source: "ssh",
    });
    expect(newestSecurity({ security: null, checkedAt: null }, null)).toBe(
      null,
    );
  });
});

describe("cancelled update runs", () => {
  /**
   * A fake server whose run is aborted from the next actor read once armed:
   * the access read inside connections.revision(), which the last check
   * before each command awaits.
   */
  function abortable(h: PluginHarness) {
    const abort = new AbortController();
    const { calls, exec } = fakeSsh(h);
    let armed = false;
    const arm = () => {
      armed = true;
    };
    const actor = h.mock.ctx.currentActor.bind(h.mock.ctx);
    vi.spyOn(h.mock.ctx, "currentActor").mockImplementation(() => {
      if (armed) {
        armed = false;
        abort.abort(new Error("cancelled"));
      }
      return actor();
    });
    return { abort, calls, exec, arm };
  }

  function run(h: PluginHarness, id: string, signal: AbortSignal) {
    return (input: Record<string, unknown>) =>
      Promise.resolve(
        h.mock.operationHandlers
          .get(id)!
          .run(input, { runId: "r1", dryRun: false, signal, log: () => {} }),
      );
  }

  it("an install cancelled during the last revision check never starts the upgrade", async () => {
    const { h, id } = await start();
    const { abort, calls, exec, arm } = abortable(h);
    const answer = exec.getMockImplementation()!;
    exec.mockImplementation(async (...args) => {
      const out = await answer(...args);
      if (args[1] === PLATFORM_PROBE_COMMAND) arm();
      return out;
    });
    await expect(
      run(
        h,
        "coolify.server-updates-install",
        abort.signal,
      )({
        connectionId: id,
        serverUuid: "srv-web1",
        confirm: true,
      }),
    ).rejects.toThrow("cancelled");
    expect(abort.signal.aborted).toBe(true);
    expect(calls.some((c) => c.command.includes("apt-get -y upgrade"))).toBe(
      false,
    );
  });

  it("a reboot cancelled during the last revision check never reboots", async () => {
    const { h, id, access } = await start({
      permissions: [
        "coolify.view",
        "coolify.operate",
        "coolify.configure",
        "coolify.administer",
      ],
    });
    const { abort, calls, arm } = abortable(h);
    // The Linked host's access read is the last step before the revision
    // checks that come right before the reboot command.
    const answer = access.getMockImplementation()!;
    access.mockImplementation(async (...args) => {
      const out = await answer(...args);
      arm();
      return out;
    });
    await expect(
      run(
        h,
        "coolify.server-reboot",
        abort.signal,
      )({
        connectionId: id,
        serverUuid: "srv-web1",
        confirmName: "web-1",
      }),
    ).rejects.toThrow("cancelled");
    expect(abort.signal.aborted).toBe(true);
    expect(calls.some((c) => c.command.includes("systemctl reboot"))).toBe(
      false,
    );
  });
});
