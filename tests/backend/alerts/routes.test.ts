import { afterEach, describe, expect, it } from "vitest";
import { callTool, withRun } from "../helpers/mcp.js";
import { grant, startLifecycle } from "../helpers/lifecycle.js";
import {
  declaredAction,
  OTHER,
  OWNER,
  type PluginHarness,
} from "../helpers/plugin.js";
import { DEFAULT_ALERT_KINDS } from "../../../src/shared/alerts.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function started(options: Parameters<typeof startLifecycle>[0] = {}) {
  const s = await startLifecycle(options);
  harness = s.harness;
  return s;
}

const path = (id: number) => `/connections/${id}/alert-prefs`;

describe("GET and PUT /connections/:id/alert-prefs", () => {
  it("answers the defaults, saves your own picks and resets them", async () => {
    const { harness: h, id } = await started();
    const first = await h.request("GET", path(id));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      connectionId: id,
      kinds: [...DEFAULT_ALERT_KINDS],
      isDefault: true,
      defaults: [...DEFAULT_ALERT_KINDS],
    });
    expect(first.body.available).toContain("deployment-finished");
    const saved = await h.request("PUT", path(id), {
      kinds: ["high-disk", "deployment-failed"],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      kinds: ["deployment-failed", "high-disk"],
      isDefault: false,
    });
    expect((await h.request("GET", path(id))).body.kinds).toEqual([
      "deployment-failed",
      "high-disk",
    ]);
    const reset = await h.request("PUT", path(id), { kinds: null });
    expect(reset.body.isDefault).toBe(true);
  });

  it("lets a granted user keep their own, apart from the owner's", async () => {
    const { harness: h, id } = await started();
    grant(h, id, OTHER, "view");
    const theirs = await h.request("PUT", path(id), { kinds: [] }, OTHER);
    expect(theirs.status).toBe(200);
    expect(theirs.body.kinds).toEqual([]);
    expect((await h.request("GET", path(id))).body.isDefault).toBe(true);
  });

  it("refuses another user's connection, unknown kinds and a missing list", async () => {
    const { harness: h, id } = await started();
    for (const method of ["GET", "PUT"]) {
      const answer = await h.request(
        method,
        path(id),
        method === "PUT" ? { kinds: ["high-disk"] } : undefined,
        OTHER,
      );
      expect(answer.status).toBe(404);
    }
    for (const body of [{ kinds: ["nope"] }, { kinds: "high-disk" }, {}]) {
      expect((await h.request("PUT", path(id), body)).status).toBe(400);
    }
    expect((await h.request("GET", path(999))).status).toBe(404);
    expect((await h.request("GET", path(id))).body.isDefault).toBe(true);
  });

  it("needs coolify.view", async () => {
    const { harness: h, id } = await started({ permissions: [] });
    expect((await h.request("GET", path(id))).status).toBe(403);
    expect((await h.request("PUT", path(id), { kinds: [] })).status).toBe(403);
  });
});

describe("coolify.alert-prefs and coolify.alert-prefs-set", () => {
  it("are declared for view, on the assistant and MCP", () => {
    expect(declaredAction("coolify.alert-prefs")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "view",
      surfaces: { assistant: true, mcp: true },
    });
    expect(declaredAction("coolify.alert-prefs-set")).toMatchObject({
      scope: "server",
      risk: "change",
      permission: "view",
      surfaces: { assistant: true, mcp: true },
    });
  });

  it("read and write your own preferences", async () => {
    const { harness: h, id } = await started();
    const set = await h.mock.ctx.operations.run("coolify.alert-prefs-set", {
      input: { connectionId: String(id), kinds: ["backup-failed"] },
    });
    expect(set.summary).toBe("1 alert kind");
    const read = await h.mock.ctx.operations.run("coolify.alert-prefs", {
      input: { connectionId: String(id) },
    });
    expect(read.data).toMatchObject({ kinds: ["backup-failed"] });
    const reset = await h.mock.ctx.operations.run("coolify.alert-prefs-set", {
      input: { connectionId: String(id), reset: true },
    });
    expect(reset.summary).toBe("Default alerts");
  });

  it("are refused for another user's connection", async () => {
    const { harness: h, id } = await started();
    h.mock.setActor(OTHER);
    for (const [action, input] of [
      ["coolify.alert-prefs", {}],
      ["coolify.alert-prefs-set", { kinds: ["high-disk"] }],
    ] as const) {
      await expect(
        h.mock.ctx.operations.run(action, {
          input: { connectionId: String(id), ...input },
        }),
      ).rejects.toMatchObject({ code: "not-found" });
    }
    h.mock.setActor(OWNER);
    const count = h.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_coolify_alert_prefs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("refuse an unknown kind and a missing list", async () => {
    const { harness: h, id } = await started();
    for (const input of [{ kinds: ["nope"] }, {}]) {
      await expect(
        h.mock.ctx.operations.run("coolify.alert-prefs-set", {
          input: { connectionId: String(id), ...input },
        }),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
  });

  it("are the MCP tools coolify__alert_prefs and coolify__alert_prefs_set", async () => {
    const { harness: h, id } = await started({
      settings: { allowMcpChanges: true },
    });
    const ctx = withRun(h.mock.ctx, (actionId, options) =>
      h.mock.ctx.operations.run(actionId, options),
    );
    const read = await callTool(ctx, "coolify__alert_prefs", {
      connectionId: String(id),
    });
    expect(read.isError).toBe(false);
    expect(read.content[0].text).toContain("deployment-failed");
    const refused = await callTool(ctx, "coolify__alert_prefs_set", {
      connectionId: String(id),
      kinds: ["high-disk"],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("confirm-required");
    const set = await callTool(ctx, "coolify__alert_prefs_set", {
      connectionId: String(id),
      kinds: ["high-disk"],
      confirmed: true,
    });
    expect(set.isError).toBe(false);
    expect(set.content[0].text).toContain("high-disk");
  });
});
