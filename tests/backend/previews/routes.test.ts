import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { coreLikeRun, queueAnswers } from "../helpers/deployments.js";
import {
  changes,
  grant,
  LIFECYCLE_TOKEN,
  startLifecycle,
} from "../helpers/lifecycle.js";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";
import {
  dropGrant,
  duringResourceRead,
  KEY_TAIL_LOGS,
  moveTarget,
  PREVIEW_CHANGES,
  previewAnswers,
} from "../helpers/previews.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** A fresh plugin; the one before it is closed first. */
async function start(
  permissions?: string[],
  overrides: Record<string, unknown> = {},
) {
  await harness?.close();
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

/** The body a change sent to Coolify, parsed. */
function sentBody(fake: Awaited<ReturnType<typeof start>>["fake"]) {
  return JSON.parse(String(changes(fake)[0].init?.body));
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
      portOverrides: { "https://pr-42.example.test": 3000 },
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
      const base = `/connections/${id}/resources/${uuid}/previews`;
      for (const [method, path, body] of [
        ["GET", base, undefined],
        ["POST", base, { pullRequestId: 5 }],
        ["DELETE", `${base}/5`, undefined],
        ["GET", `${base}/5/logs`, undefined],
      ] as const) {
        const answer = await harness.request(method, path, body);
        expect(answer.status, `${method} ${path}`).toBe(404);
      }
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

describe("each preview change", () => {
  it("sends what Coolify needs", async () => {
    let { harness: h, fake, id } = await start();
    const made = await h.request("POST", `${web(id)}/previews`, {
      pullRequestId: 51,
      pullRequestUrl: "https://github.com:443/acme/web/pull/51",
      gitType: "github",
    });
    expect(made.status).toBe(200);
    expect(made.body).toEqual({
      pullRequestId: 51,
      deploymentUuid: "dep-pr51",
    });
    expect(sentBody(fake)).toEqual({
      pull_request_id: 51,
      pull_request_html_url: "https://github.com:443/acme/web/pull/51",
      git_type: "github",
      instant_deploy: true,
      force: false,
    });

    ({ harness: h, fake, id } = await start());
    const domains = await h.request("PATCH", `${web(id)}/previews/42`, {
      domains:
        " https://PR-42.Example.test:3000 , http://pr42.example.test/api ",
    });
    expect(domains.status).toBe(200);
    expect(sentBody(fake)).toEqual({
      domains: "https://pr-42.example.test:3000,http://pr42.example.test/api",
    });

    ({ harness: h, fake, id } = await start());
    const run = vi.spyOn(h.mock.ctx.operations, "run");
    const gone = await h.request("DELETE", `${web(id)}/previews/42`);
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ pullRequestId: 42 });
    // Destructive: the route runs it confirmed, after the UI asked.
    expect(run).toHaveBeenCalledWith(
      "coolify.preview-delete",
      expect.objectContaining({ confirmed: true }),
    );
    expect(changes(fake).map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /applications/app-web-uuid/previews/42",
    ]);
  });

  it("is refused without coolify.operate, or for a view grant, before Coolify is asked", async () => {
    for (const change of PREVIEW_CHANGES) {
      const viewOnly = await start(["coolify.view"]);
      const refused = await viewOnly.harness.request(
        change.method,
        change.path(viewOnly.id),
        change.body,
      );
      expect(refused.status, change.actionId).toBe(403);
      expect(changes(viewOnly.fake), change.actionId).toEqual([]);

      const { harness: h, fake, id } = await start();
      grant(h, id, OTHER, "view");
      const viewer = await h.request(
        change.method,
        change.path(id),
        change.body,
        OTHER,
      );
      expect(viewer.status, change.actionId).toBe(403);
      expect(changes(fake), change.actionId).toEqual([]);
    }
  });

  it("stops when the target changes or the grant drops mid-call", async () => {
    for (const which of ["target", "grant"] as const) {
      for (const change of PREVIEW_CHANGES) {
        const { harness: h, fake, id } = await start();
        grant(h, id, OTHER, "operate");
        duringResourceRead(fake, () =>
          which === "target" ? moveTarget(h, id) : dropGrant(h, OTHER),
        );
        const answer = await h.request(
          change.method,
          change.path(id),
          change.body,
          OTHER,
        );
        const label = `${which} ${change.actionId}`;
        expect(answer.status, label).toBe(which === "target" ? 409 : 403);
        expect(previewCalls(fake), label).toEqual([]);
      }
    }
  });

  it("refuses another user's connection, a view grant and a bad body before any action or Coolify call", async () => {
    const { harness: h, fake, id } = await start();
    // Through core, a refusal thrown inside an action comes back as a plain
    // error: the routes refuse before they run one.
    coreLikeRun(h);
    const run = h.mock.ctx.operations.run;
    const before = fake.calls.length;
    for (const change of PREVIEW_CHANGES) {
      const stranger = await h.request(
        change.method,
        change.path(id),
        change.body,
        OTHER,
      );
      expect(stranger.status, change.actionId).toBe(404);
    }
    grant(h, id, OTHER, "view");
    for (const change of PREVIEW_CHANGES) {
      const viewer = await h.request(
        change.method,
        change.path(id),
        change.body,
        OTHER,
      );
      expect(viewer.status, change.actionId).toBe(403);
    }
    expect(run).not.toHaveBeenCalled();
    expect(previewCalls({ calls: fake.calls.slice(before) })).toEqual([]);
  });
});

describe("what a new preview needs", () => {
  /** web as a Docker image application. */
  function dockerImageApps() {
    const list = (resourceLists()["GET /applications"] as { json: unknown[] })
      .json as Record<string, unknown>[];
    return {
      "GET /applications": {
        json: list.map((a) =>
          a.uuid === "app-web-uuid" ? { ...a, build_pack: "dockerimage" } : a,
        ),
      },
    };
  }

  const create = (h: PluginHarness, id: number, body: object) =>
    h.request("POST", `${web(id)}/previews`, body);
  const created = (fake: Awaited<ReturnType<typeof start>>["fake"]) =>
    changes(fake).filter((c) => c.method === "POST");

  it("a new Bitbucket preview needs its commit; a redeploy doesn't", async () => {
    const { harness: h, fake, id } = await start();
    const missing = await create(h, id, {
      pullRequestId: 51,
      gitType: "bitbucket",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.cause).toBe("invalid-input");
    expect(created(fake)).toEqual([]);
    // 42 is already a preview of web: a redeploy needs no commit.
    const redeploy = await create(h, id, {
      pullRequestId: 42,
      gitType: "bitbucket",
    });
    expect(redeploy.status).toBe(200);
    expect(created(fake)).toHaveLength(1);
  });

  it("a new preview of a Docker image application needs its tag; a redeploy doesn't", async () => {
    const { harness: h, fake, id } = await start(undefined, dockerImageApps());
    const missing = await create(h, id, { pullRequestId: 51 });
    expect(missing.status).toBe(400);
    expect(missing.body.cause).toBe("invalid-input");
    expect(created(fake)).toEqual([]);
    const tagged = await create(h, id, {
      pullRequestId: 51,
      dockerTag: "pr-51",
    });
    expect(tagged.status).toBe(200);
    const redeploy = await create(h, id, { pullRequestId: 42 });
    expect(redeploy.status).toBe(200);
    expect(created(fake)).toHaveLength(2);
  });

  it("the action refuses a new Bitbucket preview without a commit too", async () => {
    const { harness: h, fake, id } = await start();
    await expect(
      h.mock.ctx.operations.run("coolify.preview-create", {
        input: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          pullRequestId: 51,
          gitType: "bitbucket",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(created(fake)).toEqual([]);
  });
});

describe("checking inputs before Coolify", () => {
  it("refuses a bad pull request id, URL, git type or tag", async () => {
    const { harness, fake, id } = await start();
    for (const body of [
      {},
      { pullRequestId: 0 },
      { pullRequestId: 2_147_483_648 },
      { pullRequestId: "4x" },
      { pullRequestId: 5, pullRequestUrl: "javascript:alert(1)" },
      { pullRequestId: 5, gitType: "svn" },
      { pullRequestId: 5, dockerTag: "bad tag" },
      { pullRequestId: 5, commit: "a".repeat(41) },
      { pullRequestId: 5, commit: "abc12" },
    ]) {
      const answer = await harness.request("POST", `${web(id)}/previews`, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    const bad = await harness.request("DELETE", `${web(id)}/previews/0`);
    expect(bad.status).toBe(404);
    expect(changes(fake)).toEqual([]);
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

  it("masks logs that start inside a private key", async () => {
    const { harness, id } = await start(undefined, KEY_TAIL_LOGS);
    const answer = await harness.request(
      "GET",
      `${web(id)}/previews/42/logs?lines=3`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.text).not.toContain("fake-preview-key-body");
    expect(answer.body.text).toContain("preview ready");
  });

  it("needs coolify.operate and an operate grant", async () => {
    const viewOnly = await start(["coolify.view"]);
    const refused = await viewOnly.harness.request(
      "GET",
      `${web(viewOnly.id)}/previews/42/logs`,
    );
    expect(refused.status).toBe(403);

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

describe("the deployment queue after a preview change", () => {
  it("reads the queue again once a preview was deployed or deleted", async () => {
    const { harness, fake, id } = await start(undefined, {
      ...queueAnswers(),
      ...previewAnswers(),
    });
    const queueReads = () =>
      fake.calls.filter((c) => c.method === "GET" && c.path === "/deployments")
        .length;
    const queue = () =>
      harness.request("GET", `/connections/${id}/deployments`);
    await queue();
    await queue();
    expect(queueReads()).toBe(1);
    const made = await harness.request("POST", `${web(id)}/previews`, {
      pullRequestId: 51,
    });
    expect(made.status).toBe(200);
    await queue();
    expect(queueReads()).toBe(2);
    const gone = await harness.request("DELETE", `${web(id)}/previews/42`);
    expect(gone.status).toBe(200);
    await queue();
    expect(queueReads()).toBe(3);
  });
});
