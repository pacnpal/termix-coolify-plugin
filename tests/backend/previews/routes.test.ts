import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { resourceLists } from "../helpers/resources.js";
import {
  changes,
  grant,
  LIFECYCLE_TOKEN,
  startLifecycle,
} from "../helpers/lifecycle.js";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import { previewAnswers } from "../helpers/previews.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(
  permissions?: string[],
  overrides: Record<string, unknown> = {},
) {
  const started = await startLifecycle({
    permissions,
    overrides: { ...previewAnswers(), ...overrides } as never,
  });
  harness = started.harness;
  return started;
}

const web = (id: number) => `/connections/${id}/resources/app-web-uuid`;

/** Calls that touch a preview endpoint. */
function previewCalls(fake: { calls: { path: string }[] }) {
  return fake.calls.filter((c) => c.path.includes("/previews"));
}

/**
 * Answers Coolify's application list once with `before` run first, as a
 * change made while the plugin reads the resource.
 */
function duringResourceRead(
  fake: { set: (route: string, answer: never) => void },
  before: () => void,
) {
  const list = (resourceLists()["GET /applications"] as { json: unknown }).json;
  fake.set("GET /applications", (() => {
    before();
    return new Response(JSON.stringify(list), {
      headers: { "content-type": "application/json" },
    });
  }) as never);
}

describe("listing an application's previews", () => {
  it("lists the previews, each with its latest build", async () => {
    const { harness, id } = await start(["coolify.view"]);
    const answer = await harness.request("GET", `${web(id)}/previews`);
    expect(answer.status).toBe(200);
    expect(
      answer.body.rows.map((r: { pullRequestId: number }) => r.pullRequestId),
    ).toEqual([42, 7]);
    expect(answer.body.rows[0]).toMatchObject({
      pullRequestId: 42,
      pullRequestUrl: "https://github.com/acme/web/pull/42",
      status: "running:healthy",
      domains: ["https://pr-42.example.test"],
      deploymentUuid: "dep-pr42",
      deploymentStatus: "in_progress",
    });
    expect(answer.body.rows[1]).toMatchObject({
      pullRequestId: 7,
      deploymentUuid: null,
    });
    expect(JSON.stringify(answer.body)).not.toContain(LIFECYCLE_TOKEN);
  });

  it("refuses a service, a database and an unknown uuid before asking Coolify", async () => {
    const { harness, fake, id } = await start();
    for (const uuid of ["svc-n8n-uuid", "db-main-uuid", "app-nope-uuid"]) {
      const answer = await harness.request(
        "GET",
        `/connections/${id}/resources/${uuid}/previews`,
      );
      expect(answer.status, uuid).toBe(404);
      const made = await harness.request(
        "POST",
        `/connections/${id}/resources/${uuid}/previews`,
        { pullRequestId: 5 },
      );
      expect(made.status, uuid).toBe(404);
      const gone = await harness.request(
        "DELETE",
        `/connections/${id}/resources/${uuid}/previews/5`,
      );
      expect(gone.status, uuid).toBe(404);
      const logs = await harness.request(
        "GET",
        `/connections/${id}/resources/${uuid}/previews/5/logs`,
      );
      expect(logs.status, uuid).toBe(404);
    }
    expect(previewCalls(fake)).toEqual([]);
  });

  it("says the Coolify instance lacks previews when an older one answers 404", async () => {
    const { harness, fake, id } = await start(undefined, {
      "GET /version": { text: "v4.6.0" },
      "GET /applications/app-web-uuid/previews": {
        status: 404,
        json: { message: "Not found." },
      },
    });
    const answer = await harness.request("GET", `${web(id)}/previews`);
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("unsupported-by-instance");
    expect(previewCalls(fake).length).toBe(1);
  });
});

describe("creating a preview", () => {
  it("deploys a preview for a pull request and answers its deployment", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request("POST", `${web(id)}/previews`, {
      pullRequestId: 51,
      pullRequestUrl: "https://github.com/acme/web/pull/51",
      gitType: "github",
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      pullRequestId: 51,
      deploymentUuid: "dep-pr51",
    });
    const sent = changes(fake);
    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /applications/app-web-uuid/previews",
    ]);
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({
      pull_request_id: 51,
      pull_request_html_url: "https://github.com/acme/web/pull/51",
      git_type: "github",
      instant_deploy: true,
      force: false,
    });
  });

  it("refuses a bad pull request id, URL or git type before asking Coolify", async () => {
    const { harness, fake, id } = await start();
    for (const body of [
      {},
      { pullRequestId: 0 },
      { pullRequestId: 2_147_483_648 },
      { pullRequestId: "4x" },
      { pullRequestId: 5, pullRequestUrl: "javascript:alert(1)" },
      { pullRequestId: 5, gitType: "svn" },
      { pullRequestId: 5, dockerTag: "bad tag" },
    ]) {
      const answer = await harness.request("POST", `${web(id)}/previews`, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect(changes(fake)).toEqual([]);
  });

  it("is refused without coolify.operate, or with a view grant, before Coolify is asked", async () => {
    const viewOnly = await start(["coolify.view"]);
    const refused = await viewOnly.harness.request(
      "POST",
      `${web(viewOnly.id)}/previews`,
      { pullRequestId: 51 },
    );
    expect(refused.status).toBe(403);
    expect(changes(viewOnly.fake)).toEqual([]);
    await viewOnly.harness.close();

    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "view");
    const viewGrant = await harness.request(
      "POST",
      `${web(id)}/previews`,
      { pullRequestId: 51 },
      OTHER,
    );
    expect(viewGrant.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the connection's target changes mid-call", async () => {
    const { harness, fake, id } = await start();
    duringResourceRead(fake, () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
        .run("https://other.example.test", id);
    });
    const refused = await harness.request("POST", `${web(id)}/previews`, {
      pullRequestId: 51,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.cause).toBe("target-changed");
    expect(changes(fake).filter((c) => c.path.includes("previews"))).toEqual(
      [],
    );
  });

  it("stops when the actor's grant drops below operate mid-call", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "operate");
    duringResourceRead(fake, () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?")
        .run(OTHER);
    });
    const refused = await harness.request(
      "POST",
      `${web(id)}/previews`,
      { pullRequestId: 51 },
      OTHER,
    );
    expect(refused.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });
});

describe("deleting a preview", () => {
  it("runs coolify.preview-delete confirmed and deletes the preview", async () => {
    const { harness, fake, id } = await start();
    const run = vi.spyOn(harness.mock.ctx.operations, "run");
    const answer = await harness.request("DELETE", `${web(id)}/previews/42`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ pullRequestId: 42 });
    expect(run).toHaveBeenCalledWith(
      "coolify.preview-delete",
      expect.objectContaining({ confirmed: true }),
    );
    expect(changes(fake).map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /applications/app-web-uuid/previews/42",
    ]);
  });

  it("is refused without coolify.operate, for a view grant and for a bad id", async () => {
    const viewOnly = await start(["coolify.view"]);
    const refused = await viewOnly.harness.request(
      "DELETE",
      `${web(viewOnly.id)}/previews/42`,
    );
    expect(refused.status).toBe(403);
    expect(changes(viewOnly.fake)).toEqual([]);
    await viewOnly.harness.close();

    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "view");
    const viewGrant = await harness.request(
      "DELETE",
      `${web(id)}/previews/42`,
      undefined,
      OTHER,
    );
    expect(viewGrant.status).toBe(403);
    const bad = await harness.request("DELETE", `${web(id)}/previews/0`);
    expect(bad.status).toBe(404);
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the actor's grant drops below operate mid-call", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "operate");
    duringResourceRead(fake, () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?")
        .run(OTHER);
    });
    const dropped = await harness.request(
      "DELETE",
      `${web(id)}/previews/42`,
      undefined,
      OTHER,
    );
    expect(dropped.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the connection's target changes mid-call", async () => {
    const { harness, fake, id } = await start();
    duringResourceRead(fake, () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
        .run("https://other.example.test", id);
    });
    const moved = await harness.request("DELETE", `${web(id)}/previews/42`);
    expect(moved.status).toBe(409);
    expect(changes(fake).filter((c) => c.path.includes("previews"))).toEqual(
      [],
    );
  });
});

describe("changing a preview's domains", () => {
  it("sends checked domains to Coolify", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request("PATCH", `${web(id)}/previews/42`, {
      domains:
        " https://PR-42.Example.test:3000 , http://pr42.example.test/api ",
    });
    expect(answer.status).toBe(200);
    const sent = changes(fake);
    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /applications/app-web-uuid/previews/42",
    ]);
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({
      domains: "https://pr-42.example.test:3000,http://pr42.example.test/api",
    });
  });

  it("refuses invalid domains before any Coolify call", async () => {
    const { harness, fake, id } = await start();
    const before = fake.calls.length;
    for (const domains of [
      "",
      "pr.example.test",
      "ftp://pr.example.test",
      "https://user:pass@pr.example.test",
      "https://pr.example.test/?x=1",
      "https://pr.example.test#top",
      "https://-bad-.example.test",
      "https://localhost",
      "https://203.0.113.5",
      "https://pr.example.test,https://pr.example.test",
      "https://pr .example.test",
      Array.from({ length: 21 }, (_, i) => `https://p${i}.example.test`).join(
        ",",
      ),
    ]) {
      const answer = await harness.request("PATCH", `${web(id)}/previews/42`, {
        domains,
      });
      expect(answer.status, domains).toBe(400);
      expect(answer.body.cause, domains).toBe("invalid-input");
    }
    const compose = await harness.request("PATCH", `${web(id)}/previews/42`, {
      composeDomains: [{ name: "web", domain: "not a domain" }],
    });
    expect(compose.status).toBe(400);
    expect(fake.calls.length).toBe(before);
  });

  it("is refused without coolify.operate and when the grant drops mid-call", async () => {
    const viewOnly = await start(["coolify.view"]);
    const refused = await viewOnly.harness.request(
      "PATCH",
      `${web(viewOnly.id)}/previews/42`,
      { domains: "https://pr-42.example.test" },
    );
    expect(refused.status).toBe(403);
    expect(changes(viewOnly.fake)).toEqual([]);
    await viewOnly.harness.close();

    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "operate");
    duringResourceRead(fake, () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?")
        .run(OTHER);
    });
    const dropped = await harness.request(
      "PATCH",
      `${web(id)}/previews/42`,
      { domains: "https://pr-42.example.test" },
      OTHER,
    );
    expect(dropped.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the connection's target changes mid-call", async () => {
    const { harness, fake, id } = await start();
    duringResourceRead(fake, () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
        .run("https://other.example.test", id);
    });
    const moved = await harness.request("PATCH", `${web(id)}/previews/42`, {
      domains: "https://pr-42.example.test",
    });
    expect(moved.status).toBe(409);
    expect(moved.body.cause).toBe("target-changed");
    expect(changes(fake).filter((c) => c.path.includes("previews"))).toEqual(
      [],
    );
  });
});

describe("a preview's container logs", () => {
  it("answers the logs redacted, a private key split over lines included", async () => {
    const { harness, id } = await start();
    const answer = await harness.request(
      "GET",
      `${web(id)}/previews/42/logs?lines=200`,
    );
    expect(answer.status).toBe(200);
    const text = answer.body.text as string;
    expect(text).toContain("preview listening on 3000");
    expect(text).toContain("preview ready");
    expect(text).toContain(`DB_PASSWORD=${REDACTED_VALUE}`);
    expect(text).not.toContain("fake-preview-pass");
    expect(text).not.toContain("fake-preview-key-body");
    expect(text).not.toContain(LIFECYCLE_TOKEN);
  });

  it("needs coolify.operate and an operate grant", async () => {
    const viewOnly = await start(["coolify.view"]);
    const refused = await viewOnly.harness.request(
      "GET",
      `${web(viewOnly.id)}/previews/42/logs`,
    );
    expect(refused.status).toBe(403);
    await viewOnly.harness.close();

    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "view");
    const viewGrant = await harness.request(
      "GET",
      `${web(id)}/previews/42/logs`,
      undefined,
      OTHER,
    );
    expect(viewGrant.status).toBe(403);
    expect(previewCalls(fake)).toEqual([]);
  });
});

describe("refusals before the action runs", () => {
  it("refuses another user's connection, a view grant and a bad body before any action or Coolify call", async () => {
    const { harness, fake, id } = await start();
    // Through core, a refusal thrown inside an action can come back as a
    // plain failed outcome: the routes must refuse before they run one.
    const run = vi
      .spyOn(harness.mock.ctx.operations, "run")
      .mockResolvedValue({ runId: "r1", status: "failed", error: "boom" });
    const before = fake.calls.length;
    const calls = [
      ["POST", `${web(id)}/previews`, { pullRequestId: 51 }],
      [
        "PATCH",
        `${web(id)}/previews/42`,
        { domains: "https://a.example.test" },
      ],
      ["DELETE", `${web(id)}/previews/42`, undefined],
    ] as const;
    for (const [method, path, body] of calls) {
      const stranger = await harness.request(method, path, body, OTHER);
      expect(stranger.status, `${method} stranger`).toBe(404);
    }
    grant(harness, id, OTHER, "view");
    for (const [method, path, body] of calls) {
      const viewer = await harness.request(method, path, body, OTHER);
      expect(viewer.status, `${method} viewer`).toBe(403);
    }
    const badCreate = await harness.request("POST", `${web(id)}/previews`, {
      pullRequestId: 0,
    });
    expect(badCreate.status).toBe(400);
    const badDomains = await harness.request(
      "PATCH",
      `${web(id)}/previews/42`,
      { domains: "nope" },
    );
    expect(badDomains.status).toBe(400);
    const service = await harness.request(
      "DELETE",
      `/connections/${id}/resources/svc-n8n-uuid/previews/42`,
    );
    expect(service.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(previewCalls({ calls: fake.calls.slice(before) })).toEqual([]);
  });
});
