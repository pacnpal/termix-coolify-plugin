import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { OWNER, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import { TOKEN, startCompanions } from "./fixtures.js";

// Obviously fake values, each one a kind of secret a log line can carry.
const ACCESS_SECRET = "fake-access-secret-log-search";
const URL_PASSWORD = "fake-url-pass-log-search";
const FIELD_SECRET = "fake-field-pass-log-search";
const KEY_BODY = "FAKEKEYBODYlogsearchAAAAB3NzaC1yc2E";
const SPLIT_KEY_BODY = "FAKESPLITKEYBODYlogsearchAAAAC3Nza";

const LEAKS = [TOKEN, ACCESS_SECRET, URL_PASSWORD, FIELD_SECRET, KEY_BODY];

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/**
 * One hit per secret kind, in the message and in the hit's other text
 * fields, plus a private key whose BEGIN, body and END are separate hits.
 */
function leakyHits() {
  return [
    { time: "2026-11-19T10:00:00.000Z", message: `token ${TOKEN} used` },
    { time: TOKEN, host: TOKEN, container: TOKEN, message: "fields" },
    { message: `cf access ${ACCESS_SECRET}`, host: ACCESS_SECRET },
    {
      message: `connecting to postgres://app:${URL_PASSWORD}@db.example.test/app`,
      container: `https://u:${URL_PASSWORD}@x.example.test`,
    },
    { line: `DB_PASSWORD=${FIELD_SECRET} ready` },
    {
      text: `key -----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\n-----END OPENSSH PRIVATE KEY----- done`,
    },
    { message: "-----BEGIN RSA PRIVATE KEY-----" },
    { message: SPLIT_KEY_BODY },
    { message: "-----END RSA PRIVATE KEY-----" },
    { message: "plain line stays" },
  ];
}

async function start() {
  const started = await startCompanions();
  harness = started.harness;
  // The connection gets a Cloudflare Access pair, so snapshot.secrets() holds it.
  const ctx = started.harness.mock.ctx;
  started.harness.db.sqlite
    .prepare(
      "UPDATE p_coolify_connections SET cf_access_id_sealed = ?, cf_access_secret_sealed = ? WHERE id = ?",
    )
    .run(
      await ctx.secrets.seal("fake-access-id.access"),
      await ctx.secrets.seal(ACCESS_SECRET),
      started.connectionId,
    );
  return started;
}

/** Hits the Log Search fake answers with, in the given order. */
function answerWith(
  companions: Awaited<ReturnType<typeof startCompanions>>["companions"],
  hits: unknown[],
) {
  companions.actions["log-search.search"] = () => ({
    summary: `${hits.length} lines`,
    data: { results: hits },
  });
}

function expectMasked(shown: string) {
  for (const leak of [...LEAKS, SPLIT_KEY_BODY]) {
    expect(shown, leak).not.toContain(leak);
  }
  expect(shown).toContain("plain line stays");
  expect(shown).toContain("[redacted]");
}

/** The plugin's ctx with ctx.operations.run answered by `run`, as core's gate would. */
function withRun(
  ctx: PluginContext,
  run: (
    actionId: string,
    options?: PluginOperationInvokeOptions,
  ) => Promise<PluginOperationOutcome>,
): PluginContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "operations") return { ...target.operations, run };
      return Reflect.get(target, prop);
    },
  });
}

describe("Log Search hits are redacted", () => {
  it("on the route", async () => {
    const { harness: h, companions, connectionId } = await start();
    answerWith(companions, leakyHits());
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/log-search?uuid=app-web-uuid`,
    );
    expect(res.status).toBe(200);
    const results = (res.body as { results: { message: string }[] }).results;
    expect(results).toHaveLength(leakyHits().length);
    expectMasked(JSON.stringify(res.body));
  });

  it("through coolify.companion-read", async () => {
    const { harness: h, companions, connectionId } = await start();
    answerWith(companions, leakyHits());
    const runs = withRunHistory(h.mock);
    const outcome = await runs.run("coolify.companion-read", {
      connectionId: String(connectionId),
      kind: "log-search",
      params: { uuid: "app-web-uuid" },
    });
    expectMasked(JSON.stringify(outcome.data));
    for (const leak of LEAKS) {
      expect(JSON.stringify(runs.history)).not.toContain(leak);
    }
  });

  it("over MCP", async () => {
    const { harness: h, companions, connectionId } = await start();
    answerWith(companions, leakyHits());
    const runs = withRunHistory(h.mock);
    const ctx = withRun(h.mock.ctx, (id, options) =>
      runs.run(id, options?.input ?? {}),
    );
    h.mock.setActor(OWNER);
    const answer = await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__companion_read",
        arguments: {
          connectionId: String(connectionId),
          kind: "log-search",
          params: { uuid: "app-web-uuid" },
        },
      },
    });
    const result = answer?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    expectMasked(result.content.map((c) => c.text).join("\n"));
  });

  it("masks a key body split over hits in either order", async () => {
    const { harness: h, companions, connectionId } = await start();
    const split = [
      { message: "before" },
      { message: "-----BEGIN EC PRIVATE KEY-----" },
      { message: SPLIT_KEY_BODY },
      { message: `${SPLIT_KEY_BODY}-----END EC PRIVATE KEY----- after` },
      { message: "plain line stays" },
    ];
    for (const hits of [split, [...split].reverse()]) {
      answerWith(companions, hits);
      const res = await h.request(
        "GET",
        `/connections/${connectionId}/log-search?uuid=app-web-uuid`,
      );
      expect(res.status).toBe(200);
      expectMasked(JSON.stringify(res.body));
      const messages = (
        res.body as { results: { message: string }[] }
      ).results.map((r) => r.message);
      expect(messages).toHaveLength(hits.length);
      expect(messages).toContain("before");
    }
  });

  it("masks every message when the key markers fit neither order", async () => {
    const { harness: h, companions, connectionId } = await start();
    // An END no BEGIN opened, read either way: the body could be anywhere.
    answerWith(companions, [
      { message: SPLIT_KEY_BODY },
      { message: "-----END RSA PRIVATE KEY-----" },
      { message: SPLIT_KEY_BODY },
    ]);
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/log-search?uuid=app-web-uuid`,
    );
    expect(res.status).toBe(200);
    expect(
      (res.body as { results: { message: string }[] }).results.map(
        (r) => r.message,
      ),
    ).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
  });

  it("finds a lone END after complete blocks on the same hit", async () => {
    const { harness: h, companions, connectionId } = await start();
    const inline = (kind: string) =>
      `-----BEGIN ${kind}PRIVATE KEY-----inline-----END ${kind}PRIVATE KEY-----`;
    const lone = "-----END EC PRIVATE KEY-----";
    for (const tail of [
      // A complete block, then an END of another kind that nothing opened.
      `${inline("RSA ")} ${lone}`,
      // Two complete blocks, then the lone END.
      `${inline("RSA ")} ${inline("OPENSSH ")} ${lone}`,
    ]) {
      answerWith(companions, [{ message: SPLIT_KEY_BODY }, { message: tail }]);
      const res = await h.request(
        "GET",
        `/connections/${connectionId}/log-search?uuid=app-web-uuid`,
      );
      expect(res.status).toBe(200);
      // Soft, so each variant is reported on its own.
      expect
        .soft(
          (res.body as { results: { message: string }[] }).results.map(
            (r) => r.message,
          ),
          tail,
        )
        .toEqual(["[redacted]", "[redacted]"]);
    }
  });

  it("redacts before the message is cut, so a cut never splits a secret", async () => {
    const { harness: h, companions, connectionId } = await start();
    // The token straddles the 2,000 character cut.
    answerWith(companions, [
      { message: `${"x".repeat(1990)}${TOKEN} tail` },
      { message: "plain line stays" },
    ]);
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/log-search?uuid=app-web-uuid`,
    );
    const shown = JSON.stringify(res.body);
    expect(shown).not.toContain(TOKEN.slice(0, 10));
  });
});
