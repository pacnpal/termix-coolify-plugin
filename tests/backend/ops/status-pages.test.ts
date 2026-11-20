import { afterEach, describe, expect, it } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import {
  ANON,
  manifest,
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";
import { withRunHistory } from "../helpers/run-history.js";
import { takeOnceUrl } from "../../../src/backend/status/service.js";

const TOKEN = "fake-token-status-ops";
const CHOSEN = ["app-web-uuid", "app-api-uuid"];

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start() {
  const fake = healthyCoolify(resourceLists());
  harness = await startPlugin({ fetch: fake.fetch });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: TOKEN,
  });
  const id = created.body.id as number;
  await harness.request("GET", `/connections/${id}/resources`);
  return { harness, fake, id, runs: withRunHistory(harness.mock) };
}

function declared(id: string): OperationAction {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id)!;
}

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

async function handoff(h: PluginHarness, handoffId: string, user = OWNER) {
  return h.request(
    "POST",
    `/status-pages/handoff/${encodeURIComponent(handoffId)}`,
    undefined,
    user,
  );
}

describe("status page operations", () => {
  it("are declared with the 18A risks, model surfaces only on the read, and the URL as a sensitive output", () => {
    const risks: Record<string, string> = {
      "coolify.status-page-list": "read",
      "coolify.status-page-create": "change",
      "coolify.status-page-rotate": "destructive",
      "coolify.status-page-revoke": "destructive",
    };
    for (const [id, risk] of Object.entries(risks)) {
      const action = declared(id);
      expect(action, id).toBeTruthy();
      expect(action.risk, id).toBe(risk);
      expect(action.scope, id).toBe("server");
      const model = risk === "read";
      expect(action.surfaces?.assistant === true, id).toBe(model);
      expect(action.surfaces?.mcp === true, id).toBe(model);
    }
    for (const id of [
      "coolify.status-page-create",
      "coolify.status-page-rotate",
    ]) {
      const url = declared(id).outputs?.find((o) => o.key === "url");
      expect(url?.sensitive, id).toBe(true);
    }
  });

  it("status-page-create through ctx.operations.run keeps the URL out of history", async () => {
    const { harness, runs, id } = await start();
    const created = await runs.run("coolify.status-page-create", {
      connectionId: String(id),
      title: "Shop status",
      resources: CHOSEN,
    });
    const { handoffId, id: pageId } = created.data as {
      handoffId: string;
      id: number;
    };
    expect(typeof handoffId).toBe("string");
    expect(created.summary).toContain("Shop status");
    const taken = await handoff(harness, handoffId);
    expect(taken.status).toBe(200);
    const url = taken.body.url as string;
    expect(url).toMatch(/\/plugin-api\/coolify\/status\/[A-Za-z0-9_-]{43}$/);
    expect((await handoff(harness, handoffId)).status).toBe(404);
    expect(
      (await harness.raw("GET", `/status/${tokenOf(url)}`, ANON)).status,
    ).toBe(200);

    const rotated = await runs.run("coolify.status-page-rotate", {
      id: String(pageId),
    });
    const rotation = rotated.data as { handoffId: string; id: number };
    expect(rotation.id).toBe(pageId);
    expect(rotated.summary).toContain("Shop status");
    const next = await handoff(harness, rotation.handoffId);
    expect(next.status).toBe(200);
    expect(next.body.url).not.toBe(url);
    expect(
      (await harness.raw("GET", `/status/${tokenOf(url)}`, ANON)).status,
    ).toBe(404);
    expect(
      (await harness.raw("GET", `/status/${tokenOf(next.body.url)}`, ANON))
        .status,
    ).toBe(200);

    const history = JSON.stringify(runs.history);
    for (const leaked of [url, next.body.url]) {
      expect(history).not.toContain(leaked);
      expect(history).not.toContain(tokenOf(leaked));
    }
    for (const run of runs.history) {
      expect(run.summary).not.toMatch(/status\//);
    }
  });

  it("two concurrent rotations of one page each hand over their own URL", async () => {
    const { runs, id } = await start();
    const created = await runs.run("coolify.status-page-create", {
      connectionId: String(id),
      title: "Shop status",
      resources: CHOSEN,
    });
    const pageId = (created.data as { id: number }).id;
    const [one, two] = await Promise.all([
      runs.run(
        "coolify.status-page-rotate",
        { id: String(pageId) },
        { runId: "run-rotate-1" },
      ),
      runs.run(
        "coolify.status-page-rotate",
        { id: String(pageId) },
        { runId: "run-rotate-2" },
      ),
    ]);
    expect((one.data as { handoffId: string }).handoffId).toBe("run-rotate-1");
    expect((two.data as { handoffId: string }).handoffId).toBe("run-rotate-2");
    const urlOne = takeOnceUrl(OWNER, "run-rotate-1");
    const urlTwo = takeOnceUrl(OWNER, "run-rotate-2");
    expect(urlOne).toBeTruthy();
    expect(urlTwo).toBeTruthy();
    expect(urlOne).not.toBe(urlTwo);
    // The mock keeps sensitive outputs in the immediate answer, so each run's
    // own URL can be compared with what its handoff id gave back.
    expect(urlOne).toBe((one.data as { url: string }).url);
    expect(urlTwo).toBe((two.data as { url: string }).url);
    expect(JSON.stringify(runs.history)).not.toContain(tokenOf(urlOne!));
    expect(JSON.stringify(runs.history)).not.toContain(tokenOf(urlTwo!));
  });

  it("an approved rotation's URL can be taken once after approval", async () => {
    const { harness, runs, id } = await start();
    const created = await runs.run("coolify.status-page-create", {
      connectionId: String(id),
      title: "Shop status",
      resources: CHOSEN,
    });
    const pageId = (created.data as { id: number }).id;
    // Core answers "waiting for approval" with the run id; once someone
    // approves, it runs the handler with that run id as the same actor.
    const approved = await harness.mock.actAs(OWNER, () =>
      runs.run(
        "coolify.status-page-rotate",
        { id: String(pageId) },
        { runId: "run-approved-1" },
      ),
    );
    expect((approved.data as { handoffId: string }).handoffId).toBe(
      "run-approved-1",
    );
    expect((await handoff(harness, "run-approved-1", OTHER)).status).toBe(404);
    const taken = await handoff(harness, "run-approved-1");
    expect(taken.status).toBe(200);
    expect(
      (await harness.raw("GET", `/status/${tokenOf(taken.body.url)}`, ANON))
        .status,
    ).toBe(200);
    expect((await handoff(harness, "run-approved-1")).status).toBe(404);
    expect((await handoff(harness, "run-approved-1", OTHER)).status).toBe(404);
  });

  it("list returns the actor's pages as options, and revoke stops a page", async () => {
    const { harness, runs, id } = await start();
    const created = await runs.run("coolify.status-page-create", {
      connectionId: String(id),
      title: "Shop status",
      resources: CHOSEN,
    });
    const { id: pageId, handoffId } = created.data as {
      id: number;
      handoffId: string;
    };
    const url = (await handoff(harness, handoffId)).body.url as string;
    const listed = await runs.run("coolify.status-page-list", {});
    expect(listed.data).toMatchObject({
      options: [{ value: String(pageId), label: "Shop status" }],
      rows: [{ id: pageId, title: "Shop status", resources: CHOSEN }],
    });
    const scoped = await runs.run("coolify.status-page-list", {
      connectionId: String(id),
    });
    expect((scoped.data as { rows: unknown[] }).rows).toHaveLength(1);
    const revoked = await runs.run("coolify.status-page-revoke", {
      id: String(pageId),
    });
    expect(revoked.summary).toContain("Shop status");
    expect(
      (await harness.raw("GET", `/status/${tokenOf(url)}`, ANON)).status,
    ).toBe(404);
    const after = await runs.run("coolify.status-page-list", {});
    expect((after.data as { rows: unknown[] }).rows).toEqual([]);
  });
});
