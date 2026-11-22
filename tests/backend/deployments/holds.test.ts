import { describe, expect, it } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "../../../src/backend/connections/service.js";
import type { Resources } from "../../../src/backend/resources/service.js";
import { toDeployment } from "../../../src/backend/coolify/dto.js";
import { createDeployments } from "../../../src/backend/deployments/service.js";
import { deploymentRaw } from "../helpers/deployments.js";

/**
 * A connection whose revision changes while the access check that runs
 * inside the cancel request's last guard is pending: the moment between
 * that guard's revision read and the request going out.
 */
function racingConnection() {
  let revision = "rev-1";
  let inCancelGuard = false;
  const sent: string[] = [];
  const api = {
    async deploymentWithLog(
      uuid: string,
      opts: { beforeFetch?: () => Promise<void> },
    ) {
      await opts.beforeFetch?.();
      const raw = deploymentRaw(uuid, "in_progress");
      return { deployment: toDeployment(raw), log: null };
    },
    async cancelDeployment(
      uuid: string,
      opts: { beforeFetch?: () => Promise<void> },
    ) {
      inCancelGuard = true;
      await opts.beforeFetch?.();
      inCancelGuard = false;
      sent.push(uuid);
      return { status: "cancelled-by-user" };
    },
  };
  const connections = {
    async snapshot() {
      return {
        view: { revision, access: "owner" },
        api,
        secrets: async () => [],
      };
    },
    async revision() {
      return revision;
    },
    async access() {
      // The target changes while this read is pending.
      if (inCancelGuard) revision = "rev-2";
      await Promise.resolve();
      return "owner";
    },
  } as unknown as Connections;
  const resources = {
    async get() {
      return { uuid: "app-web-uuid", kind: "application" };
    },
    async invalidate() {},
  } as unknown as Resources;
  const ctx = { rbac: { has: async () => true } } as unknown as PluginContext;
  return {
    deployments: createDeployments(ctx, {
      connections,
      resources,
      deployed: async () => {},
    }),
    sent,
  };
}

describe("the deployment guard", () => {
  it("sends no cancel when the target changes while the grant is read", async () => {
    const { deployments, sent } = racingConnection();
    await expect(
      deployments.cancel(1, "dep-run", { resourceUuid: "app-web-uuid" }),
    ).rejects.toMatchObject({ code: "target-changed" });
    expect(sent).toEqual([]);
  });
});
