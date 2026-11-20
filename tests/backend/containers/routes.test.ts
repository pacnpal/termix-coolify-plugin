import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import { SECRET } from "../helpers/resources.js";
import { fakeDocker, FINGERPRINT, HOST_ID, startShell } from "./fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: Parameters<typeof startShell>[0] = {}) {
  const started = await startShell(options);
  harness = started.harness;
  return started;
}

const shellPath = (id: number, uuid: string) =>
  `/connections/${id}/resources/${uuid}/shell`;

const WEB_RUNNING: [RegExp, string] = [
  /applicationUuid=app-web-uuid/,
  "web-abc|running||\n",
];

describe("container shell route", () => {
  it("answers the docker exec command for a running container", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hostId: HOST_ID,
      title: "web",
      container: "web-abc",
      command: "docker exec -it web-abc bash",
      fingerprints: [FINGERPRINT],
    });
    expect(docker.exec.mock.calls.every(([host]) => host === HOST_ID)).toBe(
      true,
    );
  });

  it("uses sh without bash, and sudo for a user outside the docker group", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, {
      uid: 1000,
      groups: "deploy users",
      bash: false,
      ps: [WEB_RUNNING],
    });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body.command).toBe("sudo docker exec -it web-abc sh");
    const probes = docker.commands.filter((c) => c !== "id -u; id -Gn");
    for (const c of probes) expect(c).toMatch(/^sudo -n docker /);
  });

  it("needs no sudo for a member of the docker group", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, { uid: 1000, groups: "deploy docker", ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.body.command).toBe("docker exec -it web-abc bash");
  });

  it("several containers return choices", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, {
      ps: [
        [
          /serviceUuid=svc-n8n-uuid/,
          "n8n-a|running|part-n8n-uuid|n8n\npg-a|exited|part-postgres-uuid|postgresql\n",
        ],
      ],
    });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "svc-n8n-uuid"),
      {},
    );
    expect(res.status).toBe(300);
    expect(res.body).toEqual({
      choices: [
        { name: "n8n-a", running: true, part: "part-n8n-uuid" },
        { name: "pg-a", running: false, part: "part-postgres-uuid" },
      ],
    });
  });

  it("choosing a container from choices opens that one", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, {
      ps: [
        [
          /serviceUuid=svc-n8n-uuid/,
          "n8n-a|running|part-n8n-uuid|n8n\nworker-a|running|part-worker-uuid|n8n-worker\n",
        ],
      ],
    });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "svc-n8n-uuid"),
      {
        container: "worker-a",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.command).toBe("docker exec -it worker-a bash");
    expect(res.body.container).toBe("worker-a");
  });

  it("a container outside the resource's candidates is refused", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    for (const container of ["cache-other-resource", "made-up-name"]) {
      const res = await h.request(
        "POST",
        shellPath(connectionId, "app-web-uuid"),
        { container },
      );
      expect(res.status).toBe(404);
      expect(res.body.cause).toBe("container-not-found");
    }
    expect(docker.commands.some((c) => c.includes("docker exec"))).toBe(false);
  });

  it("a container name with ; or $( is refused", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    for (const container of ["web-abc;id", "web$(id)", "-it"]) {
      const res = await h.request(
        "POST",
        shellPath(connectionId, "app-web-uuid"),
        { container },
      );
      expect(res.status).toBe(400);
      expect(res.body.cause).toBe("invalid-input");
    }
    expect(docker.commands).toEqual([]);
  });

  it("no container answers container-not-found", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, { ps: [] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(404);
    expect(res.body.cause).toBe("container-not-found");
  });

  it("stopped container returns not-running", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, {
      ps: [[/applicationUuid=app-web-uuid/, "web-abc|exited||\n"]],
    });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("not-running");
  });

  it("server without linked host returns 409 not-linked", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    // app-api-uuid runs on srv-edge-uuid, which has no Linked host.
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-api-uuid"),
      {},
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("not-linked");
    expect(docker.commands).toEqual([]);
  });

  it("a connection with no Linked hosts at all answers not-linked", async () => {
    const { harness: h, connectionId } = await start({ linked: false });
    fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("not-linked");
  });

  it("HOST_KEY_UNVERIFIED maps to host-key with fingerprints", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, { hostKey: true });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Open a server terminal once to trust this host's key.",
      cause: "host-key",
      hostId: HOST_ID,
      fingerprints: [FINGERPRINT],
    });
  });

  it("refuses a host the actor can't open, before any SSH", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const access = vi
      .spyOn(h.mock.ctx.hosts, "checkAccess")
      .mockResolvedValue({ hasAccess: false, isOwner: false, isShared: false });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(403);
    expect(res.body.cause).toBe("no-host-access");
    expect(access).toHaveBeenCalledWith(HOST_ID, "connect");
    expect(docker.commands).toEqual([]);
  });

  it("opens a database console that holds no password", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, {
      ps: [[/databaseUuid=db-main-uuid/, "db-main-uuid|running||\n"]],
    });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "db-main-uuid"),
      {
        console: "db",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.command).toBe(
      `docker exec -it db-main-uuid sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" "$POSTGRES_DB"'`,
    );
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("a database console for a Part uses its image's engine", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, {
      ps: [
        [
          /subUuid=part-redis-uuid/,
          "redis-n8n|running|part-redis-uuid|redis\n",
        ],
      ],
    });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "svc-n8n-uuid"),
      { part: "part-redis-uuid", console: "db" },
    );
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("redis");
    expect(res.body.command).toContain("redis-cli");
    expect(res.body.command).not.toContain(SECRET);
  });

  it("a console for something with no known engine falls back to a shell", async () => {
    const { harness: h, connectionId } = await start();
    fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {
        console: "db",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.command).toBe("docker exec -it web-abc bash");
    expect(res.body.note).toBe("no-console");
  });

  it("refuses bad bodies and a part of another resource", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const bad = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      { console: "root" },
    );
    expect(bad.status).toBe(400);
    const foreign = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      { part: "part-redis-uuid" },
    );
    expect(foreign.status).toBe(404);
    expect(docker.commands).toEqual([]);
  });

  it("another user's connection is a 404 and runs nothing", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
      OTHER,
    );
    expect(res.status).toBe(404);
    expect(docker.commands).toEqual([]);
  });

  it("a view grant on the connection is refused before any SSH", async () => {
    const { harness: h, connectionId } = await start();
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, 'view')",
      )
      .run(connectionId, OTHER);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
      OTHER,
    );
    expect(res.status).toBe(403);
    expect(res.body.cause).toBe("forbidden");
    expect(docker.commands).toEqual([]);
  });

  it("a target change while the shell is resolved answers target-changed, not a command", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const real = docker.exec.getMockImplementation()!;
    docker.exec.mockImplementation(async (...args) => {
      // The owner points the connection at another token mid-way.
      h.db.sqlite
        .prepare("UPDATE p_coolify_connections SET token_sealed = ?")
        .run("sealed:another-instance");
      return real(...args);
    });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(res.body.command).toBeUndefined();
  });

  it("a target change before any SSH runs nothing", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const checkAccess = h.mock.ctx.hosts.checkAccess.bind(h.mock.ctx.hosts);
    vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockImplementation(
      async (...args) => {
        h.db.sqlite
          .prepare("UPDATE p_coolify_connections SET token_sealed = ?")
          .run("sealed:another-instance");
        return checkAccess(...args);
      },
    );
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(docker.commands).toEqual([]);
  });

  it("without coolify.operate 403", async () => {
    const { harness: h, connectionId } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      shellPath(connectionId, "app-web-uuid"),
      {},
    );
    expect(res.status).toBe(403);
    expect(docker.commands).toEqual([]);
  });
});
