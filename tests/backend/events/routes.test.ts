import { afterEach, describe, expect, it } from "vitest";
import { callTool, withRun } from "../helpers/mcp.js";
import { grant, startLifecycle } from "../helpers/lifecycle.js";
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
  over: { resourceUuid?: string | null; serverUuid?: string | null } = {},
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
      over.resourceUuid === undefined ? "app-web-uuid" : over.resourceUuid,
      over.serverUuid === undefined ? "srv-vps1-uuid" : over.serverUuid,
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

async function started(options?: Parameters<typeof startLifecycle>[0]) {
  const s = await startLifecycle(options);
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

const kinds = (body: {
  rows: { kind: string; resourceUuid: string | null }[];
}) => body.rows.map((r) => `${r.kind}:${r.resourceUuid ?? "-"}`);

/** Rows about what the connection's Coolify has, and about what it doesn't. */
function seedMixed(h: PluginHarness, id: number) {
  seed(h, id, "deployment-failed", "a");
  seed(h, id, "deployment-failed", "b", { resourceUuid: "app-gone-uuid" });
  seed(h, id, "server-unreachable", "c", { resourceUuid: null });
  seed(h, id, "server-unreachable", "d", {
    resourceUuid: null,
    serverUuid: "srv-gone-uuid",
  });
  seed(h, id, "token-expiring", "e", { resourceUuid: null, serverUuid: null });
  seed(h, id, "backup-failed", "f", { resourceUuid: "db-cache-uuid" });
  seed(h, id, "certificate-problem", "g", { resourceUuid: "app-gone-uuid" });
}

describe("the grant rule", () => {
  it("shows a granted user only rows about what the connection's Coolify still has", async () => {
    const { harness: h, id } = await started();
    seedMixed(h, id);
    grant(h, id, OTHER, "view");
    const theirs = await h.request(
      "GET",
      `/connections/${id}/events`,
      undefined,
      OTHER,
    );
    expect(theirs.status).toBe(200);
    expect(kinds(theirs.body)).toEqual([
      "backup-failed:db-cache-uuid",
      "token-expiring:-",
      "server-unreachable:-",
      "deployment-failed:app-web-uuid",
    ]);
    expect(theirs.body.nextBefore).toBeNull();
    expect(JSON.stringify(theirs.body)).not.toContain("-gone-");
    // The owner's own log is whole.
    const mine = await h.request("GET", `/connections/${id}/events`);
    expect(mine.body.rows).toHaveLength(7);
  });

  it("fills a granted user's page past hidden rows and says when there is more", async () => {
    const { harness: h, id } = await started();
    seedMixed(h, id);
    grant(h, id, OTHER, "operate");
    const first = await h.request(
      "GET",
      `/connections/${id}/events?limit=2`,
      undefined,
      OTHER,
    );
    expect(kinds(first.body)).toEqual([
      "backup-failed:db-cache-uuid",
      "token-expiring:-",
    ]);
    expect(first.body.nextBefore).toBe(first.body.rows[1].id);
    const second = await h.request(
      "GET",
      `/connections/${id}/events?limit=2&before=${first.body.nextBefore}`,
      undefined,
      OTHER,
    );
    expect(kinds(second.body)).toEqual([
      "server-unreachable:-",
      "deployment-failed:app-web-uuid",
    ]);
    // Only hidden rows are left: no next page.
    expect(second.body.nextBefore).toBeNull();
  });

  it("refuses a granted user when the connection's Coolify can't say what it has", async () => {
    const { harness: h, id } = await started({
      overrides: { "GET /applications": { status: 401, json: {} } },
    });
    seedMixed(h, id);
    grant(h, id, OTHER, "configure");
    const theirs = await h.request(
      "GET",
      `/connections/${id}/events`,
      undefined,
      OTHER,
    );
    expect(theirs.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(theirs.body)).not.toContain("deployment-failed");
    // The owner reads the plugin's own table, whatever Coolify answers.
    const mine = await h.request("GET", `/connections/${id}/events`);
    expect(mine.status).toBe(200);
    expect(mine.body.rows).toHaveLength(7);
  });

  it("applies to coolify.events-list and its MCP tool", async () => {
    const { harness: h, id } = await started();
    seedMixed(h, id);
    grant(h, id, OTHER, "view");
    h.mock.setActor(OTHER);
    try {
      const outcome = await h.mock.ctx.operations.run("coolify.events-list", {
        input: { connectionId: String(id), kind: "deployment-failed" },
      });
      expect(kinds(outcome.data as never)).toEqual([
        "deployment-failed:app-web-uuid",
      ]);
      const ctx = withRun(h.mock.ctx, (actionId, options) =>
        h.mock.ctx.operations.run(actionId, options),
      );
      const result = await callTool(ctx, "coolify__events_list", {
        connectionId: String(id),
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("token-expiring");
      expect(result.content[0].text).not.toContain("-gone-");
    } finally {
      h.mock.setActor(OWNER);
    }
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
