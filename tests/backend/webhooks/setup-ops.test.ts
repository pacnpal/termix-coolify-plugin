import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { callTool, withRun, type Run } from "../helpers/mcp.js";
import {
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { issueWebhookToken } from "../../../src/backend/webhooks/service.js";

const COOLIFY = "https://coolify.example.test";
const FOREIGN = "https://hooks.example.net/services/fake-secret-path";
const OURS =
  /^https:\/\/termix\.test\/plugin-api\/coolify\/webhook\/([A-Za-z0-9_-]{43})$/;
const NEWCOMER = "user-3";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: { permissions?: string[] } = {}) {
  let channel: Record<string, unknown> = {
    id: 1,
    team_id: 7,
    webhook_enabled: false,
    webhook_url: null,
  };
  const patches: Record<string, unknown>[] = [];
  const fake = healthyCoolify({
    "GET /deployments": { json: [] },
    "GET /servers": { json: [] },
  });
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    if (path === "/notifications/webhook") {
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        patches.push(body);
        channel = { ...channel, ...body };
      }
      return new Response(JSON.stringify(channel), {
        headers: { "content-type": "application/json" },
      });
    }
    return fake.fetch(url, init);
  };
  const h = await startPlugin({
    fetch,
    settings: { allowMcpChanges: true },
    permissions: options.permissions,
  });
  harness = h;
  const input = {
    name: "Prod",
    baseUrl: COOLIFY,
    token: "fake-token-webhook-ops",
  };
  // Without coolify.configure the route refuses; the mock's run has no gate.
  const id = options.permissions
    ? (
        (
          await h.mock.ctx.operations.run("coolify.connection-create", {
            input,
          })
        ).data as { id: number }
      ).id
    : ((await h.request("POST", "/connections", input)).body.id as number);
  const instanceKey = (
    h.db.sqlite
      .prepare("SELECT instance_key FROM p_coolify_connections WHERE id = ?")
      .get(id) as { instance_key: string }
  ).instance_key;
  return {
    h,
    id,
    patches,
    /** How many polls read the deployment queue. */
    polls: () => fake.calls.filter((c) => c.path === "/deployments").length,
    setChannel(next: Record<string, unknown>) {
      channel = { ...channel, ...next };
    },
    /** A row for this team and a URL of ours holding its token. */
    seedOurs(): string {
      const issued = issueWebhookToken();
      h.db.sqlite
        .prepare(
          "INSERT INTO p_coolify_webhooks (instance_key, token_hash, created_by_user_id) VALUES (?, ?, ?)",
        )
        .run(instanceKey, issued.tokenHash, OWNER);
      channel = {
        ...channel,
        webhook_enabled: true,
        webhook_url: `https://termix.test/plugin-api/coolify/webhook/${issued.token}`,
      };
      return issued.token;
    },
  };
}

function tokenOf(patches: Record<string, unknown>[]): string {
  const match = OURS.exec(String(patches.at(-1)?.webhook_url));
  expect(match).not.toBeNull();
  return match![1];
}

describe("webhook operations: the token stays in the URL sent to Coolify", () => {
  it("is never in the outcome, run history, MCP result, audit or logs", async () => {
    const { h, id, patches } = await start();
    const logged: string[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(h.mock.ctx.log, level).mockImplementation((...args) => {
        logged.push(JSON.stringify(args));
      });
    }
    const runs = withRunHistory(h.mock);
    const outcome = await runs.run("coolify.webhook-setup", {
      connectionId: String(id),
    });
    expect(outcome.data).toEqual({
      outcome: "configured",
      replaced: false,
      basePrivate: false,
    });
    expect(outcome.summary).toMatch(/configured/i);
    const token = tokenOf(patches);

    const recorded: Run = (actionId, options) =>
      runs.run(actionId, options?.input ?? {});
    const mcp = await callTool(
      withRun(h.mock.ctx, recorded),
      "coolify__webhook_setup",
      { connectionId: String(id) },
    );
    expect(mcp.isError).toBe(false);
    // The second run kept the same token: the URL is ours now.
    expect(tokenOf(patches)).toBe(token);

    const status = await callTool(
      withRun(h.mock.ctx, recorded),
      "coolify__webhook_status",
      { connectionId: String(id) },
    );
    expect(JSON.parse(status.content[0].text).data).toMatchObject({
      state: "ours",
      current: null,
    });

    const seen = [
      JSON.stringify(outcome),
      JSON.stringify(runs.history),
      JSON.stringify(mcp),
      JSON.stringify(status),
      JSON.stringify(h.mock.audits),
      ...logged,
    ].join("\n");
    expect(seen).not.toContain(token);
    expect(seen).not.toContain("/webhook/");
  });

  it("refuses an operation when the actor's address was never seen", async () => {
    const { h, id, patches } = await start();
    h.db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(NEWCOMER, NEWCOMER);
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
      )
      .run(id, NEWCOMER, "configure");
    h.mock.setActor(NEWCOMER);
    await expect(
      h.mock.ctx.operations.run("coolify.webhook-setup", {
        input: { connectionId: String(id) },
      }),
    ).rejects.toMatchObject({ code: "no-base-url", status: 409 });
    expect(patches).toEqual([]);
  });
});

describe("webhook operations over MCP", () => {
  it("answers replace-needed with the URL masked and changes nothing", async () => {
    const { h, id, patches, setChannel } = await start();
    setChannel({ webhook_url: FOREIGN, webhook_enabled: true });
    const runs = withRunHistory(h.mock);
    const recorded: Run = (actionId, options) =>
      runs.run(actionId, options?.input ?? {});
    const mcp = await callTool(
      withRun(h.mock.ctx, recorded),
      "coolify__webhook_setup",
      { connectionId: String(id) },
    );
    expect(mcp.isError).toBe(false);
    expect(JSON.parse(mcp.content[0].text).data).toEqual({
      outcome: "replace-needed",
      current: "https://hooks.example.net/[redacted]",
      basePrivate: false,
    });
    expect(JSON.stringify(mcp)).not.toContain("fake-secret-path");
    expect(patches).toEqual([]);
  });

  it.each(["coolify__webhook_replace", "coolify__webhook_disable"])(
    "%s refuses without confirmed: true",
    async (tool) => {
      const { h, id, patches, setChannel } = await start();
      setChannel({ webhook_url: FOREIGN, webhook_enabled: true });
      const ran: string[] = [];
      const run: Run = async (actionId) => {
        ran.push(actionId);
        return { runId: null, status: "success" };
      };
      const answer = await callTool(withRun(h.mock.ctx, run), tool, {
        connectionId: String(id),
      });
      expect(answer.isError).toBe(true);
      expect(ran).toEqual([]);
      expect(patches).toEqual([]);
    },
  );

  it("replaces someone else's URL and turns ours off once confirmed", async () => {
    const { h, id, patches, setChannel } = await start();
    setChannel({ webhook_url: FOREIGN, webhook_enabled: true });
    const runs = withRunHistory(h.mock);
    const recorded: Run = (actionId, options) =>
      runs.run(actionId, options?.input ?? {});
    const replaced = await callTool(
      withRun(h.mock.ctx, recorded),
      "coolify__webhook_replace",
      { connectionId: String(id), confirmed: true },
    );
    expect(replaced.isError).toBe(false);
    expect(JSON.parse(replaced.content[0].text).data).toMatchObject({
      outcome: "configured",
      replaced: true,
    });
    const token = tokenOf(patches);
    const disabled = await callTool(
      withRun(h.mock.ctx, recorded),
      "coolify__webhook_disable",
      { connectionId: String(id), confirmed: true },
    );
    expect(disabled.isError).toBe(false);
    expect(patches.at(-1)).toEqual({
      webhook_url: null,
      webhook_enabled: false,
    });
    expect(JSON.stringify([replaced, disabled, runs.history])).not.toContain(
      token,
    );
  });
});

describe("webhook routes", () => {
  it("reads the state, sets the webhook up on the request's own address and turns it off", async () => {
    const { h, id, patches } = await start();
    const before = await h.request("GET", `/connections/${id}/webhook`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      state: "unset",
      enabled: false,
      current: null,
      base: "https://termix.test",
      basePrivate: false,
    });
    const set = await h.request("POST", `/connections/${id}/webhook`, {});
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      outcome: "configured",
      replaced: false,
      basePrivate: false,
    });
    const token = tokenOf(patches);
    expect(JSON.stringify(set.body)).not.toContain(token);
    const refused = await h.request("DELETE", `/connections/${id}/webhook`);
    expect(refused.status).toBe(400);
    expect(refused.body.cause).toBe("confirm-required");
    const off = await h.request(
      "DELETE",
      `/connections/${id}/webhook?confirm=true`,
    );
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ outcome: "disabled" });
  });

  it("replaces only with confirm: true", async () => {
    const { h, id, patches, setChannel } = await start();
    setChannel({ webhook_url: FOREIGN, webhook_enabled: true });
    const asked = await h.request("POST", `/connections/${id}/webhook`, {});
    expect(asked.body).toMatchObject({ outcome: "replace-needed" });
    const refused = await h.request(
      "POST",
      `/connections/${id}/webhook/replace`,
      {},
    );
    expect(refused.status).toBe(400);
    expect(refused.body.cause).toBe("confirm-required");
    expect(patches).toEqual([]);
    const done = await h.request("POST", `/connections/${id}/webhook/replace`, {
      confirm: true,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ outcome: "configured", replaced: true });
  });

  it("disable leaves someone else's URL alone (409)", async () => {
    const { h, id, patches, setChannel, seedOurs } = await start();
    seedOurs();
    setChannel({ webhook_url: FOREIGN });
    const off = await h.request("DELETE", `/connections/${id}/webhook`, {
      confirm: true,
    });
    expect(off.status).toBe(409);
    expect(off.body.cause).toBe("not-ours");
    expect(patches).toEqual([]);
  });

  it("another user's connection is 404, and a view grant is 403", async () => {
    const { h, id, patches } = await start();
    for (const [method, path, body] of [
      ["GET", `/connections/${id}/webhook`, undefined],
      ["POST", `/connections/${id}/webhook`, {}],
    ] as const) {
      const answer = await h.request(method, path, body, OTHER);
      expect(answer.status).toBe(404);
    }
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
      )
      .run(id, OTHER, "view");
    const viewer = await h.request(
      "POST",
      `/connections/${id}/webhook`,
      {},
      OTHER,
    );
    expect(viewer.status).toBe(403);
    expect(viewer.body.cause).toBe("forbidden");
    expect(patches).toEqual([]);
  });

  it("needs coolify.configure", async () => {
    const { h, id, patches } = await start({
      permissions: ["view", "operate"],
    });
    for (const [method, path, body] of [
      ["GET", `/connections/${id}/webhook`, undefined],
      ["POST", `/connections/${id}/webhook`, {}],
      ["POST", `/connections/${id}/webhook/replace`, { confirm: true }],
      ["DELETE", `/connections/${id}/webhook`, { confirm: true }],
    ] as const) {
      const answer = await h.request(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(403);
    }
    expect(patches).toEqual([]);
  });
});

describe("an interrupted disable and the poller", () => {
  it("a retry clears the stale row, so the poller polls again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.parse("2026-11-23T10:00:00.000Z");
    vi.setSystemTime(T0);
    const { h, id, patches, polls, seedOurs, setChannel } = await start();
    const pollAt = async (ms: number) => {
      vi.setSystemTime(ms);
      h.mock.setActor(undefined);
      try {
        await h.mock.runScheduled();
      } finally {
        h.mock.setActor(OWNER);
      }
    };
    // A webhook that delivered, then a disable that cleared Coolify but
    // stopped before its row went: pollEnabled is off, so nothing polls.
    seedOurs();
    h.db.sqlite
      .prepare("UPDATE p_coolify_webhooks SET last_received_at = ?")
      .run("2026-11-23T09:00:00.000Z");
    setChannel({ webhook_url: null, webhook_enabled: false });
    await pollAt(T0);
    expect(polls()).toBe(0);

    const retry = await h.request(
      "DELETE",
      `/connections/${id}/webhook?confirm=true`,
    );
    expect(retry.body).toEqual({ outcome: "not-set" });
    expect(patches).toEqual([]);
    await pollAt(T0 + 60_000);
    expect(polls()).toBe(1);
    vi.useRealTimers();
  });
});
