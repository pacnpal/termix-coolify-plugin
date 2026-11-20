import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import {
  DB_PASSWORD,
  HOST_ID,
  TOKEN,
  changeTarget,
  grant,
  startCompanions,
} from "./fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(options: Parameters<typeof startCompanions>[0] = {}) {
  const started = await startCompanions(options);
  harness = started.harness;
  return started;
}

/** Every companion route, with the plugin it needs and a body that passes validation. */
function routes(id: number) {
  const c = `/connections/${id}`;
  return [
    {
      method: "POST",
      path: `${c}/resources/app-web-uuid/dns`,
      body: { fqdn: "a.example.test", type: "A", content: "203.0.113.11" },
      plugin: "dns",
    },
    { method: "GET", path: `${c}/resources/app-web-uuid/dns`, plugin: "dns" },
    {
      method: "DELETE",
      path: `${c}/resources/app-web-uuid/dns/1`,
      plugin: "dns",
    },
    {
      method: "GET",
      path: `${c}/resources/app-web-uuid/uptime`,
      plugin: "uptime",
    },
    {
      method: "GET",
      path: `${c}/log-search?uuid=app-web-uuid`,
      plugin: "log-search",
    },
    {
      method: "GET",
      path: `${c}/servers/srv-web1/security`,
      plugin: "security-center",
    },
    {
      method: "GET",
      path: `${c}/servers/srv-web1/host-metrics`,
      plugin: "host-metrics",
    },
    {
      method: "GET",
      path: `${c}/servers/srv-web1/backups-failed`,
      plugin: "backups",
    },
    {
      method: "GET",
      path: `${c}/resources/db-main-uuid/db-login`,
      plugin: "databases",
    },
    {
      method: "GET",
      path: `${c}/servers/srv-web1/db-logins`,
      plugin: "databases",
    },
  ] as { method: string; path: string; body?: unknown; plugin: string }[];
}

describe("companion detection", () => {
  it("GET /companions answers which companion plugins run", async () => {
    const { harness: h } = await start({
      present: ["dns", "uptime", "log-search"],
    });
    const res = await h.request("GET", "/companions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      docker: false,
      sshTerminal: false,
      files: false,
      tunnels: false,
      reverseProxy: false,
      dns: true,
      uptime: true,
      logSearch: true,
      packageManager: false,
      securityCenter: false,
      hostMetrics: false,
      databases: false,
      backups: false,
    });
  });

  it("each companion route answers companion-missing naming the plugin", async () => {
    const {
      harness: h,
      connectionId,
      fake,
      companions,
    } = await start({
      present: [],
    });
    const before = fake.calls.length;
    for (const route of routes(connectionId)) {
      const res = await h.request(route.method, route.path, route.body);
      expect(res.status, route.path).toBe(404);
      expect(res.body, route.path).toEqual({
        error: expect.any(String),
        cause: "companion-missing",
        plugin: route.plugin,
      });
    }
    // Nothing reached Coolify or a companion.
    expect(fake.calls.length).toBe(before);
    expect(companions.calls).toEqual([]);
  });

  it("a companion that is installed but not running counts as missing", async () => {
    const { harness: h, connectionId } = await start({ state: "disabled" });
    const map = await h.request("GET", "/companions");
    expect(map.body.securityCenter).toBe(false);
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/servers/srv-web1/security`,
    );
    expect(res.status).toBe(404);
    expect(res.body.cause).toBe("companion-missing");
    expect(res.body.plugin).toBe("security-center");
  });

  it("a companion action that fails answers companion-failed naming the plugin", async () => {
    const { harness: h, connectionId, companions } = await start();
    companions.actions["security-center.status"] = () => {
      throw new Error("scan backend down");
    };
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/servers/srv-web1/security`,
    );
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: expect.any(String),
      cause: "companion-failed",
      plugin: "security-center",
    });
    // The companion's own message never reaches the answer.
    expect(JSON.stringify(res.body)).not.toContain("scan backend down");
  });
});

describe("DNS records", () => {
  it("DNS handle stored and removed; removing an unknown handle is refused", async () => {
    const { harness: h, connectionId, companions } = await start();
    const base = `/connections/${connectionId}/resources/app-web-uuid/dns`;

    const created = await h.request("POST", base, {
      fqdn: "a.example.test",
      type: "A",
      content: "203.0.113.11",
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(Number),
      fqdn: "a.example.test",
      type: "A",
      content: "203.0.113.11",
      createdAt: expect.any(String),
    });
    expect(companions.calls.map((c) => c.name)).toEqual([
      "dns.list-zones",
      "dns.upsert-record",
    ]);
    // dns.upsert-record's documented inputs: zone, type, name, content, ttl.
    expect(companions.calls[1].args[0]).toEqual({
      zone: "zone-1",
      type: "A",
      name: "a.example.test",
      content: "203.0.113.11",
    });
    const rows = h.db.sqlite
      .prepare("SELECT * FROM p_coolify_dns_records")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connection_id: connectionId,
      resource_uuid: "app-web-uuid",
      fqdn: "a.example.test",
    });
    // What dns.delete-record takes: zone, type, name and content.
    expect(JSON.parse(String(rows[0].handle))).toEqual({
      zone: "zone-1",
      type: "A",
      name: "a.example.test",
      content: "203.0.113.11",
    });

    const listed = await h.request("GET", base);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([created.body]);

    // An id that was never stored, and one stored for another resource.
    const unknown = await h.request("DELETE", `${base}/999`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.cause).toBe("dns-record-not-found");
    const elsewhere = await h.request(
      "DELETE",
      `/connections/${connectionId}/resources/svc-n8n-app/dns/${created.body.id}`,
    );
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body.cause).toBe("dns-record-not-found");
    expect(companions.calls.map((c) => c.name)).not.toContain(
      "dns.delete-record",
    );

    const removed = await h.request("DELETE", `${base}/${created.body.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ id: created.body.id, removed: true });
    const deleteCall = companions.calls.find(
      (c) => c.name === "dns.delete-record",
    );
    expect(deleteCall?.args[0]).toEqual({
      zone: "zone-1",
      type: "A",
      name: "a.example.test",
      content: "203.0.113.11",
    });
    expect(
      h.db.sqlite.prepare("SELECT * FROM p_coolify_dns_records").all(),
    ).toEqual([]);
    expect((await h.request("GET", base)).body).toEqual([]);
  });

  it("uses the server's address when no content is given", async () => {
    const { harness: h, connectionId, companions } = await start();
    const res = await h.request(
      "POST",
      `/connections/${connectionId}/resources/app-web-uuid/dns`,
      { fqdn: "b.example.test" },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "A", content: "203.0.113.11" });
    expect(companions.calls[1].args[0]).toMatchObject({
      name: "b.example.test",
      type: "A",
      content: "203.0.113.11",
    });
  });

  it("refuses a name that is not one of the resource's domains, and bad values", async () => {
    const { harness: h, connectionId, companions } = await start();
    const base = `/connections/${connectionId}/resources/app-web-uuid/dns`;
    for (const body of [
      { fqdn: "evil.example.test", type: "A", content: "203.0.113.11" },
      { fqdn: "a.example.test", type: "TXT", content: "x" },
      { fqdn: "a.example.test", type: "A", content: "not an ip" },
      { fqdn: "a.example.test", type: "CNAME", content: "bad host!" },
      { fqdn: 42 },
    ]) {
      const res = await h.request("POST", base, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.cause).toBe("invalid-input");
    }
    expect(companions.calls).toEqual([]);
  });
});

describe("Uptime and Log Search", () => {
  it("uptime shows the monitors whose URL is one of the resource's domains", async () => {
    const { harness: h, connectionId } = await start();
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/resources/app-web-uuid/uptime`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      monitors: [
        {
          id: "mon-a",
          name: "web",
          url: "https://A.example.test/",
          status: "up",
        },
        {
          id: "mon-b",
          name: "web app",
          url: "https://b.example.test/app/health",
          status: "down",
        },
      ],
    });
  });

  it("log search uses source docker and the uuid", async () => {
    const { harness: h, connectionId, companions } = await start();
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/log-search?uuid=app-web-uuid`,
    );
    expect(res.status).toBe(200);
    const call = companions.calls.find((c) => c.name === "log-search.search");
    expect(call?.args[0]).toEqual({
      source: "docker",
      query: "app-web-uuid",
      limit: 200,
    });
    expect(res.body).toEqual({
      source: "docker",
      query: "app-web-uuid",
      results: [
        {
          time: "2026-11-19T10:00:00.000Z",
          host: "web-1",
          container: "app-web-uuid-123",
          message: "GET / 200 app-web-uuid",
        },
        {
          time: "2026-11-19T10:00:01.000Z",
          host: null,
          container: null,
          message: "second line",
        },
      ],
    });
  });

  it("log search refuses a uuid that is not a resource of the connection", async () => {
    const { harness: h, connectionId, companions } = await start();
    for (const uuid of ["not-a-resource", "bad uuid!", ""]) {
      const res = await h.request(
        "GET",
        `/connections/${connectionId}/log-search?uuid=${encodeURIComponent(uuid)}`,
      );
      expect(res.status, uuid).toBe(404);
    }
    expect(companions.calls).toEqual([]);
  });
});

describe("Linked host companions", () => {
  it("security, backups and host metrics read the server's Linked host", async () => {
    const { harness: h, connectionId, companions } = await start();
    const c = `/connections/${connectionId}/servers/srv-web1`;

    const security = await h.request("GET", `${c}/security`);
    expect(security.status).toBe(200);
    expect(security.body).toEqual({
      hostId: HOST_ID,
      score: 82,
      critical: 2,
    });
    // Two host reads from the reference, each run on the Linked host.
    for (const name of [
      "security-center.status",
      "security-center.critical-vulns",
    ]) {
      expect(companions.calls.find((x) => x.name === name)?.args[1]).toEqual({
        hostId: HOST_ID,
      });
    }
    const dbCall = companions.calls.find(
      (x) => x.name === "databases.list-connections",
    );
    expect(dbCall).toBeUndefined();

    const backups = await h.request("GET", `${c}/backups-failed`);
    expect(backups.status).toBe(200);
    expect(backups.body).toEqual({
      hostId: HOST_ID,
      jobs: [
        { id: "job-1", name: "nightly", failedAt: "2026-11-19T03:00:00.000Z" },
      ],
    });
    const backupCall = companions.calls.find(
      (x) => x.name === "backups.failed",
    );
    expect(backupCall?.args[1]).toEqual({ hostId: HOST_ID });

    const metrics = await h.request("GET", `${c}/host-metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.body).toEqual({
      hostId: HOST_ID,
      applications: 1,
      services: 1,
      databases: 1,
    });
  });

  it("a server route needs the actor's own access to the Linked host", async () => {
    const { harness: h, connectionId, companions } = await start();
    const c = `/connections/${connectionId}/servers`;
    for (const tail of [
      "security",
      "backups-failed",
      "host-metrics",
      "db-logins",
    ]) {
      // srv-web2's Linked host is one the actor can't reach.
      const hidden = await h.request("GET", `${c}/srv-web2/${tail}`);
      expect(hidden.status, tail).toBe(403);
      expect(hidden.body.cause, tail).toBe("forbidden");
      // A server with no Linked host.
      const unlinked = await h.request("GET", `${c}/srv-nowhere/${tail}`);
      expect(unlinked.status, tail).toBe(404);
      expect(unlinked.body.cause, tail).toBe("not-linked");
    }
    expect(companions.calls).toEqual([]);
  });

  it("db-login lists saved logins on the database's Linked host, never passwords", async () => {
    const { harness: h, connectionId } = await start();
    const one = await h.request(
      "GET",
      `/connections/${connectionId}/resources/db-main-uuid/db-login`,
    );
    expect(one.status).toBe(200);
    expect(one.body).toEqual({
      hostId: HOST_ID,
      saved: true,
      logins: [
        {
          id: 1,
          name: "main-db",
          engine: "postgresql",
          database: "postgres",
          username: "postgres",
        },
      ],
    });

    const all = await h.request(
      "GET",
      `/connections/${connectionId}/servers/srv-web1/db-logins`,
    );
    expect(all.status).toBe(200);
    expect(all.body).toEqual({
      hostId: HOST_ID,
      // In the shared resource list's order: services and their Parts,
      // then databases.
      databases: [
        { uuid: "svc-n8n-db", name: "postgresql", saved: false },
        { uuid: "db-main-uuid", name: "main-db", saved: true },
      ],
    });
    expect(JSON.stringify([one.body, all.body])).not.toContain(DB_PASSWORD);

    // An application is not a database.
    const app = await h.request(
      "GET",
      `/connections/${connectionId}/resources/app-web-uuid/db-login`,
    );
    expect(app.status).toBe(400);
  });
});

describe("access", () => {
  it("another user's connection is not found, from every route", async () => {
    const { harness: h, connectionId, companions } = await start();
    for (const route of routes(connectionId)) {
      const res = await h.request(route.method, route.path, route.body, OTHER);
      expect(res.status, route.path).toBe(404);
      expect(res.body.cause, route.path).toBe("not-found");
    }
    expect(companions.calls).toEqual([]);
  });

  it("a grant reaches only what its level allows", async () => {
    const { harness: h, connectionId } = await start();
    const c = `/connections/${connectionId}`;
    const dns = {
      fqdn: "a.example.test",
      type: "A",
      content: "203.0.113.11",
    };
    grant(h, connectionId, OTHER, "view");
    expect(
      (
        await h.request(
          "GET",
          `${c}/resources/app-web-uuid/uptime`,
          undefined,
          OTHER,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request(
          "GET",
          `${c}/servers/srv-web1/security`,
          undefined,
          OTHER,
        )
      ).status,
    ).toBe(200);
    const search = await h.request(
      "GET",
      `${c}/log-search?uuid=app-web-uuid`,
      undefined,
      OTHER,
    );
    expect(search.status).toBe(403);
    expect(search.body.cause).toBe("forbidden");
    const create = await h.request(
      "POST",
      `${c}/resources/app-web-uuid/dns`,
      dns,
      OTHER,
    );
    expect(create.status).toBe(403);

    h.db.sqlite.prepare("UPDATE p_coolify_grants SET level = 'operate'").run();
    expect(
      (
        await h.request(
          "GET",
          `${c}/log-search?uuid=app-web-uuid`,
          undefined,
          OTHER,
        )
      ).status,
    ).toBe(200);
    expect(
      (await h.request("POST", `${c}/resources/app-web-uuid/dns`, dns, OTHER))
        .status,
    ).toBe(403);

    h.db.sqlite
      .prepare("UPDATE p_coolify_grants SET level = 'configure'")
      .run();
    const made = await h.request(
      "POST",
      `${c}/resources/app-web-uuid/dns`,
      dns,
      OTHER,
    );
    expect(made.status).toBe(201);
    expect(
      (
        await h.request(
          "DELETE",
          `${c}/resources/app-web-uuid/dns/${made.body.id}`,
          undefined,
          OTHER,
        )
      ).status,
    ).toBe(200);
  });

  it("Termix permissions gate each route", async () => {
    const { harness: h, connectionId } = await start({
      permissions: ["coolify.view"],
    });
    const c = `/connections/${connectionId}`;
    expect((await h.request("GET", "/companions")).status).toBe(200);
    expect(
      (await h.request("GET", `${c}/resources/app-web-uuid/uptime`)).status,
    ).toBe(200);
    expect(
      (await h.request("GET", `${c}/log-search?uuid=app-web-uuid`)).status,
    ).toBe(403);
    expect(
      (
        await h.request("POST", `${c}/resources/app-web-uuid/dns`, {
          fqdn: "a.example.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (await h.request("DELETE", `${c}/resources/app-web-uuid/dns/1`)).status,
    ).toBe(403);
  });

  it("never passes a token or secret to a companion", async () => {
    const { harness: h, connectionId, companions } = await start();
    const bodies: unknown[] = [];
    for (const route of routes(connectionId)) {
      bodies.push((await h.request(route.method, route.path, route.body)).body);
    }
    const sent = JSON.stringify(companions.calls);
    expect(companions.calls.length).toBeGreaterThan(5);
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(bodies)).not.toContain(TOKEN);
    expect(JSON.stringify(bodies)).not.toContain(DB_PASSWORD);
  });
});

describe("fails closed", () => {
  it("an unreadable plugin list is companions-unknown, never companion-missing", async () => {
    const { harness: h, connectionId, companions } = await start();
    vi.spyOn(h.mock.ctx.plugins, "list").mockRejectedValue(
      new Error("no plugins:read"),
    );
    const map = await h.request("GET", "/companions");
    expect(map.status).toBe(409);
    expect(map.body.cause).toBe("companions-unknown");
    for (const route of routes(connectionId)) {
      const res = await h.request(route.method, route.path, route.body);
      expect(res.status, route.path).toBe(409);
      expect(res.body.cause, route.path).toBe("companions-unknown");
    }
    expect(companions.calls).toEqual([]);
  });

  it("a DNS record is not set when the connection's target changes first", async () => {
    const { harness: h, connectionId, companions } = await start();
    const zones = companions.actions["dns.list-zones"];
    companions.actions["dns.list-zones"] = async (input, hostId) => {
      await changeTarget(h, connectionId);
      return zones(input, hostId);
    };
    const res = await h.request(
      "POST",
      `/connections/${connectionId}/resources/app-web-uuid/dns`,
      { fqdn: "a.example.test", type: "A", content: "203.0.113.11" },
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(companions.calls.map((c) => c.name)).toEqual(["dns.list-zones"]);
    expect(
      h.db.sqlite.prepare("SELECT * FROM p_coolify_dns_records").all(),
    ).toEqual([]);
  });

  it("a host read answers nothing once the connection's target changed", async () => {
    const { harness: h, connectionId, companions } = await start();
    const status = companions.actions["security-center.status"];
    companions.actions["security-center.status"] = async (input, hostId) => {
      await changeTarget(h, connectionId);
      return status(input, hostId);
    };
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/servers/srv-web1/security`,
    );
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("target-changed");
    expect(companions.calls.map((c) => c.name)).toEqual([
      "security-center.status",
    ]);
  });

  it("a link row for a server the connection's Coolify doesn't have is not found", async () => {
    const { harness: h, connectionId, companions } = await start();
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
      )
      .run(connectionId, "srv-gone", HOST_ID);
    for (const kind of [
      "security",
      "backups-failed",
      "host-metrics",
      "db-logins",
    ]) {
      const res = await h.request(
        "GET",
        `/connections/${connectionId}/servers/srv-gone/${kind}`,
      );
      expect(res.status, kind).toBe(404);
    }
    expect(companions.calls).toEqual([]);
  });

  it("a stored DNS record is not listed or removed once the current target hides its resource", async () => {
    const { harness: h, connectionId, companions, fake } = await start();
    const base = `/connections/${connectionId}/resources/app-web-uuid/dns`;
    const made = await h.request("POST", base, {
      fqdn: "a.example.test",
      type: "A",
      content: "203.0.113.11",
    });
    expect(made.status).toBe(201);
    companions.calls.length = 0;
    // Repointed (a new token, so a new revision and a cold cache), and the
    // new target's Coolify doesn't expose the resource.
    await changeTarget(h, connectionId);
    fake.set("GET /applications", { json: [] });

    const listed = await h.request("GET", base);
    expect(listed.status).toBe(404);
    const removed = await h.request("DELETE", `${base}/${made.body.id}`);
    expect(removed.status).toBe(404);
    expect(removed.body.cause).toBe("not-found");
    expect(companions.calls).toEqual([]);
    expect(
      h.db.sqlite.prepare("SELECT id FROM p_coolify_dns_records").all(),
    ).toHaveLength(1);
  });

  it("a stored DNS record is not removed when the resource list can't be read", async () => {
    const { harness: h, connectionId, companions, fake } = await start();
    const base = `/connections/${connectionId}/resources/app-web-uuid/dns`;
    const made = await h.request("POST", base, {
      fqdn: "a.example.test",
      type: "A",
      content: "203.0.113.11",
    });
    companions.calls.length = 0;
    await changeTarget(h, connectionId);
    fake.set("GET /applications", { status: 500, json: {} });
    const removed = await h.request("DELETE", `${base}/${made.body.id}`);
    expect(removed.status).toBeGreaterThanOrEqual(400);
    expect(companions.calls).toEqual([]);
    expect(
      h.db.sqlite.prepare("SELECT id FROM p_coolify_dns_records").all(),
    ).toHaveLength(1);
  });

  it("reads resources from the shared resource cache, not Coolify every time", async () => {
    const { harness: h, connectionId, fake } = await start();
    const apps = () =>
      fake.calls.filter((c) => c.path === "/applications").length;
    const path = `/connections/${connectionId}/resources/app-web-uuid/uptime`;
    expect((await h.request("GET", path)).status).toBe(200);
    const first = apps();
    expect((await h.request("GET", path)).status).toBe(200);
    expect(apps()).toBe(first);
  });
});
