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
import { HEAVY_TEST_MS } from "../../shared/timing.js";

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
      body: { confirm: true },
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
    const unknown = await h.request("DELETE", `${base}/999`, { confirm: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.cause).toBe("dns-record-not-found");
    const elsewhere = await h.request(
      "DELETE",
      `/connections/${connectionId}/resources/svc-n8n-app/dns/${created.body.id}`,
      { confirm: true },
    );
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body.cause).toBe("dns-record-not-found");
    expect(companions.calls.map((c) => c.name)).not.toContain(
      "dns.delete-record",
    );

    const removed = await h.request("DELETE", `${base}/${created.body.id}`, {
      confirm: true,
    });
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
          { confirm: true },
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
      (
        await h.request("DELETE", `${c}/resources/app-web-uuid/dns/1`, {
          confirm: true,
        })
      ).status,
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
    // Both DNS writes really ran: a record made and then removed by its id.
    const c = `/connections/${connectionId}/resources/app-web-uuid/dns`;
    const made = await h.request("POST", c, { fqdn: "b.example.test" });
    expect(made.status).toBe(201);
    const removed = await h.request("DELETE", `${c}/${made.body.id}`, {
      confirm: true,
    });
    expect(removed.status).toBe(200);
    const names = companions.calls.map((call) => call.name);
    expect(names).toContain("dns.upsert-record");
    expect(names).toContain("dns.delete-record");
    const all = JSON.stringify(companions.calls);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(DB_PASSWORD);
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
    const removed = await h.request("DELETE", `${base}/${made.body.id}`, {
      confirm: true,
    });
    expect(removed.status).toBe(404);
    expect(removed.body.cause).toBe("not-found");
    expect(companions.calls).toEqual([]);
    expect(
      h.db.sqlite.prepare("SELECT id FROM p_coolify_dns_records").all(),
    ).toHaveLength(1);
  });

  // Fixed work: GET retries wait out the request layer's real backoff
  // (0.5 s, then 1.5 s), so it takes 2 s idle; a busy machine stretched
  // past Vitest's 5 s (#105). An explicit timeout keeps a wide margin.
  it(
    "a stored DNS record is not removed when the resource list can't be read",
    async () => {
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
      const removed = await h.request("DELETE", `${base}/${made.body.id}`, {
        confirm: true,
      });
      expect(removed.status).toBeGreaterThanOrEqual(400);
      expect(companions.calls).toEqual([]);
      expect(
        h.db.sqlite.prepare("SELECT id FROM p_coolify_dns_records").all(),
      ).toHaveLength(1);
    },
    HEAVY_TEST_MS,
  );

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

describe("review findings", () => {
  const dnsPath = (id: number) =>
    `/connections/${id}/resources/app-web-uuid/dns`;
  const rows = (h: PluginHarness) =>
    h.db.sqlite.prepare("SELECT * FROM p_coolify_dns_records").all();

  it("a grant lowered to view while a DNS create runs stops it before the DNS write", async () => {
    const { harness: h, connectionId, companions } = await start();
    grant(h, connectionId, OTHER, "configure");
    const zones = companions.actions["dns.list-zones"];
    companions.actions["dns.list-zones"] = async (input, hostId) => {
      h.db.sqlite
        .prepare("UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?")
        .run(OTHER);
      return zones(input, hostId);
    };
    const res = await h.request(
      "POST",
      dnsPath(connectionId),
      { fqdn: "a.example.test", type: "A", content: "203.0.113.11" },
      OTHER,
    );
    expect(res.status).toBe(403);
    expect(companions.calls.map((c) => c.name)).toEqual(["dns.list-zones"]);
    expect(rows(h)).toEqual([]);
  });

  it("the DNS delete route needs confirm: true and calls nothing without it", async () => {
    const { harness: h, connectionId, companions } = await start();
    const made = await h.request("POST", dnsPath(connectionId), {
      fqdn: "a.example.test",
    });
    companions.calls.length = 0;
    for (const body of [undefined, {}, { confirm: "yes" }]) {
      const res = await h.request(
        "DELETE",
        `${dnsPath(connectionId)}/${made.body.id}`,
        body,
      );
      expect(res.status).toBe(400);
      expect(res.body.cause).toBe("confirm-required");
    }
    expect(companions.calls).toEqual([]);
    expect(rows(h)).toHaveLength(1);
    // ?confirm=true is the same confirm, for clients that send no body.
    const viaQuery = await h.request(
      "DELETE",
      `${dnsPath(connectionId)}/${made.body.id}?confirm=true`,
    );
    expect(viaQuery.status).toBe(200);
  });

  it("AAAA content must be a real IPv6 address, and type an exact string", async () => {
    const { harness: h, connectionId, companions } = await start();
    const post = (body: Record<string, unknown>) =>
      h.request("POST", dnsPath(connectionId), {
        fqdn: "a.example.test",
        ...body,
      });
    expect((await post({ type: "AAAA", content: ":::" })).status).toBe(400);
    expect((await post({ content: ":::" })).status).toBe(400);
    expect((await post({ type: ["A"], content: "203.0.113.11" })).status).toBe(
      400,
    );
    expect(companions.calls).toEqual([]);
    const ok = await post({ type: "AAAA", content: "2001:db8::1" });
    expect(ok.status).toBe(201);
    expect(ok.body.type).toBe("AAAA");
  });

  it("a resource domain with a trailing dot is still one of its domains", async () => {
    const { harness: h, connectionId, fake } = await start();
    fake.set("GET /applications", {
      json: [
        {
          id: 11,
          uuid: "app-web-uuid",
          name: "web",
          status: "running",
          fqdn: "https://a.example.test./",
          destination: { server: { uuid: "srv-web1" } },
        },
      ],
    });
    const res = await h.request("POST", dnsPath(connectionId), {
      fqdn: "a.example.test",
      content: "203.0.113.11",
    });
    expect(res.status).toBe(201);
  });

  it("two overlapping creates for one name each answer their own row", async () => {
    const { harness: h, connectionId } = await start();
    // Once the first request's row is in, its save and its DNS call wait,
    // so the second request inserts in between.
    const persist = h.mock.ctx.db.persist.bind(h.mock.ctx.db);
    let waited = false;
    const wait = async () => {
      if (waited) return;
      const stored = JSON.stringify(rows(h));
      if (!stored.includes("203.0.113.11")) return;
      waited = true;
      await new Promise((r) => setTimeout(r, 50));
    };
    vi.spyOn(h.mock.ctx.db, "persist").mockImplementation(async () => {
      await wait();
      return persist();
    });
    const [one, two] = await Promise.all([
      h.request("POST", dnsPath(connectionId), {
        fqdn: "a.example.test",
        type: "A",
        content: "203.0.113.11",
      }),
      h.request("POST", dnsPath(connectionId), {
        fqdn: "a.example.test",
        type: "A",
        content: "203.0.113.12",
      }),
    ]);
    expect(one.body.content).toBe("203.0.113.11");
    expect(two.body.content).toBe("203.0.113.12");
    expect(one.body.id).not.toBe(two.body.id);
  });

  it("a record still being created is not listed, and a remove waits for the create", async () => {
    const { harness: h, connectionId, companions } = await start();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const inUpsert = new Promise<void>((r) => (started = r));
    companions.actions["dns.upsert-record"] = async () => {
      started();
      await new Promise<void>((r) => (release = r));
      return { summary: "record set", changed: true };
    };
    const creating = h.request("POST", dnsPath(connectionId), {
      fqdn: "a.example.test",
    });
    await inUpsert;
    const [pending] = rows(h) as { id: number }[];
    expect(pending).toBeTruthy();
    // Not visible to another client while the DNS write runs.
    const listed = await h.request("GET", dnsPath(connectionId));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
    // A remove of that id waits behind the create, and runs after it.
    const removing = h.request(
      "DELETE",
      `${dnsPath(connectionId)}/${pending.id}`,
      { confirm: true },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(companions.calls.map((c) => c.name)).not.toContain(
      "dns.delete-record",
    );
    release();
    expect((await creating).status).toBe(201);
    expect((await removing).status).toBe(200);
    const names = companions.calls.map((c) => c.name);
    expect(names.indexOf("dns.delete-record")).toBeGreaterThan(
      names.indexOf("dns.upsert-record"),
    );
  });

  it("the record's handle is stored before the DNS write, and dropped if that write fails", async () => {
    const { harness: h, connectionId, companions } = await start();
    let storedFirst = -1;
    companions.actions["dns.upsert-record"] = () => {
      storedFirst = rows(h).length;
      return { summary: "record set", changed: true };
    };
    expect(
      (
        await h.request("POST", dnsPath(connectionId), {
          fqdn: "a.example.test",
        })
      ).status,
    ).toBe(201);
    expect(storedFirst).toBe(1);
    expect(rows(h)).toHaveLength(1);
    companions.actions["dns.upsert-record"] = () => {
      throw new Error("provider down");
    };
    const failed = await h.request("POST", dnsPath(connectionId), {
      fqdn: "b.example.test",
    });
    expect(failed.status).toBe(502);
    expect(rows(h)).toHaveLength(1);
  });

  it("an answer with no recognizable list is companion-failed, an explicit empty one is empty", async () => {
    const { harness: h, connectionId, companions } = await start();
    const path = `/connections/${connectionId}/resources/app-web-uuid/uptime`;
    companions.actions["uptime.monitors"] = () => ({ summary: "?", data: {} });
    const bad = await h.request("GET", path);
    expect(bad.status).toBe(502);
    expect(bad.body.cause).toBe("companion-failed");
    companions.actions["uptime.monitors"] = () => ({
      summary: "none",
      data: { rows: [] },
    });
    const empty = await h.request("GET", path);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ monitors: [] });
    companions.actions["backups.failed"] = () => ({ summary: "?" });
    const backups = await h.request(
      "GET",
      `/connections/${connectionId}/servers/srv-web1/backups-failed`,
    );
    expect(backups.status).toBe(502);
  });

  it("a login name shared by two databases on the host proves neither saved", async () => {
    const { harness: h, connectionId, fake, companions } = await start();
    fake.set("GET /databases", {
      json: [
        {
          id: 21,
          uuid: "db-a-uuid",
          name: "postgresql",
          database_type: "standalone-postgresql",
          status: "running",
          destination: { server: { uuid: "srv-web1" } },
        },
        {
          id: 22,
          uuid: "db-b-uuid",
          name: "postgresql",
          database_type: "standalone-postgresql",
          status: "running",
          destination: { server: { uuid: "srv-web1" } },
        },
      ],
    });
    companions.actions["databases.list-connections"] = () => ({
      summary: "1 login",
      data: { rows: [{ id: 1, name: "postgresql", database: "postgres" }] },
    });
    const all = await h.request(
      "GET",
      `/connections/${connectionId}/servers/srv-web1/db-logins`,
    );
    expect(all.status).toBe(200);
    expect(
      all.body.databases.filter((d: { saved: boolean }) => d.saved),
    ).toEqual([]);
    const one = await h.request(
      "GET",
      `/connections/${connectionId}/resources/db-a-uuid/db-login`,
    );
    expect(one.body.saved).toBe(false);
    expect(one.body.logins).toEqual([]);
  });

  it("monitors match a resource's URL path, not every monitor on its host", async () => {
    const { harness: h, connectionId, companions } = await start();
    companions.actions["uptime.monitors"] = () => ({
      summary: "2",
      data: {
        rows: [
          {
            id: "mon-app",
            name: "app",
            url: "https://b.example.test/app/health",
            status: "up",
          },
          {
            id: "mon-admin",
            name: "admin",
            url: "https://b.example.test/admin/health",
            status: "up",
          },
          {
            id: "mon-apple",
            name: "apple",
            url: "https://b.example.test/apple",
            status: "up",
          },
        ],
      },
    });
    const res = await h.request(
      "GET",
      `/connections/${connectionId}/resources/app-web-uuid/uptime`,
    );
    expect(res.body.monitors.map((m: { id: string }) => m.id)).toEqual([
      "mon-app",
    ]);
  });
});
