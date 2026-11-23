import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventually } from "../../shared/timing.js";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import { ANON, startPlugin, type PluginHarness } from "../helpers/plugin.js";
import { byText } from "../helpers/order.js";
import { issueWebhookToken } from "../../../src/backend/webhooks/service.js";
import { COOLIFY_WEBHOOKS } from "../fixtures/coolify-webhooks.js";
import { POLL_AWAKE_REASON } from "../../../src/backend/poll/service.js";

const TOKEN = "fake-token-webhook-route";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(
  overrides: Parameters<typeof healthyCoolify>[0] = {
    "GET /applications/app-web-uuid": { json: { uuid: "app-web-uuid" } },
  },
) {
  const fake = healthyCoolify(overrides);
  harness = await startPlugin({ fetch: fake.fetch });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: TOKEN,
  });
  const id = created.body.id as number;
  const { instance_key } = harness.db.sqlite
    .prepare("SELECT instance_key FROM p_coolify_connections WHERE id = ?")
    .get(id) as { instance_key: string };
  const issued = issueWebhookToken();
  harness.db.sqlite
    .prepare(
      "INSERT INTO p_coolify_webhooks (instance_key, token_hash, created_by_user_id) VALUES (?, ?, ?)",
    )
    .run(instance_key, issued.tokenHash, "user-1");
  return { harness, fake, id, token: issued.token };
}

/** Posts raw text as JSON with no signed-in user, keeping the answer as text. */
async function post(h: PluginHarness, path: string, text: string) {
  const response = await fetch(`http://127.0.0.1:${h.address!.port}${path}`, {
    method: "POST",
    headers: { "x-test-user": ANON, "content-type": "application/json" },
    body: text,
  });
  h.mock.setActor("user-1");
  return { status: response.status, text: await response.text() };
}

function events(h: PluginHarness) {
  return h.db.sqlite.prepare("SELECT * FROM p_coolify_events").all();
}

function lastReceived(h: PluginHarness) {
  return (
    h.db.sqlite
      .prepare("SELECT last_received_at FROM p_coolify_webhooks")
      .get() as { last_received_at: string | null }
  ).last_received_at;
}

describe("POST /webhook/:token", () => {
  it("answers 200 with a fixed body and ingests the event", async () => {
    const { harness: h, token } = await start();
    const answer = await post(
      h,
      `/webhook/${token}`,
      JSON.stringify(COOLIFY_WEBHOOKS.deployment_failed),
    );
    expect(answer).toEqual({ status: 200, text: '{"ok":true}' });
    expect(lastReceived(h)).not.toBeNull();
    await eventually(() => expect(events(h)).toHaveLength(1));
  });

  it("answers before the fan-out's check is answered", async () => {
    const { harness: h, token } = await start({
      "GET /applications/app-web-uuid": () =>
        new Promise<Response>(() => {}) as unknown as Response,
    });
    const answer = await post(
      h,
      `/webhook/${token}`,
      JSON.stringify(COOLIFY_WEBHOOKS.deployment_failed),
    );
    expect(answer.status).toBe(200);
    expect(events(h)).toHaveLength(0);
  });

  it("an unknown token and a bad body get the same answer, and nothing is stored", async () => {
    const { harness: h, token, fake } = await start();
    const before = fake.calls.length;
    const unknown = crypto.randomBytes(32).toString("base64url");
    const good = JSON.stringify(COOLIFY_WEBHOOKS.deployment_failed);
    const answers = [
      await post(h, `/webhook/${unknown}`, good),
      await post(h, "/webhook/not-a-token", good),
      await post(
        h,
        `/webhook/${token}`,
        JSON.stringify({ ...COOLIFY_WEBHOOKS.deployment_failed, extra: "x" }),
      ),
      await post(
        h,
        `/webhook/${token}`,
        JSON.stringify({ ...COOLIFY_WEBHOOKS.test, event: "unknown_event" }),
      ),
      // A bare JSON string never reaches the route: the body parser in
      // front of it (core's) refuses it.
      await post(h, `/webhook/${token}`, "[1,2]"),
      await post(h, `/webhook/${token}`, "{}"),
    ];
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0].status).toBe(400);
    expect(lastReceived(h)).toBeNull();
    expect(events(h)).toHaveLength(0);
    expect(fake.calls.length).toBe(before);
  });

  it("refuses 64 KB plus one byte, and takes exactly 64 KB", async () => {
    const { harness: h, token } = await start();
    const sized = (bytes: number) => {
      const shell = JSON.stringify({ ...COOLIFY_WEBHOOKS.test, message: "" });
      const text = JSON.stringify({
        ...COOLIFY_WEBHOOKS.test,
        message: "x".repeat(bytes - shell.length),
      });
      expect(Buffer.byteLength(text)).toBe(bytes);
      return text;
    };
    const over = await post(h, `/webhook/${token}`, sized(65_537));
    expect(over.status).toBe(400);
    expect(lastReceived(h)).toBeNull();
    const at = await post(h, `/webhook/${token}`, sized(65_536));
    expect(at.status).toBe(200);
  });

  it("never echoes the token or anything in the body", async () => {
    const { harness: h, token } = await start();
    const marker = "echo-marker-7f3a";
    const bodies = [
      { ...COOLIFY_WEBHOOKS.test, message: marker },
      { ...COOLIFY_WEBHOOKS.test, message: marker, [marker]: marker },
    ];
    for (const body of bodies) {
      for (const t of [token, `${marker}${"a".repeat(27)}`]) {
        const answer = await post(h, `/webhook/${t}`, JSON.stringify(body));
        expect(answer.text).not.toContain(marker);
        expect(answer.text).not.toContain(token);
      }
    }
  });

  it("is declared public on the router, without raising core's public rate limit", async () => {
    const { harness: h } = await start();
    const publicPaths = h.mock.httpRouters.flatMap((o) => o?.public ?? []);
    expect(publicPaths.sort(byText)).toEqual(
      ["/status/:token", "/status/:token.json", "/webhook/:token"].sort(byText),
    );
    expect(
      h.mock.httpRouters.some((o) => o?.publicRateLimit !== undefined),
    ).toBe(false);
  });
});

describe("the webhook and the poller (T120)", () => {
  it("after an accepted delivery for its team, a connection polls only with pollEnabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.parse("2026-11-23T10:00:00.000Z");
    vi.setSystemTime(T0);
    const {
      harness: h,
      fake,
      token,
      id,
    } = await start({
      "GET /deployments": { json: [] },
      "GET /servers": { json: [] },
    });
    const polls = () =>
      fake.calls.filter((c) => c.path === "/deployments").length;
    const pollAt = async (ms: number) => {
      vi.setSystemTime(ms);
      h.mock.setActor(undefined);
      try {
        await h.mock.runScheduled();
      } finally {
        h.mock.setActor("user-1");
      }
    };
    await pollAt(T0);
    expect(polls()).toBe(1);
    expect(h.mock.awake.has(POLL_AWAKE_REASON)).toBe(true);

    const answer = await post(
      h,
      `/webhook/${token}`,
      JSON.stringify(COOLIFY_WEBHOOKS.test),
    );
    expect(answer.status).toBe(200);
    await pollAt(T0 + 60_000);
    // pollEnabled is off (the default), so the webhook replaces polling.
    expect(polls()).toBe(1);
    expect(h.mock.awake.has(POLL_AWAKE_REASON)).toBe(false);

    const outcome = await h.mock.ctx.operations.run(
      "coolify.connection-set-poll",
      { input: { connectionId: String(id), pollEnabled: true } },
    );
    expect(outcome.data).toMatchObject({ id, pollEnabled: true });
    await pollAt(T0 + 2 * 60_000);
    expect(polls()).toBe(2);
  });
});
