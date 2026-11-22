import { afterEach, describe, expect, it } from "vitest";
import { callTool, withRun } from "../helpers/mcp.js";
import { startLifecycle } from "../helpers/lifecycle.js";
import {
  declaredAction,
  OTHER,
  OWNER,
  type PluginHarness,
} from "../helpers/plugin.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** An event log row, as the pipeline stores it (already redacted). */
function seed(
  h: PluginHarness,
  connectionId: number,
  kind: string,
  key: string,
  over: { resourceUuid?: string; serverUuid?: string } = {},
) {
  h.db.sqlite
    .prepare(
      `INSERT INTO p_coolify_events
        (connection_id, kind, resource_uuid, server_uuid, deployment_uuid, host_id, title, detail, created_at, dedupe_key)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, '2026-11-19T10:00:00.000Z', ?)`,
    )
    .run(
      connectionId,
      kind,
      over.resourceUuid ?? "app-web-uuid",
      over.serverUuid ?? "srv-vps1-uuid",
      `${kind}: web`,
      JSON.stringify({
        name: "web",
        status: "failed",
        source: "poll",
        fields: {},
      }),
      key,
    );
}

async function started() {
  const s = await startLifecycle();
  harness = s.harness;
  return s;
}

describe("GET /connections/:id/events", () => {
  it("answers the connection's events, newest first, a page at a time", async () => {
    const { harness: h, id } = await started();
    seed(h, id, "deployment-failed", "a");
    seed(h, id, "server-unreachable", "b", { resourceUuid: undefined });
    seed(h, id, "restart-limit", "c", { resourceUuid: "app-api-uuid" });
    const first = await h.request("GET", `/connections/${id}/events?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.rows.map((r: { kind: string }) => r.kind)).toEqual([
      "restart-limit",
      "server-unreachable",
    ]);
    expect(first.body.rows[0]).toMatchObject({
      connectionId: id,
      severity: "critical",
      name: "web",
      source: "poll",
    });
    const next = await h.request(
      "GET",
      `/connections/${id}/events?before=${first.body.nextBefore}`,
    );
    expect(next.body).toEqual({
      rows: [expect.objectContaining({ kind: "deployment-failed" })],
      nextBefore: null,
    });
    const byKind = await h.request(
      "GET",
      `/connections/${id}/events?kind=restart-limit&uuid=app-api-uuid`,
    );
    expect(byKind.body.rows).toHaveLength(1);
  });

  it("refuses another user's connection, bad input and a missing permission", async () => {
    const { harness: h, id } = await started();
    seed(h, id, "deployment-failed", "a");
    const other = await h.request(
      "GET",
      `/connections/${id}/events`,
      undefined,
      OTHER,
    );
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain("web");
    for (const bad of [
      "limit=0",
      "limit=201",
      "before=x",
      "kind=nope",
      "uuid=a%20b",
      // A repeated key is not "no filter" or "the newest page".
      "kind=deployment-failed&kind=backup-failed",
      "before=1&before=2",
      "limit=1&limit=2",
      "uuid=app-web-uuid&uuid=app-api-uuid",
    ]) {
      const answer = await h.request("GET", `/connections/${id}/events?${bad}`);
      expect(answer.status).toBe(400);
    }
    expect((await h.request("GET", "/connections/999/events")).status).toBe(
      404,
    );
  });

  it("needs coolify.view", async () => {
    const s = await startLifecycle({ permissions: [] });
    harness = s.harness;
    const answer = await s.harness.request(
      "GET",
      `/connections/${s.id}/events`,
    );
    expect(answer.status).toBe(403);
  });
});

describe("coolify.events-list", () => {
  it("is a view read offered to the assistant and MCP", () => {
    expect(declaredAction("coolify.events-list")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "view",
      surfaces: { assistant: true, mcp: true },
    });
  });

  it.each([
    ["kind", ["deployment-failed", "backup-failed"]],
    ["before", [1, 2]],
    ["limit", [1]],
    ["uuid", ["app-web-uuid"]],
  ])("refuses a list as %s", async (key, value) => {
    const { harness: h, id } = await started();
    await expect(
      h.mock.ctx.operations.run("coolify.events-list", {
        input: { connectionId: String(id), [key]: value },
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("answers the route's page and refuses another user's connection", async () => {
    const { harness: h, id } = await started();
    seed(h, id, "deployment-failed", "a");
    seed(h, id, "backup-failed", "b");
    const outcome = await h.mock.ctx.operations.run("coolify.events-list", {
      input: { connectionId: String(id), limit: 1 },
    });
    expect(outcome.summary).toBe("1 event, more before");
    expect(outcome.data).toMatchObject({
      rows: [expect.objectContaining({ kind: "backup-failed" })],
    });
    h.mock.setActor(OTHER);
    await expect(
      h.mock.ctx.operations.run("coolify.events-list", {
        input: { connectionId: String(id) },
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    h.mock.setActor(OWNER);
  });

  it("is the MCP tool coolify__events_list", async () => {
    const { harness: h, id } = await started();
    seed(h, id, "task-failed", "a");
    const ctx = withRun(h.mock.ctx, (actionId, options) =>
      h.mock.ctx.operations.run(actionId, options),
    );
    const result = await callTool(ctx, "coolify__events_list", {
      connectionId: String(id),
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("task-failed");
  });
});
