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

  it("records nothing for a waited deploy that ends failed", async () => {
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
    expect(h.mock.activities).toEqual([]);
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
});
