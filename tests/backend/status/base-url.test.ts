import { afterEach, describe, expect, it, vi } from "vitest";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import {
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  knownBaseUrl,
  rememberBaseUrl,
} from "../../../src/backend/status/base-url.js";
import { takeOnceUrl } from "../../../src/backend/status/service.js";

const CHOSEN = ["app-web-uuid"];
const ATTACKER = "https://attacker.example";
const OWN = "https://termix.example.test";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

/**
 * Each user's requests carry the address they choose: the other user sends
 * an attacker's host, the owner Termix's own.
 */
async function start(bases: Record<string, string> = {}) {
  const fake = healthyCoolify(resourceLists());
  harness = await startPlugin({ fetch: fake.fetch });
  const h = harness;
  const byUser: Record<string, string> = {
    [OWNER]: OWN,
    [OTHER]: ATTACKER,
    ...bases,
  };
  vi.spyOn(h.mock.ctx.http, "baseUrl").mockImplementation(
    (req: unknown) =>
      byUser[
        String(
          (req as { headers?: Record<string, unknown> })?.headers?.[
            "x-test-user"
          ] ?? OWNER,
        )
      ] ?? OWN,
  );
  const owner = await h.request("POST", "/connections", {
    name: "Mine",
    baseUrl: "https://coolify.example.test",
    token: "fake-token-base-owner",
  });
  const other = await h.request(
    "POST",
    "/connections",
    {
      name: "Theirs",
      baseUrl: "https://coolify.example.test",
      token: "fake-token-base-other",
    },
    OTHER,
  );
  return {
    harness: h,
    runs: withRunHistory(h.mock),
    ownerConnection: owner.body.id as number,
    otherConnection: other.body.id as number,
  };
}

describe("status page URL base", () => {
  it("a base URL seen from user A is never used for user B's page URL, for an operation create and a rotate", async () => {
    const { harness, runs, ownerConnection } = await start();
    // The attacker's signed-in request comes last.
    await harness.request("GET", "/connections", undefined, OTHER);
    harness.mock.setActor(OWNER);
    const created = await runs.run("coolify.status-page-create", {
      connectionId: String(ownerConnection),
      title: "Shop status",
      resources: CHOSEN,
    });
    const { id, handoffId } = created.data as { id: number; handoffId: string };
    const url = takeOnceUrl(OWNER, handoffId)!;
    expect(url.startsWith(`${OWN}/plugin-api/coolify/status/`)).toBe(true);

    await harness.request("GET", "/connections", undefined, OTHER);
    harness.mock.setActor(OWNER);
    const rotated = await runs.run("coolify.status-page-rotate", {
      id: String(id),
    });
    const next = takeOnceUrl(
      OWNER,
      (rotated.data as { handoffId: string }).handoffId,
    )!;
    expect(next.startsWith(`${OWN}/plugin-api/coolify/status/`)).toBe(true);
    expect(`${url} ${next}`).not.toContain("attacker");
  });

  it("an actor with no address of their own gets a relative URL, never another user's", async () => {
    const { harness } = await start();
    await harness.request("GET", "/connections", undefined, OTHER);
    expect(await knownBaseUrl(harness.mock.ctx, "user-3")).toBeNull();
  });

  it("the create route builds the URL from its own request", async () => {
    const { harness, ownerConnection } = await start();
    // Another user's request lands while the owner's create is running.
    const settings = harness.mock.ctx.settings;
    const realGet = settings.get.bind(settings);
    let interleaved = false;
    vi.spyOn(settings, "get").mockImplementation(async (key: string) => {
      if (key === "allowStatusPages" && !interleaved) {
        interleaved = true;
        await harness.request("GET", "/connections", undefined, OTHER);
        harness.mock.setActor(OWNER);
      }
      return realGet(key);
    });
    const answer = await harness.request(
      "POST",
      `/connections/${ownerConnection}/status-pages`,
      { title: "Shop status", resources: CHOSEN },
    );
    expect(answer.status).toBe(201);
    expect(interleaved).toBe(true);
    expect(
      answer.body.url.startsWith(`${OWN}/plugin-api/coolify/status/`),
    ).toBe(true);
  });

  it("a non-http base is ignored", async () => {
    const { harness } = await start({ "user-4": "javascript:alert(1)" });
    const ctx = harness.mock.ctx;
    await harness.mock.actAs(OTHER, () =>
      rememberBaseUrl(ctx, { headers: { "x-test-user": OTHER } }),
    );
    await harness.mock.actAs("user-4", () =>
      rememberBaseUrl(ctx, { headers: { "x-test-user": "user-4" } }),
    );
    expect(await knownBaseUrl(ctx, "user-4")).toBeNull();
    expect(await knownBaseUrl(ctx, OTHER)).toBe(ATTACKER);
  });

  it("an address stored under the old shared key reads as nothing", async () => {
    const { harness } = await start();
    await harness.mock.ctx.kv.set("publicBaseUrl", ATTACKER);
    expect(await knownBaseUrl(harness.mock.ctx, "user-5")).toBeNull();
  });
});
