import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeDocker,
  HOST_ID,
  linkedHost,
  startShell,
} from "./containers/fixtures.js";
import {
  changes,
  link,
  LIFECYCLE_TOKEN,
  startLifecycle,
} from "./helpers/lifecycle.js";
import { type PluginHarness } from "./helpers/plugin.js";
import {
  queueAnswers,
  rollbackAnswers,
  tagAnswers,
} from "./helpers/deployments.js";
import type { FakeAnswer } from "./helpers/fake-coolify.js";
import { moveTarget, previewAnswers } from "./helpers/previews.js";
import { resourceLists } from "./helpers/resources.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const WEB_RUNNING: [RegExp, string] = [
  /applicationUuid=app-web-uuid/,
  "web-abc|running||\n",
];
const DB_RUNNING: [RegExp, string] = [
  /databaseUuid=db-main-uuid/,
  "db-main-uuid|running||\n",
];

const shellPath = (id: number, uuid: string) =>
  `/connections/${id}/resources/${uuid}/shell`;
const deployPath = (id: number, uuid: string) =>
  `/connections/${id}/resources/${uuid}/deploy`;

async function shell(options: Parameters<typeof startShell>[0] = {}) {
  const started = await startShell(options);
  harness = started.harness;
  return started;
}

/** A connection whose srv-vps1-uuid is linked to a host the owner reaches. */
async function deploys(
  options: Parameters<typeof startLifecycle>[0] & { linked?: boolean } = {},
) {
  const started = await startLifecycle({ hosts: [linkedHost], ...options });
  harness = started.harness;
  if (options.linked !== false) {
    link(started.harness, started.id, "srv-vps1-uuid", HOST_ID);
  }
  return started;
}

describe("recent activity: shells and consoles", () => {
  it("records one entry when a container shell opens over the route", async () => {
    const { harness: h, connectionId } = await shell();
    fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(200);
    expect(h.mock.activities).toEqual([
      {
        hostId: HOST_ID,
        type: "coolify_shell",
        hostName: "Opened shell in web",
      },
    ]);
  });

  it("records a database console opened through the operation", async () => {
    const { harness: h, connectionId } = await shell();
    fakeDocker(h, { ps: [DB_RUNNING] });
    const outcome = await h.mock.ctx.operations.run("coolify.shell-command", {
      input: {
        connectionId: String(connectionId),
        uuid: "db-main-uuid",
        console: "db",
      },
    });
    expect(outcome.status).toBe("success");
    expect(h.mock.activities).toEqual([
      {
        hostId: HOST_ID,
        type: "coolify_shell",
        hostName: "Opened shell in main-db",
      },
    ]);
  });

  it("records nothing when the shell is refused or answers choices", async () => {
    const { harness: h, connectionId } = await shell();
    fakeDocker(h, {
      ps: [[/applicationUuid=app-web-uuid/, "web-abc|exited||\n"]],
    });
    const stopped = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(stopped.status).toBe(409);
    vi.restoreAllMocks();
    fakeDocker(h, {
      ps: [
        [/applicationUuid=app-web-uuid/, "web-a|running||\nweb-b|running||\n"],
      ],
    });
    const choices = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(choices.status).toBe(300);
    expect(h.mock.activities).toEqual([]);
  });

  it("records nothing for a server with no Linked host", async () => {
    const { harness: h, connectionId } = await shell({ linked: false });
    fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(409);
    expect(h.mock.activities).toEqual([]);
  });

  it("a recordActivity failure never fails the shell, and is logged without secrets", async () => {
    const { harness: h, connectionId } = await shell();
    fakeDocker(h, { ps: [WEB_RUNNING] });
    vi.spyOn(h.mock.ctx.hosts, "recordActivity").mockRejectedValue(
      new Error("fake-token-shell-test leaked into an error"),
    );
    const warn = vi.spyOn(h.mock.ctx.log, "warn");
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body.command).toBe("docker exec -it web-abc bash");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/activity/);
    expect(line).not.toContain("fake-token");
  });
});

describe("recent activity: deploys", () => {
  it("records one entry for a deploy over the route", async () => {
    const { harness: h, id } = await deploys();
    const res = await h.request("POST", deployPath(id, "app-web-uuid"), {});
    expect(res.status).toBe(200);
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
    ]);
  });

  it("records one entry through either deploy operation", async () => {
    const { harness: h, id } = await deploys();
    await h.mock.ctx.operations.run("coolify.deploy", {
      hostId: HOST_ID,
      resourceKey: "app-web-uuid",
      input: {},
    });
    expect(h.mock.activities).toHaveLength(1);
    await h.mock.ctx.operations.run("coolify.resource-deploy", {
      input: { connectionId: String(id), uuid: "app-web-uuid" },
    });
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
    ]);
  });

  it("records once for a waited deploy that finishes", async () => {
    const { harness: h } = await deploys();
    await h.mock.ctx.operations.run("coolify.deploy", {
      hostId: HOST_ID,
      resourceKey: "app-web-uuid",
      input: { wait: true },
    });
    expect(h.mock.activities).toHaveLength(1);
  });

  it("records nothing when Coolify refuses the deploy", async () => {
    const { harness: h, id } = await deploys({
      overrides: { "POST /deploy": { status: 500, json: { message: "no" } } },
    });
    const res = await h.request("POST", deployPath(id, "app-web-uuid"), {});
    expect(res.status).toBe(502);
    expect(h.mock.activities).toEqual([]);
  });

  it("records once Coolify accepts a waited deploy, even if it then fails", async () => {
    const { harness: h } = await deploys({
      overrides: {
        "GET /deployments/dep-uuid": {
          json: { deployment_uuid: "dep-uuid", status: "failed" },
        },
      },
    });
    await expect(
      h.mock.ctx.operations.run("coolify.deploy", {
        hostId: HOST_ID,
        resourceKey: "app-web-uuid",
        input: { wait: true },
      }),
    ).rejects.toMatchObject({ code: "deployment-failed" });
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
    ]);
  });

  it("records nothing for a resource whose server has no Linked host", async () => {
    const { harness: h, fake, id } = await deploys({ linked: false });
    const res = await h.request("POST", deployPath(id, "app-web-uuid"), {});
    expect(res.status).toBe(200);
    expect(changes(fake).map((c) => c.path)).toEqual(["/deploy"]);
    expect(h.mock.activities).toEqual([]);
  });

  it("records nothing on a Linked host the actor can't reach", async () => {
    const { harness: h, id } = await deploys({ hosts: [] });
    const res = await h.request("POST", deployPath(id, "app-web-uuid"), {});
    expect(res.status).toBe(200);
    expect(h.mock.activities).toEqual([]);
  });

  it("records nothing for start, stop or restart", async () => {
    const { harness: h, id } = await deploys();
    for (const verb of ["start", "stop", "restart"]) {
      const res = await h.request(
        "POST",
        `/connections/${id}/resources/app-web-uuid/${verb}`,
      );
      expect(res.status, verb).toBe(200);
    }
    expect(h.mock.activities).toEqual([]);
  });

  it("a recordActivity failure never fails the deploy, and is logged without secrets", async () => {
    const { harness: h, id } = await deploys();
    vi.spyOn(h.mock.ctx.hosts, "recordActivity").mockRejectedValue(
      new Error(`${LIFECYCLE_TOKEN} leaked into an error`),
    );
    const warn = vi.spyOn(h.mock.ctx.log, "warn");
    const res = await h.request("POST", deployPath(id, "app-web-uuid"), {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deploymentUuid: "dep-uuid" });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/activity/);
    expect(line).not.toContain(LIFECYCLE_TOKEN);
  });

  it("records a service deploy, which Coolify starts without a deployment uuid", async () => {
    const { harness: h, id } = await deploys({
      overrides: {
        "POST /deploy": {
          json: {
            deployments: [
              {
                message: "Service n8n started.",
                resource_uuid: "svc-n8n-uuid",
              },
            ],
          },
        },
      },
    });
    const res = await h.request("POST", deployPath(id, "svc-n8n-uuid"), {});
    expect(res.status).toBe(200);
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed n8n" },
    ]);
  });
});

const applications = (resourceLists()["GET /applications"] as { json: unknown })
  .json;

/** n8n moved to srv-edge-uuid, a server with no Linked host. */
function n8nOnEdge(): Record<string, FakeAnswer> {
  const services = (resourceLists()["GET /services"] as { json: unknown[] })
    .json as Record<string, unknown>[];
  return {
    "GET /services": {
      json: services.map((s) => ({
        ...s,
        server: { id: 3, uuid: "srv-edge-uuid", name: "edge" },
      })),
    },
  };
}

async function byTag(
  extra: Record<string, FakeAnswer> = {},
  input: Record<string, unknown> = {},
) {
  const started = await deploys({
    overrides: { ...queueAnswers(), ...tagAnswers(applications), ...extra },
  });
  const run = () =>
    started.harness.mock.ctx.operations.run("coolify.deploy-by-tag", {
      input: { connectionId: String(started.id), tag: "prod", ...input },
    });
  return { ...started, run };
}

async function rollbacks(extra: Record<string, FakeAnswer> = {}) {
  const started = await deploys({
    overrides: { ...queueAnswers(), ...rollbackAnswers(), ...extra },
  });
  const run = () =>
    started.harness.mock.ctx.operations.run("coolify.resource-rollback", {
      input: {
        connectionId: String(started.id),
        uuid: "app-web-uuid",
        image: "0ld3r00",
      },
    });
  return { ...started, run };
}

describe("recent activity: every other deploy path", () => {
  it("deploy by tag records one entry per resource on a Linked host", async () => {
    const { harness: h, run } = await byTag();
    await run();
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed n8n" },
    ]);
  });

  it("deploy by tag records nothing for a resource whose server has no Linked host", async () => {
    const { harness: h, fake, run } = await byTag(n8nOnEdge());
    await run();
    expect(changes(fake).map((c) => c.path)).toEqual(["/deploy"]);
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
    ]);
  });

  it("deploy by tag records each of two same-name resources on one host", async () => {
    const services = (resourceLists()["GET /services"] as { json: unknown[] })
      .json as Record<string, unknown>[];
    const { harness: h, run } = await byTag({
      "GET /services": {
        json: services.map((s) => ({ ...s, name: "web" })),
      },
    });
    await run();
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
    ]);
  });

  it("deploy by tag sends the same deploy when the resource list can't be read again", async () => {
    const tagged = tagAnswers(applications);
    let broken = false;
    const lists = tagged["GET /applications"] as (url: string) => Response;
    const {
      harness: h,
      fake,
      id,
      run,
    } = await byTag({
      // Coolify's last answer while the targets are found: from then on the
      // cached resource list is gone and Coolify can't list applications.
      "GET /services/svc-n8n-uuid/tags": () => {
        broken = true;
        h.db.sqlite.prepare("DELETE FROM p_coolify_cache").run();
        return new Response(JSON.stringify([{ uuid: "t", name: "prod" }]), {
          headers: { "content-type": "application/json" },
        });
      },
      "GET /applications": (url: string) =>
        broken && new URL(url).searchParams.get("tag") === null
          ? new Response(JSON.stringify({ message: "no" }), { status: 500 })
          : lists(url),
    });
    const outcome = await run();
    expect(outcome.status).toBe("success");
    const sent = changes(fake);
    expect(sent.map((c) => c.path)).toEqual(["/deploy"]);
    expect(new URL(sent[0].url).searchParams.get("uuid")).toBe(
      "app-web-uuid,svc-n8n-uuid",
    );
    expect(id).toBeGreaterThan(0);
  });

  it("deploy by tag with a pull request names the pull request", async () => {
    const { harness: h, run } = await byTag({}, { pullRequestId: 7 });
    await run();
    expect(h.mock.activities).toEqual([
      {
        hostId: HOST_ID,
        type: "coolify_deploy",
        hostName: "Deployed web (pull request #7)",
      },
    ]);
  });

  it("a deploy by tag Coolify refuses records nothing", async () => {
    const { harness: h, run } = await byTag({
      "POST /deploy": { status: 500, json: { message: "no" } },
    });
    await expect(run()).rejects.toBeTruthy();
    expect(h.mock.activities).toEqual([]);
  });

  it("a rollback records Deployed <app>", async () => {
    const { harness: h, run } = await rollbacks();
    const outcome = await run();
    expect(outcome.status).toBe("success");
    expect(h.mock.activities).toEqual([
      { hostId: HOST_ID, type: "coolify_deploy", hostName: "Deployed web" },
    ]);
  });

  it("a rollback on the Linked host's own action records once", async () => {
    const { harness: h } = await rollbacks();
    await h.mock.ctx.operations.run("coolify.rollback", {
      hostId: HOST_ID,
      resourceKey: "app-web-uuid",
      input: { image: "0ld3r00" },
    });
    expect(h.mock.activities).toHaveLength(1);
  });

  it("a rollback Coolify refuses records nothing", async () => {
    const { harness: h, run } = await rollbacks({
      "POST /applications/app-web-uuid/rollback": {
        status: 500,
        json: { message: "no" },
      },
    });
    await expect(run()).rejects.toBeTruthy();
    expect(h.mock.activities).toEqual([]);
  });

  it("a recordActivity failure never fails a rollback or a deploy by tag", async () => {
    const { harness: h, id, run } = await rollbacks(tagAnswers(applications));
    vi.spyOn(h.mock.ctx.hosts, "recordActivity").mockRejectedValue(
      new Error(`${LIFECYCLE_TOKEN} leaked into an error`),
    );
    const warn = vi.spyOn(h.mock.ctx.log, "warn");
    expect((await run()).status).toBe("success");
    const tagged = await h.mock.ctx.operations.run("coolify.deploy-by-tag", {
      input: { connectionId: String(id), tag: "prod" },
    });
    expect(tagged.status).toBe("success");
    expect(warn).toHaveBeenCalledTimes(3);
    for (const [line] of warn.mock.calls) {
      expect(String(line)).toMatch(/activity/);
      expect(String(line)).not.toContain(LIFECYCLE_TOKEN);
    }
  });

  it("a preview deploy records Deployed <app> with its pull request", async () => {
    const { harness: h, id } = await deploys({ overrides: previewAnswers() });
    await h.mock.ctx.operations.run("coolify.preview-create", {
      input: {
        connectionId: String(id),
        uuid: "app-web-uuid",
        pullRequestId: 42,
      },
    });
    expect(h.mock.activities).toEqual([
      {
        hostId: HOST_ID,
        type: "coolify_deploy",
        hostName: "Deployed web (pull request #42)",
      },
    ]);
  });

  it("a preview deploy Coolify refuses records nothing", async () => {
    const { harness: h, id } = await deploys({
      overrides: {
        ...previewAnswers(),
        "POST /applications/app-web-uuid/previews": {
          status: 500,
          json: { message: "no" },
        },
      },
    });
    await expect(
      h.mock.ctx.operations.run("coolify.preview-create", {
        input: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          pullRequestId: 42,
        },
      }),
    ).rejects.toBeTruthy();
    expect(h.mock.activities).toEqual([]);
  });
});

/** recordActivity that repoints the connection while it is pending. */
function moveWhileRecording(h: PluginHarness, id: number) {
  vi.spyOn(h.mock.ctx.hosts, "recordActivity").mockImplementation(async () => {
    moveTarget(h, id);
  });
}

describe("recent activity: the target is checked after recording", () => {
  it("a shell whose connection moves while recording answers target-changed, no command", async () => {
    const { harness: h, connectionId } = await shell();
    fakeDocker(h, { ps: [WEB_RUNNING] });
    moveWhileRecording(h, connectionId);
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.body.cause).toBe("target-changed");
    expect(res.body.command).toBeUndefined();
  });

  it("a database console whose connection moves while recording is refused", async () => {
    const { harness: h, connectionId } = await shell();
    fakeDocker(h, { ps: [DB_RUNNING] });
    moveWhileRecording(h, connectionId);
    await expect(
      h.mock.ctx.operations.run("coolify.shell-command", {
        input: {
          connectionId: String(connectionId),
          uuid: "db-main-uuid",
          console: "db",
        },
      }),
    ).rejects.toMatchObject({ code: "target-changed" });
  });

  it("a deploy by tag whose connection moves while recording is refused", async () => {
    const { harness: h, id, run } = await byTag();
    moveWhileRecording(h, id);
    await expect(run()).rejects.toMatchObject({ code: "target-changed" });
  });

  it("a rollback whose connection moves while recording is refused", async () => {
    const { harness: h, id, run } = await rollbacks();
    moveWhileRecording(h, id);
    await expect(run()).rejects.toMatchObject({ code: "target-changed" });
  });

  it("a preview deploy whose connection moves while recording is refused", async () => {
    const { harness: h, id } = await deploys({ overrides: previewAnswers() });
    moveWhileRecording(h, id);
    await expect(
      h.mock.ctx.operations.run("coolify.preview-create", {
        input: {
          connectionId: String(id),
          uuid: "app-web-uuid",
          pullRequestId: 42,
        },
      }),
    ).rejects.toMatchObject({ code: "target-changed" });
  });
});
