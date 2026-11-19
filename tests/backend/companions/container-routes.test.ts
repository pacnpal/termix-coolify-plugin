import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import { SECRET } from "../helpers/resources.js";
import {
  FILES,
  fakeDockerHost,
  HOST_ID,
  REVERSE_PROXY,
  startCompanions,
  TOKEN,
  TUNNELS,
  WEB_RUNNING,
} from "./container-fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: Parameters<typeof startCompanions>[0] = {}) {
  const started = await startCompanions(options);
  harness = started.harness;
  return started;
}

const base = (id: number, uuid: string) =>
  `/connections/${id}/resources/${uuid}`;

describe("container companion routes", () => {
  it("data paths are /data/coolify/<kind>/<uuid> plus storage mounts", async () => {
    const { harness: h, connectionId } = await start();
    const app = await h.request(
      "GET",
      `${base(connectionId, "app-web-uuid")}/paths`,
    );
    expect(app.status).toBe(200);
    expect(app.body).toEqual({
      hostId: HOST_ID,
      dataDir: "/data/coolify/applications/app-web-uuid",
      composeFile:
        "/data/coolify/applications/app-web-uuid/docker-compose.yaml",
      volumes: [
        "/var/lib/docker/volumes/app-web-uuid-data/_data",
        "/srv/uploads",
        "/data/coolify/applications/app-web-uuid/config.yml",
      ],
    });
    // A file storage's content never leaves Coolify's answer.
    expect(JSON.stringify(app.body)).not.toContain(SECRET);

    const db = await h.request(
      "GET",
      `${base(connectionId, "db-main-uuid")}/paths`,
    );
    expect(db.body).toMatchObject({
      dataDir: "/data/coolify/databases/db-main-uuid",
      composeFile: "/data/coolify/databases/db-main-uuid/docker-compose.yml",
      volumes: [],
    });

    // A Part lives in its service's folder.
    const part = await h.request(
      "GET",
      `${base(connectionId, "svc-n8n-uuid")}/paths?part=part-n8n-uuid`,
    );
    expect(part.body).toMatchObject({
      dataDir: "/data/coolify/services/svc-n8n-uuid",
      composeFile: "/data/coolify/services/svc-n8n-uuid/docker-compose.yml",
      volumes: ["/var/lib/docker/volumes/n8n-data/_data"],
    });
  });

  it("tunnel name is web:<hostId>:coolify-<uuid>, stop closes it", async () => {
    const { harness: h, connectionId, calls } = await start();
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING], ips: "10.0.1.5 \n" });
    const opened = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/tunnel`,
      { port: 3000 },
    );
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({
      name: `web:${HOST_ID}:coolify-app-web-uuid`,
      hostId: HOST_ID,
      targetPort: 3000,
      bindHost: "127.0.0.1",
      bindPort: 41234,
    });
    expect(calls.forward).toEqual([
      [
        HOST_ID,
        {
          name: `web:${HOST_ID}:coolify-app-web-uuid`,
          targetHost: "10.0.1.5",
          targetPort: 3000,
          bindHost: "127.0.0.1",
          persist: false,
        },
      ],
    ]);
    expect(
      docker.commands.some((c) =>
        c.startsWith(
          "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' web-abc",
        ),
      ),
    ).toBe(true);

    const closed = await h.request(
      "DELETE",
      `${base(connectionId, "app-web-uuid")}/tunnel/3000`,
    );
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({
      name: `web:${HOST_ID}:coolify-app-web-uuid`,
      closed: true,
    });
    expect(calls.stop).toEqual([[`web:${HOST_ID}:coolify-app-web-uuid`]]);
  });

  it("container IP that doesn't parse is refused", async () => {
    for (const ips of [
      "",
      "not-an-ip \n",
      "10.0.1.5 300.1.1.1 \n",
      "<no value>",
    ]) {
      const { harness: h, connectionId, calls } = await start();
      fakeDockerHost(h, { ps: [WEB_RUNNING], ips });
      const res = await h.request(
        "POST",
        `${base(connectionId, "app-web-uuid")}/tunnel`,
        { port: 3000 },
      );
      expect(res.status).toBe(502);
      expect(res.body.cause).toBe("bad-container-ip");
      expect(calls.forward).toEqual([]);
      await h.close();
      harness = null;
    }
  });

  it("web UI refuses without Reverse Proxy endpoint", async () => {
    const {
      harness: h,
      connectionId,
      calls,
    } = await start({
      proxyReady: false,
    });
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/web-ui`,
      { port: 80 },
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("proxy-not-configured");
    expect(res.body.error).toMatch(/web endpoint domain/i);
    expect(calls.open).toEqual([]);
    expect(docker.commands).toEqual([]);
  });

  it("web UI opens a one-time URL to the container's port", async () => {
    const { harness: h, connectionId, calls } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING], ips: "10.0.1.5 \n" });
    const res = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/web-ui`,
      { port: 8080, scheme: "http" },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://e-1a2b.apps.example.test/?once=fake-one-time",
    });
    expect(calls.open).toEqual([
      [
        {
          hostId: HOST_ID,
          target: { host: "10.0.1.5", port: 8080, scheme: "http" },
        },
      ],
    ]);
  });

  it("companion-missing per plugin", async () => {
    const cases: Array<{
      plugin: string;
      method: string;
      path: string;
      body?: unknown;
    }> = [
      { plugin: FILES, method: "GET", path: "paths" },
      { plugin: TUNNELS, method: "POST", path: "tunnel", body: { port: 3000 } },
      { plugin: TUNNELS, method: "DELETE", path: "tunnel/3000" },
      {
        plugin: REVERSE_PROXY,
        method: "POST",
        path: "web-ui",
        body: { port: 80 },
      },
    ];
    for (const c of cases) {
      const running = [FILES, TUNNELS, REVERSE_PROXY].filter(
        (p) => p !== c.plugin,
      );
      const { harness: h, connectionId, calls } = await start({ running });
      const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
      const res = await h.request(
        c.method,
        `${base(connectionId, "app-web-uuid")}/${c.path}`,
        c.body,
      );
      expect(res.status, c.path).toBe(404);
      expect(res.body).toMatchObject({
        cause: "companion-missing",
        plugin: c.plugin,
      });
      expect(docker.commands).toEqual([]);
      expect(calls.forward).toEqual([]);
      expect(calls.open).toEqual([]);
      await h.close();
      harness = null;
    }
  });

  it("a running plugin without the service it needs is companion-missing", async () => {
    const { harness: h, connectionId } = await start({
      services: { "tunnels.access": { async forward() {} } },
    });
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/tunnel`,
      { port: 3000 },
    );
    // No stop: a forward that can't be closed is never opened.
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      cause: "companion-missing",
      plugin: TUNNELS,
    });
    const web = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/web-ui`,
      { port: 80 },
    );
    expect(web.body).toMatchObject({
      cause: "companion-missing",
      plugin: REVERSE_PROXY,
    });
    expect(docker.commands).toEqual([]);
  });

  it("GET /companions answers which companions run", async () => {
    const { harness: h } = await start({ running: [TUNNELS] });
    const res = await h.request("GET", "/companions");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      files: false,
      tunnels: true,
      reverseProxy: false,
    });
  });

  it("the port must be an integer from 1 to 65535", async () => {
    const { harness: h, connectionId, calls } = await start();
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    for (const port of [0, 65536, 3000.5, "3000", -1, null, "22; reboot"]) {
      const res = await h.request(
        "POST",
        `${base(connectionId, "app-web-uuid")}/tunnel`,
        { port },
      );
      expect(res.status, String(port)).toBe(400);
      const web = await h.request(
        "POST",
        `${base(connectionId, "app-web-uuid")}/web-ui`,
        { port },
      );
      expect(web.status, String(port)).toBe(400);
    }
    for (const port of ["0", "70000", "abc"]) {
      const res = await h.request(
        "DELETE",
        `${base(connectionId, "app-web-uuid")}/tunnel/${port}`,
      );
      expect(res.status, port).toBe(400);
    }
    const scheme = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/web-ui`,
      { port: 80, scheme: "ftp" },
    );
    expect(scheme.status).toBe(400);
    expect(docker.commands).toEqual([]);
    expect(calls.forward).toEqual([]);
    expect(calls.stop).toEqual([]);
  });

  it("a uuid outside the connection, or another user's connection, is a 404 and runs nothing", async () => {
    const { harness: h, connectionId, calls } = await start();
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    for (const [method, path, body] of [
      ["GET", "paths", undefined],
      ["POST", "tunnel", { port: 3000 }],
      ["DELETE", "tunnel/3000", undefined],
      ["POST", "web-ui", { port: 80 }],
    ] as const) {
      const missing = await h.request(
        method,
        `${base(connectionId, "app-elsewhere")}/${path}`,
        body,
      );
      expect(missing.status, path).toBe(404);
      const other = await h.request(
        method,
        `${base(connectionId, "app-web-uuid")}/${path}`,
        body,
        OTHER,
      );
      expect(other.status, path).toBe(404);
    }
    expect(docker.commands).toEqual([]);
    expect(calls).toEqual({ forward: [], stop: [], available: 0, open: [] });
  });

  it("refuses a Linked host the actor can't open, before any SSH or companion call", async () => {
    const { harness: h, connectionId, calls } = await start();
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    for (const [method, path, body] of [
      ["GET", "paths", undefined],
      ["POST", "tunnel", { port: 3000 }],
      ["DELETE", "tunnel/3000", undefined],
      ["POST", "web-ui", { port: 80 }],
    ] as const) {
      const res = await h.request(
        method,
        `${base(connectionId, "app-web-uuid")}/${path}`,
        body,
      );
      expect(res.status, path).toBe(403);
      expect(res.body.cause).toBe("no-host-access");
    }
    expect(docker.commands).toEqual([]);
    expect(calls.forward).toEqual([]);
    expect(calls.stop).toEqual([]);
    expect(calls.open).toEqual([]);
  });

  it("without coolify.operate 403", async () => {
    const {
      harness: h,
      connectionId,
      calls,
    } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    for (const [method, path, body] of [
      ["GET", "paths", undefined],
      ["POST", "tunnel", { port: 3000 }],
      ["DELETE", "tunnel/3000", undefined],
      ["POST", "web-ui", { port: 80 }],
    ] as const) {
      const res = await h.request(
        method,
        `${base(connectionId, "app-web-uuid")}/${path}`,
        body,
      );
      expect(res.status, path).toBe(403);
    }
    expect(docker.commands).toEqual([]);
    expect(calls.forward).toEqual([]);
  });

  it("several containers answer choices, and a chosen one is forwarded", async () => {
    const { harness: h, connectionId, calls } = await start();
    fakeDockerHost(h, {
      ps: [
        [
          /serviceUuid=svc-n8n-uuid/,
          "n8n-a|running|part-n8n-uuid|n8n\npg-a|running|part-postgres-uuid|postgresql\n",
        ],
      ],
    });
    const choices = await h.request(
      "POST",
      `${base(connectionId, "svc-n8n-uuid")}/tunnel`,
      { port: 5432 },
    );
    expect(choices.status).toBe(300);
    expect(choices.body.choices.map((c: { name: string }) => c.name)).toEqual([
      "n8n-a",
      "pg-a",
    ]);
    const chosen = await h.request(
      "POST",
      `${base(connectionId, "svc-n8n-uuid")}/tunnel`,
      { port: 5432, container: "pg-a" },
    );
    expect(chosen.status).toBe(200);
    expect(calls.forward[0]?.[1]).toMatchObject({ targetPort: 5432 });
    const madeUp = await h.request(
      "POST",
      `${base(connectionId, "svc-n8n-uuid")}/tunnel`,
      { port: 5432, container: "someone-else" },
    );
    expect(madeUp.status).toBe(404);
    expect(madeUp.body.cause).toBe("container-not-found");
  });

  it("never passes the Coolify token to a companion", async () => {
    const { harness: h, connectionId, calls } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    await h.request("POST", `${base(connectionId, "app-web-uuid")}/tunnel`, {
      port: 3000,
    });
    await h.request(
      "DELETE",
      `${base(connectionId, "app-web-uuid")}/tunnel/3000`,
    );
    await h.request("POST", `${base(connectionId, "app-web-uuid")}/web-ui`, {
      port: 80,
    });
    expect(calls.forward.length + calls.stop.length + calls.open.length).toBe(
      3,
    );
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });
});
