import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import {
  ANON,
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists, SECRET } from "../helpers/resources.js";
import {
  KEEP_AWAKE_REASON,
  STATUS_REFRESH_ID,
} from "../../../src/backend/status/service.js";

const TOKEN = "fake-token-status-pages";
const connectionBody = {
  name: "Prod",
  baseUrl: "https://coolify.example.test",
  token: TOKEN,
};
const CHOSEN = ["app-web-uuid", "app-api-uuid"];
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(
  options: {
    permissions?: string[];
    settings?: Record<string, unknown>;
  } = {},
) {
  const fake = healthyCoolify(resourceLists());
  harness = await startPlugin({ fetch: fake.fetch, ...options });
  const created = await harness.request("POST", "/connections", connectionBody);
  return { harness, fake, id: (created.body?.id ?? 1) as number };
}

/** The token part of a status page URL. */
function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function publicPath(url: string): string {
  return `/status/${tokenOf(url)}`;
}

async function publish(
  h: PluginHarness,
  id: number,
  body: Record<string, unknown> = { title: "Shop status", resources: CHOSEN },
) {
  const answer = await h.request(
    "POST",
    `/connections/${id}/status-pages`,
    body,
  );
  expect(answer.status).toBe(201);
  return answer.body as { id: number; url: string };
}

/** Fills the resource cache the way a signed-in Resources view does. */
async function warm(h: PluginHarness, id: number) {
  const answer = await h.request("GET", `/connections/${id}/resources`);
  expect(answer.status).toBe(200);
}

function applicationsWith(status: string) {
  const lists = resourceLists();
  const apps = (lists["GET /applications"] as { json: any[] }).json;
  return {
    json: apps.map((a) => (a.uuid === "app-web-uuid" ? { ...a, status } : a)),
  };
}

describe("status page routes", () => {
  it("create answers the URL once with a 32-byte base64url token, and stores only its sha256", async () => {
    const { harness, id } = await start();
    const page = await publish(harness, id);
    expect(page.url).toMatch(
      /^https:\/\/termix\.test\/plugin-api\/coolify\/status\/[A-Za-z0-9_-]{43}$/,
    );
    const token = tokenOf(page.url);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const rows = harness.db.sqlite
      .prepare("SELECT * FROM p_coolify_status_pages")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(
      crypto.createHash("sha256").update(token).digest("hex"),
    );
    expect(JSON.stringify(rows)).not.toContain(token);
    const list = await harness.request(
      "GET",
      `/connections/${id}/status-pages`,
    );
    expect(list.status).toBe(200);
    expect(list.body.pages).toEqual([
      expect.objectContaining({
        id: page.id,
        title: "Shop status",
        resources: CHOSEN,
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it("create refused when admin allowStatusPages is off, and existing pages answer 404 while it is off", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      200,
    );
    await harness.mock.ctx.settings.set("allowStatusPages", false);
    const refused = await harness.request(
      "POST",
      `/connections/${id}/status-pages`,
      { title: "Another", resources: CHOSEN },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.cause).toBe("status-pages-off");
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      404,
    );
    expect(
      (await harness.raw("GET", `${publicPath(page.url)}.json`, ANON)).status,
    ).toBe(404);
    await harness.mock.ctx.settings.set("allowStatusPages", true);
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      200,
    );
  });

  it("unknown or revoked token 404", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const unknown = crypto.randomBytes(32).toString("base64url");
    expect((await harness.raw("GET", `/status/${unknown}`, ANON)).status).toBe(
      404,
    );
    expect((await harness.raw("GET", "/status/short", ANON)).status).toBe(404);
    const revoked = await harness.request("DELETE", `/status-pages/${page.id}`);
    expect(revoked.status).toBe(200);
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      404,
    );
    expect(
      (await harness.raw("GET", `${publicPath(page.url)}.json`, ANON)).status,
    ).toBe(404);
    const list = await harness.request(
      "GET",
      `/connections/${id}/status-pages`,
    );
    expect(list.body.pages).toEqual([]);
  });

  it("rotate answers a new URL once and the old one stops working", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const rotated = await harness.request(
      "POST",
      `/status-pages/${page.id}/rotate`,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.id).toBe(page.id);
    expect(rotated.body.url).not.toBe(page.url);
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      404,
    );
    expect(
      (await harness.raw("GET", publicPath(rotated.body.url), ANON)).status,
    ).toBe(200);
  });

  it("page lists only chosen resources and no uuids", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const html = await harness.raw("GET", publicPath(page.url), ANON);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toMatch(/^text\/html/);
    expect(html.text).toContain("Shop status");
    expect(html.text).toContain(">web<");
    expect(html.text).toContain(">api<");
    for (const hidden of ["docs", "worker", "blog", "n8n", "main-db"]) {
      expect(html.text).not.toContain(`>${hidden}<`);
    }
    const json = await harness.raw("GET", `${publicPath(page.url)}.json`, ANON);
    expect(json.status).toBe(200);
    const body = JSON.parse(json.text);
    expect(body.items.map((i: { name: string }) => i.name)).toEqual([
      "web",
      "api",
    ]);
    for (const text of [html.text, json.text]) {
      expect(text).not.toMatch(/-uuid/);
      expect(text).not.toContain("vps1");
      expect(text).not.toContain("edge");
      expect(text).not.toContain("https://a.x");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(tokenOf(page.url));
    }
  });

  it("html escapes names", async () => {
    const { harness, fake, id } = await start();
    const lists = resourceLists();
    const apps = (lists["GET /applications"] as { json: any[] }).json;
    fake.set("GET /applications", {
      json: apps.map((a) =>
        a.uuid === "app-web-uuid" ? { ...a, name: "<img src=x>" } : a,
      ),
    });
    await warm(harness, id);
    const page = await publish(harness, id, {
      title: "<b>Shop</b> & co",
      resources: CHOSEN,
    });
    const html = await harness.raw("GET", publicPath(page.url), ANON);
    expect(html.text).not.toContain("<img src=x>");
    expect(html.text).toContain("&lt;img src=x&gt;");
    expect(html.text).not.toContain("<b>Shop</b>");
    expect(html.text).toContain("&lt;b&gt;Shop&lt;/b&gt; &amp; co");
  });

  it("no script tags, a 30 second meta refresh and its own strict CSP", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const html = await harness.raw("GET", publicPath(page.url), ANON);
    expect(html.text.toLowerCase()).not.toContain("<script");
    expect(html.text).not.toMatch(/\son[a-z]+=/i);
    expect(html.text).toContain('<meta http-equiv="refresh" content="30">');
    expect(html.headers.get("content-security-policy")).toBe(CSP);
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(html.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("served from cache without fetching Coolify", async () => {
    const { harness, fake, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const before = fake.calls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      200,
    );
    expect(
      (await harness.raw("GET", `${publicPath(page.url)}.json`, ANON)).status,
    ).toBe(200);
    expect(fake.calls.length).toBe(before);
  });

  it("background refresh picks up a status change with no signed-in view", async () => {
    const { harness, fake, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const json = async () =>
      JSON.parse(
        (await harness.raw("GET", `${publicPath(page.url)}.json`, ANON)).text,
      );
    expect((await json()).items[0]).toMatchObject({
      name: "web",
      status: "running",
    });
    fake.set("GET /applications", applicationsWith("running:unhealthy"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    harness.mock.setActor(undefined);
    await harness.mock.runScheduled();
    expect((await json()).items[0]).toMatchObject({
      name: "web",
      status: "degraded",
    });
  });

  it("the refresh job is declared with jitter and keeps the process awake while a page is published", async () => {
    const { harness, id } = await start();
    expect(harness.mock.awake.has(KEEP_AWAKE_REASON)).toBe(false);
    const declared = (harness.mock.ctx.manifest.sandbox?.schedules ?? []).map(
      (s: string | { id: string }) => (typeof s === "string" ? s : s.id),
    );
    expect(declared).toContain(STATUS_REFRESH_ID);
    expect(
      harness.mock.scheduled.filter((j) => j.kind === "every" && !j.stopped),
    ).toEqual([expect.objectContaining({ ms: 60_000 })]);
    await publish(harness, id);
    expect(harness.mock.awake.has(KEEP_AWAKE_REASON)).toBe(true);
  });

  it("stale cache shows the out-of-date banner", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const fresh = await harness.raw("GET", publicPath(page.url), ANON);
    expect(fresh.text).not.toContain("Status may be out of date");
    expect(fresh.text).toContain("Updated");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const stale = await harness.raw("GET", publicPath(page.url), ANON);
    expect(stale.text).toContain("Status may be out of date");
    const json = JSON.parse(
      (await harness.raw("GET", `${publicPath(page.url)}.json`, ANON)).text,
    );
    expect(json.stale).toBe(true);
  });

  it("a page with no cached status yet says it may be out of date instead of claiming health", async () => {
    const { harness, id } = await start();
    const page = await publish(harness, id);
    const html = await harness.raw("GET", publicPath(page.url), ANON);
    expect(html.status).toBe(200);
    expect(html.text).toContain("Status may be out of date");
  });

  it("refresh backs off 1, 2, 5, then 15 minutes after errors", async () => {
    const { harness, fake, id } = await start();
    await publish(harness, id);
    // 401 is not retried, so each attempt is one request.
    fake.set("GET /applications", {
      status: 401,
      json: { message: "Unauthenticated." },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.now();
    vi.setSystemTime(now);
    harness.mock.setActor(undefined);
    const attempts = () =>
      fake.calls.filter((c) => c.path === "/applications").length;
    const tick = async (advanceMs: number) => {
      now += advanceMs;
      vi.setSystemTime(now);
      const before = attempts();
      await harness.mock.runScheduled();
      return attempts() > before;
    };
    expect(await tick(0)).toBe(true);
    for (const minutes of [1, 2, 5, 15, 15]) {
      expect(await tick(minutes * 60_000 - 1_000)).toBe(false);
      expect(await tick(1_000)).toBe(true);
    }
  });

  it("refresh stops and keepAwake false when the last page is revoked", async () => {
    const { harness, fake, id } = await start();
    const first = await publish(harness, id);
    const second = await publish(harness, id, {
      title: "Second",
      resources: ["app-api-uuid"],
    });
    expect(harness.mock.awake.has(KEEP_AWAKE_REASON)).toBe(true);
    await harness.request("DELETE", `/status-pages/${first.id}`);
    expect(harness.mock.awake.has(KEEP_AWAKE_REASON)).toBe(true);
    await harness.request("DELETE", `/status-pages/${second.id}`);
    expect(harness.mock.awake.has(KEEP_AWAKE_REASON)).toBe(false);
    const before = fake.calls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    harness.mock.setActor(undefined);
    await harness.mock.runScheduled();
    expect(fake.calls.length).toBe(before);
    expect(harness.mock.awake.has(KEEP_AWAKE_REASON)).toBe(false);
  });

  it("token compared in constant time", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      200,
    );
    expect(spy).toHaveBeenCalled();
    const [a, b] = spy.mock.calls[0] as [Buffer, Buffer];
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
  });

  it("another user's connection or page reads as missing, and management needs coolify.configure", async () => {
    const { harness, id } = await start();
    const page = await publish(harness, id);
    const other = (method: string, path: string, body?: unknown) =>
      harness.request(method, path, body, OTHER);
    expect((await other("GET", `/connections/${id}/status-pages`)).status).toBe(
      404,
    );
    expect(
      (
        await other("POST", `/connections/${id}/status-pages`, {
          title: "x",
          resources: CHOSEN,
        })
      ).status,
    ).toBe(404);
    expect(
      (await other("POST", `/status-pages/${page.id}/rotate`)).status,
    ).toBe(404);
    expect((await other("DELETE", `/status-pages/${page.id}`)).status).toBe(
      404,
    );
  });

  it("refuses bad input with 400", async () => {
    const { harness, id } = await start();
    for (const body of [
      { title: "", resources: CHOSEN },
      { title: "x", resources: [] },
      { title: "x", resources: ["not a uuid!"] },
      { title: "x", resources: "app-web-uuid" },
    ]) {
      const answer = await harness.request(
        "POST",
        `/connections/${id}/status-pages`,
        body,
      );
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("without coolify.configure, create, rotate, revoke and the handoff answer 403", async () => {
    const { harness, id } = await start({ permissions: ["coolify.view"] });
    const create = await harness.request(
      "POST",
      `/connections/${id}/status-pages`,
      { title: "x", resources: CHOSEN },
    );
    expect(create.status).toBe(403);
    expect(
      (await harness.request("POST", "/status-pages/1/rotate")).status,
    ).toBe(403);
    expect((await harness.request("DELETE", "/status-pages/1")).status).toBe(
      403,
    );
    expect(
      (await harness.request("POST", "/status-pages/handoff/run-1")).status,
    ).toBe(403);
  });

  it("the public routes are declared public on the router", async () => {
    const { harness } = await start();
    const publicPaths = harness.mock.httpRouters.flatMap(
      (o) => o?.public ?? [],
    );
    expect(publicPaths.sort()).toEqual(
      ["/status/:token", "/status/:token.json"].sort(),
    );
    // Core's public rate limit (120 a minute per address) stays in force.
    expect(
      harness.mock.httpRouters.some((o) => o?.publicRateLimit !== undefined),
    ).toBe(false);
  });
});

describe("status page connection checks", () => {
  /** The 404 an unknown token gets, to compare other refusals with. */
  async function unknownAnswer(h: PluginHarness) {
    const unknown = crypto.randomBytes(32).toString("base64url");
    const page = await h.raw("GET", `/status/${unknown}.json`, ANON);
    return { status: page.status, text: page.text };
  }

  it("a page whose connection is gone answers the same 404 as an unknown token", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    harness.db.sqlite
      .prepare("DELETE FROM p_coolify_connections WHERE id = ?")
      .run(id);
    const gone = await harness.raw("GET", `${publicPath(page.url)}.json`, ANON);
    expect({ status: gone.status, text: gone.text }).toEqual(
      await unknownAnswer(harness),
    );
    expect((await harness.raw("GET", publicPath(page.url), ANON)).status).toBe(
      404,
    );
  });

  it("a page whose owner lost coolify.view answers 404, and the refresh stops using their token", async () => {
    const { harness, fake, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const hasFor = vi
      .spyOn(harness.mock.ctx.rbac, "hasFor")
      .mockImplementation(
        async (userId, permission) =>
          !(userId === OWNER && permission === "view"),
      );
    const lost = await harness.raw("GET", `${publicPath(page.url)}.json`, ANON);
    expect({ status: lost.status, text: lost.text }).toEqual(
      await unknownAnswer(harness),
    );
    expect(hasFor).toHaveBeenCalledWith(OWNER, "view");
    const before = fake.calls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    harness.mock.setActor(undefined);
    await harness.mock.runScheduled();
    expect(fake.calls.length).toBe(before);
  });

  it("after the connection is repointed, old rows aren't shown and only the chosen uuids come from the new target", async () => {
    const { harness, fake, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    const items = async () =>
      JSON.parse(
        (await harness.raw("GET", `${publicPath(page.url)}.json`, ANON)).text,
      ).items.map((i: { name: string }) => i.name);
    expect(await items()).toEqual(["web", "api"]);
    const moved = await harness.request("PATCH", `/connections/${id}`, {
      baseUrl: "https://other-coolify.example.test",
    });
    expect(moved.status).toBe(200);
    // The rows cached for the old target are never shown for the new one.
    expect(await items()).toEqual([]);
    const lists = resourceLists();
    const apps = (lists["GET /applications"] as { json: any[] }).json;
    fake.set("GET /applications", {
      json: apps.map((a) => ({
        ...a,
        uuid: `other-${a.uuid}`,
        name: `other-${a.name}`,
      })),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    harness.mock.setActor(undefined);
    await harness.mock.runScheduled();
    expect(await items()).toEqual([]);
  });
});

describe("status page load", () => {
  it("concurrent views of one page share one read", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    // The first read is held at its access check until every view arrived.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = harness.mock.ctx.rbac.hasFor;
    const hasFor = vi
      .spyOn(harness.mock.ctx.rbac, "hasFor")
      .mockImplementation(async (userId, permission) => {
        await held;
        return real(userId, permission);
      });
    const settings = vi.spyOn(harness.mock.ctx.settings, "get");
    const views = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        harness.raw(
          "GET",
          `${publicPath(page.url)}${i % 2 ? ".json" : ""}`,
          ANON,
        ),
      ),
    );
    await vi.waitFor(() =>
      expect(
        settings.mock.calls.filter(([key]) => key === "allowStatusPages"),
      ).toHaveLength(5),
    );
    release();
    expect((await views).map((v) => v.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(hasFor).toHaveBeenCalledTimes(1);
  });

  it("a view that starts after a rotate never joins a read from before it", async () => {
    const { harness, id } = await start();
    await warm(harness, id);
    const page = await publish(harness, id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = harness.mock.ctx.rbac.hasFor;
    const hasFor = vi
      .spyOn(harness.mock.ctx.rbac, "hasFor")
      .mockImplementationOnce(async (userId, permission) => {
        await held;
        return real(userId, permission);
      });
    const before = harness.raw("GET", `${publicPath(page.url)}.json`, ANON);
    // The first read is held at its access check while the rotate lands.
    await vi.waitFor(() => expect(hasFor).toHaveBeenCalled());
    const rotated = await harness.request(
      "POST",
      `/status-pages/${page.id}/rotate`,
    );
    expect(rotated.status).toBe(200);
    const after = harness.raw("GET", `${publicPath(page.url)}.json`, ANON);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await before;
    expect((await after).status).toBe(404);
  });
});
