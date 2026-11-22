import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHarness } from "../helpers/plugin.js";
import { startCompanions as startHostCompanions } from "./fixtures.js";
import {
  fakeDockerHost,
  startCompanions as startContainerCompanions,
  WEB_RUNNING,
} from "./container-fixtures.js";

/**
 * Every read of the actor's grant on a connection, counted, with a hook that
 * runs while the read is still pending for its caller: the moment a guard
 * that reads the revision first and the grant second can't see.
 */
const race = {
  count: 0,
  onAccess: (_n: number) => {},
};

vi.mock("../../../src/backend/connections/service.js", async (load) => {
  const real =
    await load<typeof import("../../../src/backend/connections/service.js")>();
  return {
    ...real,
    createConnections: (...args: Parameters<typeof real.createConnections>) => {
      const connections = real.createConnections(...args);
      return {
        ...connections,
        async access(id: number) {
          const level = await connections.access(id);
          race.count += 1;
          race.onAccess(race.count);
          return level;
        },
      };
    },
  };
});

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  race.count = 0;
  race.onAccess = () => {};
  await harness?.close();
  harness = null;
});

/** Points the connection at another token, synchronously. */
function retarget(h: PluginHarness, connectionId: number, sealed: string) {
  h.db.sqlite
    .prepare("UPDATE p_coolify_connections SET token_sealed = ? WHERE id = ?")
    .run(sealed, connectionId);
}

/**
 * The number of the last grant read before the guarded call first happens,
 * from a run where nothing changes: the read inside that call's own guard.
 */
function lastReadBefore(calls: () => number): () => number {
  let last = 0;
  race.onAccess = (n) => {
    if (calls() === 0) last = n;
  };
  return () => last;
}

describe("companion guards check the revision last", () => {
  it("a host companion read calls no companion when the target changes while the grant is read", async () => {
    const path = (id: number) => `/connections/${id}/servers/srv-web1/security`;
    const dry = await startHostCompanions();
    harness = dry.harness;
    const last = lastReadBefore(() => dry.companions.calls.length);
    const ok = await dry.harness.request("GET", path(dry.connectionId));
    expect(ok.status).toBe(200);
    const at = last();
    expect(at).toBeGreaterThan(0);
    await dry.harness.close();
    race.count = 0;

    const live = await startHostCompanions();
    harness = live.harness;
    const sealed = await live.harness.mock.ctx.secrets.seal("fake-token-new");
    race.onAccess = (n) => {
      if (n === at) retarget(live.harness, live.connectionId, sealed);
    };
    const res = await live.harness.request("GET", path(live.connectionId));
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(live.companions.calls).toEqual([]);
  });

  it("a container tunnel makes no outside call once the target changes while the grant is read", async () => {
    const path = (id: number) =>
      `/connections/${id}/resources/app-web-uuid/tunnel`;
    const dry = await startContainerCompanions();
    harness = dry.harness;
    fakeDockerHost(dry.harness, { ps: [WEB_RUNNING] });
    const last = lastReadBefore(() => dry.calls.forward.length);
    const ok = await dry.harness.request("POST", path(dry.connectionId), {
      port: 3000,
    });
    expect(ok.status).toBe(200);
    const at = last();
    expect(at).toBeGreaterThan(0);
    vi.restoreAllMocks();
    await dry.harness.close();
    race.count = 0;

    const live = await startContainerCompanions();
    harness = live.harness;
    const docker = fakeDockerHost(live.harness, { ps: [WEB_RUNNING] });
    const sealed = await live.harness.mock.ctx.secrets.seal("fake-token-new");
    let outsideAtRace = -1;
    const outside = () =>
      docker.commands.length +
      live.fake.calls.length +
      live.calls.forward.length +
      live.calls.open.length;
    race.onAccess = (n) => {
      if (n !== at) return;
      retarget(live.harness, live.connectionId, sealed);
      outsideAtRace = outside();
    };
    const res = await live.harness.request("POST", path(live.connectionId), {
      port: 3000,
    });
    expect(res.status).toBe(409);
    expect(live.calls.forward).toEqual([]);
    expect(outsideAtRace).toBeGreaterThanOrEqual(0);
    expect(outside()).toBe(outsideAtRace);
  });
});
