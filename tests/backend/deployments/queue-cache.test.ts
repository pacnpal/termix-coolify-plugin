import { describe, expect, it } from "vitest";
import type { CoolifyApi } from "../../../src/backend/coolify/api.js";
import type {
  DeploymentDto,
  ResourceDto,
} from "../../../src/backend/coolify/dto.js";
import { createQueueCache } from "../../../src/backend/deployments/queue.js";

const APP = { uuid: "app-web", name: "web" } as ResourceDto;

function row(uuid: string, status: string): DeploymentDto {
  return {
    uuid,
    resourceUuid: APP.uuid,
    status,
    commit: null,
    commitMessage: null,
    pullRequestId: 0,
    rollback: false,
    serverName: null,
    createdAt: "2026-11-23T10:00:00.000Z",
    updatedAt: null,
    finishedAt: "2026-11-23T10:00:30.000Z",
  };
}

/** A Coolify whose history answers wait until `release` is called. */
function heldApi(rows: DeploymentDto[]) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = {
    runningDeployments: async () => [],
    deploymentPage: async () => {
      await held;
      return { rows, count: rows.length };
    },
  } as unknown as CoolifyApi;
  return { api, release };
}

function quickApi(rows: DeploymentDto[]) {
  return {
    runningDeployments: async () => [],
    deploymentPage: async () => ({ rows, count: rows.length }),
  } as unknown as CoolifyApi;
}

describe("the queue cache and a fresh baseline read", () => {
  it("an older read still running can't overwrite the fresh read's cache or pages", async () => {
    const cache = createQueueCache({ revision: async () => "rev" });
    const source = (api: CoolifyApi) => ({ api, applications: [APP] });

    // A UI read starts, holding the history from before.
    const older = heldApi([]);
    const olderRead = cache.read(1, "rev", source(older.api));
    // The poller's baseline reads fresh and sees the deployment that ended.
    const fresh = await cache.read(
      1,
      "rev",
      source(quickApi([row("dep-ended", "failed")])),
      {
        freshHistory: true,
      },
    );
    expect(fresh.recent.map((r) => r.uuid)).toEqual(["dep-ended"]);

    // The older read ends after it: it answers its own caller ...
    older.release();
    expect((await olderRead).recent).toEqual([]);
    // ... but the cache still holds the fresh read,
    const cached = await cache.read(1, "rev", source(quickApi([])));
    expect(cached.recent.map((r) => r.uuid)).toEqual(["dep-ended"]);
    // and so do the kept pages a refresh reuses.
    const refreshed = await cache.read(1, "rev", source(quickApi([])), {
      refresh: true,
    });
    expect(refreshed.recent.map((r) => r.uuid)).toEqual(["dep-ended"]);
  });
});
