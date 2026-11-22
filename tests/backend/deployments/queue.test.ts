import { afterEach, describe, expect, it } from "vitest";
import type { PluginOperationContext } from "@termix-ssh/plugin-sdk/backend";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import { queueAnswers, tagAnswers } from "../helpers/deployments.js";
import {
  changes,
  grant,
  LIFECYCLE_TOKEN,
  startLifecycle,
} from "../helpers/lifecycle.js";
import {
  manifest,
  OTHER,
  OWNER,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const applications = (resourceLists()["GET /applications"] as { json: unknown })
  .json;

async function start(
  permissions?: string[],
  serve = true,
  settings?: Record<string, unknown>,
) {
  const started = await startLifecycle({
    permissions,
    overrides: { ...queueAnswers(), ...tagAnswers(applications) },
    serve,
    settings,
  });
  harness = started.harness;
  return started;
}

function context(
  over: Partial<PluginOperationContext> = {},
): PluginOperationContext {
  return {
    runId: "run-test",
    dryRun: false,
    signal: new AbortController().signal,
    log: () => {},
    ...over,
  };
}

function handler(h: PluginHarness, id: string) {
  const found = h.mock.operationHandlers.get(id);
  if (!found) throw new Error(`${id} has no handler`);
  return found;
}

function action(id: string) {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id);
}

const uuids = (rows: { uuid: string }[]) => rows.map((r) => r.uuid);
const queueReads = (fake: Awaited<ReturnType<typeof start>>["fake"]) =>
  fake.calls.filter((c) => c.method === "GET" && c.path === "/deployments")
    .length;

/** A JSON answer that first runs `before`, as a change made mid-call. */
function after(before: () => void, body: unknown) {
  return () => {
    before();
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
}

describe("the connection's deployment queue", () => {
  it("shows running and recent deployments of the connection's own applications only", async () => {
    const { harness, id } = await start(["coolify.view"]);
    const answer = await harness.request(
      "GET",
      `/connections/${id}/deployments`,
    );
    expect(answer.status).toBe(200);
    expect(uuids(answer.body.running)).toEqual(["dep-run", "dep-api-queued"]);
    expect(answer.body.running[0]).toMatchObject({
      resourceUuid: "app-web-uuid",
      resourceName: "web",
      status: "in_progress",
    });
    expect(answer.body.running[1]).toMatchObject({ resourceName: "api" });
    // Newest first, ended ones only, never a foreign application's.
    expect(uuids(answer.body.recent)).toEqual([
      "dep-api-old",
      "dep-done",
      "dep-failed",
    ]);
    expect(typeof answer.body.fetchedAt).toBe("string");
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain("dep-elsewhere");
    expect(text).not.toContain("dep-nolink");
    expect(text).not.toContain("dep-api-foreign");
    expect(text).not.toContain("app-not-mine-uuid");
    // No build log ever rides along.
    expect(text).not.toContain("Starting");
    expect(text).not.toContain("foreign build line");
    expect(text).not.toContain(LIFECYCLE_TOKEN);
  });

  it("serves the section, the Overview and the operation from one cached read", async () => {
    const { harness, fake, id } = await start();
    const section = await harness.request(
      "GET",
      `/connections/${id}/deployments`,
    );
    const overview = await harness.request(
      "GET",
      `/connections/${id}/deployments`,
    );
    const op = await harness.mock.ctx.operations.run(
      "coolify.deployment-queue",
      { input: { connectionId: String(id) } },
    );
    expect(overview.body).toEqual(section.body);
    expect((op.data as { running: unknown[] }).running).toHaveLength(2);
    expect(queueReads(fake)).toBe(1);
    // refresh skips the cache.
    await harness.request("GET", `/connections/${id}/deployments?refresh=1`);
    expect(queueReads(fake)).toBe(2);
  });

  it("reads again once a cancel changed the queue", async () => {
    const { harness, fake, id } = await start();
    await harness.request("GET", `/connections/${id}/deployments`);
    await harness.request(
      "POST",
      `/connections/${id}/resources/app-web-uuid/deployments/dep-run/cancel`,
    );
    await harness.request("GET", `/connections/${id}/deployments`);
    expect(queueReads(fake)).toBe(2);
  });

  it("is a 404 for a connection the actor can't reach, and needs coolify.view", async () => {
    const { harness, fake, id } = await start();
    const other = await harness.request(
      "GET",
      `/connections/${id}/deployments`,
      undefined,
      OTHER,
    );
    expect(other.status).toBe(404);
    grant(harness, id, OTHER, "view");
    const viewGrant = await harness.request(
      "GET",
      `/connections/${id}/deployments`,
      undefined,
      OTHER,
    );
    expect(viewGrant.status).toBe(200);
    await harness.close();

    const none = await start([]);
    const refused = await none.harness.request(
      "GET",
      `/connections/${none.id}/deployments`,
    );
    expect(refused.status).toBe(403);
    expect(queueReads(none.fake)).toBe(0);
    expect(queueReads(fake)).toBe(1);
  });

  it("is never cached or served across a changed target", async () => {
    const { harness, fake, id } = await start();
    fake.set(
      "GET /deployments",
      after(() => {
        harness.db.sqlite
          .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
          .run("https://other.example.test", id);
      }, []),
    );
    const changed = await harness.request(
      "GET",
      `/connections/${id}/deployments`,
    );
    expect(changed.status).toBe(409);
    expect(changed.body.cause).toBe("target-changed");
  });

  it("declares coolify.deployment-queue as a read for view", () => {
    expect(action("coolify.deployment-queue")).toMatchObject({
      scope: "server",
      risk: "read",
      permission: "view",
      surfaces: { assistant: true, mcp: true },
    });
  });
});

describe("deploy by tag", () => {
  const preview = (id: number, query = "tag=prod") =>
    `/connections/${id}/deploy-by-tag?${query}`;

  it("lists the connection's own resources the tag will hit", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request("GET", preview(id));
    expect(answer.status).toBe(200);
    expect(answer.body.tag).toBe("prod");
    expect(
      answer.body.targets.map(
        (t: { uuid: string; name: string; kind: string }) => [
          t.uuid,
          t.name,
          t.kind,
        ],
      ),
    ).toEqual([
      ["app-web-uuid", "web", "application"],
      ["svc-n8n-uuid", "n8n", "service"],
    ]);
    expect(JSON.stringify(answer.body)).not.toContain("app-not-mine-uuid");
    expect(fake.calls.map((c) => c.url)).toContain(
      "https://coolify.example.test/api/v1/applications?tag=prod",
    );
    expect(changes(fake)).toEqual([]);
  });

  it("leaves services out with a pull request (they have no previews)", async () => {
    const { harness, id } = await start();
    const answer = await harness.request(
      "GET",
      preview(id, "tag=prod&pullRequestId=12"),
    );
    expect(answer.status).toBe(200);
    expect(uuids(answer.body.targets)).toEqual(["app-web-uuid"]);
    expect(answer.body.skippedServices).toBe(1);
  });

  it("deploys exactly the listed targets by uuid, with force, PR and docker tag", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request(
      "POST",
      `/connections/${id}/deploy-by-tag`,
      {
        tag: "prod",
        force: true,
        pullRequestId: 12,
        dockerTag: "pr-12",
        targets: ["app-web-uuid"],
      },
    );
    expect(answer.status).toBe(200);
    const sent = changes(fake);
    expect(sent.map((c) => c.path)).toEqual(["/deploy"]);
    const query = new URL(sent[0]!.url).searchParams;
    expect(query.get("uuid")).toBe("app-web-uuid");
    expect(query.get("force")).toBe("true");
    expect(query.get("pr")).toBe("12");
    expect(query.get("docker_tag")).toBe("pr-12");
    expect(query.get("tag")).toBeNull();
    expect(answer.body.deployments[0]).toMatchObject({
      resourceUuid: "app-web-uuid",
      deploymentUuid: "dep-tag-web",
    });
  });

  it("refuses when the tag's targets changed since they were confirmed", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request(
      "POST",
      `/connections/${id}/deploy-by-tag`,
      { tag: "prod", targets: ["app-web-uuid"] },
    );
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("targets-changed");
    expect(changes(fake)).toEqual([]);
  });

  it("refuses bad input before Coolify is asked", async () => {
    const { harness, fake, id } = await start();
    const before = fake.calls.length;
    for (const body of [
      { tag: "" },
      { tag: "a,b" },
      { tag: "prod", pullRequestId: 0 },
      { tag: "prod", pullRequestId: "x" },
      { tag: "prod", dockerTag: "v1" },
      { tag: "prod", pullRequestId: 3, dockerTag: "bad tag!" },
    ]) {
      const answer = await harness.request(
        "POST",
        `/connections/${id}/deploy-by-tag`,
        body,
      );
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.calls.slice(before)).toEqual([]);
  });

  it("is refused without coolify.operate, whatever calls it", async () => {
    const { harness, fake, id } = await start(["coolify.view"]);
    const route = await harness.request("GET", preview(id));
    expect(route.status).toBe(403);
    const post = await harness.request(
      "POST",
      `/connections/${id}/deploy-by-tag`,
      { tag: "prod" },
    );
    expect(post.status).toBe(403);
    await expect(
      handler(harness, "coolify.deploy-by-tag").run(
        { connectionId: String(id), tag: "prod" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(changes(fake)).toEqual([]);
  });

  it("is refused for a view grant", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "view");
    const answer = await harness.request(
      "POST",
      `/connections/${id}/deploy-by-tag`,
      { tag: "prod" },
      OTHER,
    );
    expect(answer.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the connection's target changes while it looks up the tag", async () => {
    const { harness, fake, id } = await start();
    fake.set(
      "GET /services/svc-n8n-uuid/tags",
      after(() => {
        harness.db.sqlite
          .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
          .run("https://other.example.test", id);
      }, [{ name: "prod" }]),
    );
    const answer = await harness.request(
      "POST",
      `/connections/${id}/deploy-by-tag`,
      { tag: "prod" },
    );
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("target-changed");
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the actor's grant drops below operate while it looks up the tag", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "operate");
    fake.set(
      "GET /services/svc-n8n-uuid/tags",
      after(() => {
        harness.db.sqlite
          .prepare(
            "UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?",
          )
          .run(OTHER);
      }, [{ name: "prod" }]),
    );
    const answer = await harness.request(
      "POST",
      `/connections/${id}/deploy-by-tag`,
      { tag: "prod" },
      OTHER,
    );
    expect(answer.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("stops before Coolify is asked once its run is cancelled", async () => {
    const { harness, fake, id } = await start(undefined, false);
    const controller = new AbortController();
    fake.set(
      "GET /services/svc-n8n-uuid/tags",
      after(() => controller.abort(), [{ name: "prod" }]),
    );
    await expect(
      handler(harness, "coolify.deploy-by-tag").run(
        { connectionId: String(id), tag: "prod" },
        context({ signal: controller.signal }),
      ),
    ).rejects.toBeTruthy();
    expect(changes(fake)).toEqual([]);
  });

  it("describes the targets for a dry run and the confirm", async () => {
    const { harness, fake, id } = await start(undefined, false);
    const op = harness.mock.operationHandlers.get("coolify.deploy-by-tag")!;
    const text = await op.describe!(
      { connectionId: String(id), tag: "prod" },
      context({ dryRun: true }),
    );
    expect(text).toContain("web");
    expect(text).toContain("n8n");
    expect(changes(fake)).toEqual([]);
  });

  it("is declared as an operate change with a described dry run", () => {
    expect(action("coolify.deploy-by-tag")).toMatchObject({
      scope: "server",
      risk: "change",
      permission: "operate",
      dryRun: "describe",
    });
  });

  it("needs confirmed: true over MCP", async () => {
    const { harness, fake, id } = await start(undefined, false, {
      allowMcpChanges: true,
    });
    harness.mock.setActor(OWNER);
    const call = (confirmed?: boolean) =>
      handleMcp(harness!.mock.ctx, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "coolify__deploy_by_tag",
          arguments: {
            connectionId: String(id),
            tag: "prod",
            ...(confirmed === undefined ? {} : { confirmed }),
          },
        },
      });
    const refused = (await call())?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("confirm-required");
    expect(changes(fake)).toEqual([]);
  });
});
