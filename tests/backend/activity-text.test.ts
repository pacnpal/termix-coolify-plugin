import { describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import {
  createDeployActivity,
  recordShell,
} from "../../src/backend/activity.js";
import { HOST_ID, linkedHost } from "./containers/fixtures.js";
import { manifest, OWNER } from "./helpers/plugin.js";

function mock() {
  const m = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    hosts: [linkedHost],
    actor: OWNER,
  });
  const deployed = createDeployActivity(m.ctx, {
    linkedHostFor: async () => HOST_ID,
  });
  return { m, deployed };
}

const service = (uuid: string, name: string) => ({
  uuid,
  name,
  kind: "service",
  deploymentUuid: null,
  hostId: HOST_ID,
});

describe("recent activity text", () => {
  it("keeps $ patterns in a name as they are", async () => {
    const { m, deployed } = await mock();
    await recordShell(m.ctx, HOST_ID, "a$&b $1 $$ $'");
    await deployed(1, [service("svc-1", "web $& $1 $$")]);
    expect(m.activities.map((a) => a.hostName)).toEqual([
      "Opened shell in a$&b $1 $$ $'",
      "Deployed web $& $1 $$",
    ]);
  });

  it("never fills a placeholder that came in with a name", async () => {
    const { m, deployed } = await mock();
    await deployed(1, [
      { ...service("svc-1", "x {{pullRequestId}} {{name}}"), pullRequestId: 5 },
    ]);
    expect(m.activities.map((a) => a.hostName)).toEqual([
      "Deployed x {{pullRequestId}} {{name}} (pull request #5)",
    ]);
  });
});

describe("recent activity per resource", () => {
  it("two resources with the same name on one host get two entries", async () => {
    const { m, deployed } = await mock();
    await deployed(1, [service("svc-1", "web"), service("svc-2", "web")]);
    expect(m.activities).toHaveLength(2);
  });

  it("one resource started twice in one call gets one entry", async () => {
    const { m, deployed } = await mock();
    await deployed(1, [service("svc-1", "web"), service("svc-1", "web")]);
    expect(m.activities).toHaveLength(1);
  });
});
