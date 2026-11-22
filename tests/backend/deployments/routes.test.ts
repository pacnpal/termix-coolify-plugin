import { afterEach, describe, expect, it } from "vitest";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { deploymentAnswers } from "../helpers/deployments.js";
import {
  changes,
  grant,
  LIFECYCLE_TOKEN,
  startLifecycle,
} from "../helpers/lifecycle.js";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(permissions?: string[]) {
  const started = await startLifecycle({
    permissions,
    overrides: deploymentAnswers(),
  });
  harness = started.harness;
  return started;
}

const web = (id: number) => `/connections/${id}/resources/app-web-uuid`;

describe("deployment history route", () => {
  it("pages through Coolify's per-application list", async () => {
    const { harness, fake, id } = await start(["coolify.view"]);
    const page = await harness.request(
      "GET",
      `${web(id)}/deployments?skip=10&take=5`,
    );
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ count: 23, skip: 10, take: 5 });
    expect(page.body.rows.map((r: { uuid: string }) => r.uuid)).toEqual([
      "dep-run",
      "dep-done",
      "dep-failed",
    ]);
    expect(page.body.rows[0]).toMatchObject({
      status: "in_progress",
      resourceUuid: "app-web-uuid",
      commit: "abc1234",
      commitMessage: "Fix the header",
      pullRequestId: 0,
    });
    // The list never carries the build logs Coolify sends with it.
    expect(JSON.stringify(page.body)).not.toContain("Starting deployment");
    expect(fake.calls.map((c) => c.url)).toContain(
      "https://coolify.example.test/api/v1/deployments/applications/app-web-uuid?skip=10&take=5",
    );

    const first = await harness.request("GET", `${web(id)}/deployments`);
    expect(first.body).toMatchObject({ skip: 0, take: 10 });
  });

  it("refuses bad paging, an unknown uuid and a resource with no deployments", async () => {
    const { harness, fake, id } = await start();
    for (const query of ["skip=-1", "take=0", "take=51", "skip=x"]) {
      const bad = await harness.request(
        "GET",
        `${web(id)}/deployments?${query}`,
      );
      expect(bad.status, query).toBe(400);
    }
    const before = fake.calls.length;
    const unknown = await harness.request(
      "GET",
      `/connections/${id}/resources/app-nope-uuid/deployments`,
    );
    expect(unknown.status).toBe(404);
    const service = await harness.request(
      "GET",
      `/connections/${id}/resources/svc-n8n-uuid/deployments`,
    );
    expect(service.status).toBe(404);
    expect(
      fake.calls.slice(before).filter((c) => c.path.startsWith("/deployments")),
    ).toEqual([]);
  });
});

describe("one deployment with its build log", () => {
  it("answers the parsed, redacted log with hidden lines marked", async () => {
    const { harness, id } = await start();
    const answer = await harness.request(
      "GET",
      `${web(id)}/deployments/dep-run`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.deployment).toMatchObject({
      uuid: "dep-run",
      status: "in_progress",
      resourceUuid: "app-web-uuid",
    });
    expect(answer.body).toMatchObject({ final: false, cancellable: true });
    expect(answer.body.log.truncated).toBe(false);
    expect(
      answer.body.log.lines.map((l: { output: string; hidden: boolean }) => [
        l.output,
        l.hidden,
      ]),
    ).toEqual([
      ["Starting deployment", false],
      ["docker build --secret id=env", true],
      [`DB_PASSWORD=${REDACTED_VALUE}`, false],
      ["Building image", false],
    ]);
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain("fake-build-pass");
    expect(text).not.toContain(LIFECYCLE_TOKEN);
  });

  it("masks the connection's own token wherever it is in the log", async () => {
    const { harness, fake, id } = await start();
    fake.set("GET /deployments/dep-done", {
      json: {
        deployment_uuid: "dep-done",
        status: "finished",
        deployment_url:
          "/project/p/environment/e/application/app-web-uuid/deployment/dep-done",
        logs: JSON.stringify([
          { output: `pulled with ${LIFECYCLE_TOKEN}`, order: 1 },
        ]),
      },
    });
    const answer = await harness.request(
      "GET",
      `${web(id)}/deployments/dep-done`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.final).toBe(true);
    expect(JSON.stringify(answer.body)).not.toContain(LIFECYCLE_TOKEN);
  });

  it("answers log null when the token can't read build logs", async () => {
    const { harness, fake, id } = await start();
    fake.set("GET /deployments/dep-done", {
      json: {
        deployment_uuid: "dep-done",
        status: "finished",
        deployment_url:
          "/project/p/environment/e/application/app-web-uuid/deployment/dep-done",
      },
    });
    const answer = await harness.request(
      "GET",
      `${web(id)}/deployments/dep-done`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.log).toBeNull();
  });

  it("404s a deployment of another application, or one that names none", async () => {
    const { harness, fake, id } = await start();
    const elsewhere = await harness.request(
      "GET",
      `${web(id)}/deployments/dep-elsewhere`,
    );
    expect(elsewhere.status).toBe(404);
    expect(JSON.stringify(elsewhere.body)).not.toContain("Starting");
    const api = await harness.request(
      "GET",
      `/connections/${id}/resources/app-api-uuid/deployments/dep-run`,
    );
    expect(api.status).toBe(404);
    fake.set("GET /deployments/dep-done", {
      json: { deployment_uuid: "dep-done", status: "finished", logs: "x" },
    });
    const unnamed = await harness.request(
      "GET",
      `${web(id)}/deployments/dep-done`,
    );
    expect(unnamed.status).toBe(404);
  });

  it("needs coolify.operate and an operate grant, since logs hold secrets", async () => {
    const viewOnly = await start(["coolify.view"]);
    const refused = await viewOnly.harness.request(
      "GET",
      `${web(viewOnly.id)}/deployments/dep-run`,
    );
    expect(refused.status).toBe(403);
    await viewOnly.harness.close();

    const { harness, id } = await start();
    grant(harness, id, OTHER, "view");
    const viewGrant = await harness.request(
      "GET",
      `${web(id)}/deployments/dep-run`,
      undefined,
      OTHER,
    );
    expect(viewGrant.status).toBe(403);
  });
});

describe("cancelling a deployment", () => {
  it("cancels a running deployment of the resource", async () => {
    const { harness, fake, id } = await start();
    const answer = await harness.request(
      "POST",
      `${web(id)}/deployments/dep-run/cancel`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      deploymentUuid: "dep-run",
      status: "cancelled-by-user",
    });
    expect(changes(fake).map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /deployments/dep-run/cancel",
    ]);
  });

  it("is refused without coolify.operate, before Coolify is asked", async () => {
    const { harness, fake, id } = await start(["coolify.view"]);
    const answer = await harness.request(
      "POST",
      `${web(id)}/deployments/dep-run/cancel`,
    );
    expect(answer.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it("is refused for a view grant, and for a deployment that already ended", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "view");
    const viewGrant = await harness.request(
      "POST",
      `${web(id)}/deployments/dep-run/cancel`,
      undefined,
      OTHER,
    );
    expect(viewGrant.status).toBe(403);
    const ended = await harness.request(
      "POST",
      `${web(id)}/deployments/dep-done/cancel`,
    );
    expect(ended.status).toBe(409);
    expect(ended.body.cause).toBe("deployment-ended");
    const elsewhere = await harness.request(
      "POST",
      `${web(id)}/deployments/dep-elsewhere/cancel`,
    );
    expect(elsewhere.status).toBe(404);
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the connection's target changes while it reads the deployment", async () => {
    const { harness, fake, id } = await start();
    const answer = deploymentAnswers()["GET /deployments/dep-run"];
    fake.set("GET /deployments/dep-run", () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
        .run("https://other.example.test", id);
      return new Response(JSON.stringify((answer as { json: unknown }).json), {
        headers: { "content-type": "application/json" },
      });
    });
    const refused = await harness.request(
      "POST",
      `${web(id)}/deployments/dep-run/cancel`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.cause).toBe("target-changed");
    expect(changes(fake)).toEqual([]);
  });

  it("stops when the actor's grant drops below operate while it reads the deployment", async () => {
    const { harness, fake, id } = await start();
    grant(harness, id, OTHER, "operate");
    const answer = deploymentAnswers()["GET /deployments/dep-run"];
    fake.set("GET /deployments/dep-run", () => {
      harness.db.sqlite
        .prepare("UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?")
        .run(OTHER);
      return new Response(JSON.stringify((answer as { json: unknown }).json), {
        headers: { "content-type": "application/json" },
      });
    });
    const refused = await harness.request(
      "POST",
      `${web(id)}/deployments/dep-run/cancel`,
      undefined,
      OTHER,
    );
    expect(refused.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });
});
