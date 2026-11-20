import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { manifest, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
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
