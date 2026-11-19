import { describe, expect, it } from "vitest";
import {
  toApplication,
  toDatabase,
  toDeployment,
  toPatch,
  toServer,
  toService,
} from "../../../src/backend/coolify/dto.js";
import { createCoolifyApi } from "../../../src/backend/coolify/api.js";
import { createCoolifyHttp } from "../../../src/backend/coolify/http.js";
import { fakeCoolify } from "../helpers/fake-coolify.js";
import servers from "../fixtures/coolify/servers.json";
import application from "../fixtures/coolify/application.json";
import database from "../fixtures/coolify/database.json";
import n8n from "../fixtures/coolify/service-n8n.json";
import deployment from "../fixtures/coolify/deployment.json";

const SECRET_MARKERS = [
  "REDACTED",
  "sentinel_token",
  "logdrain_custom_config",
  'private_key"',
];

function expectClean(value: unknown) {
  const text = JSON.stringify(value);
  for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
}

describe("Coolify DTO strippers", () => {
  it("toServer reads tunnel and coolify-host flags", () => {
    const [vps1, localhost] = servers.map(toServer);
    expect(vps1).toMatchObject({
      uuid: "srv-vps1-uuid",
      name: "vps1",
      ip: "ssh-vps1.example.test",
      port: 22,
      user: "root",
      isTunnel: true,
      isCoolifyHost: false,
      reachable: true,
      usable: true,
      privateKeyId: 3,
      metricsEnabled: true,
      sentinelEnabled: true,
      trafficEnabled: false,
    });
    expect(vps1.hostKeyFingerprints).toEqual([
      "SHA256:fakeFingerprintForTestsOnlyAAAAAAAAAAAAAAAA",
    ]);
    expect(localhost.isTunnel).toBe(false);
    expect(localhost.isCoolifyHost).toBe(true);
    expect(localhost.patch).toBeNull();
  });

  it("toServer treats host.docker.internal as the Coolify host without the flag", () => {
    const raw = { ...servers[1], is_coolify_host: undefined };
    expect(toServer(raw).isCoolifyHost).toBe(true);
  });

  it("toServer drops secrets", () => {
    for (const raw of servers) {
      const text = JSON.stringify(toServer(raw));
      expect(text).not.toContain("sentinel_token");
      expect(text).not.toContain("logdrain_custom_config");
      expect(text).not.toContain("REDACTED");
    }
  });

  it("toPatch maps patch_check_result", () => {
    const patch = toServer(servers[0]).patch;
    expect(patch).toMatchObject({
      updates: 3,
      security: 1,
      rebootRequired: true,
      checkedAt: "2026-11-18T10:00:00.000000Z",
      error: null,
    });
    expect(patch?.items).toEqual([
      {
        package: "docker-ce",
        newVersion: "5:27.0.1",
        currentVersion: "5:26.1.0",
        security: false,
        risk: "docker",
      },
      {
        package: "linux-image-amd64",
        newVersion: "6.1.1",
        currentVersion: "6.1.0",
        security: true,
        risk: "kernel",
      },
      {
        package: "curl",
        newVersion: "7.88.2",
        currentVersion: "7.88.1",
        security: false,
        risk: null,
      },
    ]);
    expect(toPatch(null, null, null)).toBeNull();
    expect(toPatch(null, null, "apt failed")).toMatchObject({
      updates: 0,
      error: "apt failed",
    });
    expect(
      toPatch({ updates: [{ package: "x", security: true }] }, null, null),
    ).toMatchObject({ updates: 1, security: 1, rebootRequired: null });
  });

  it("toService flattens parts", () => {
    const dtos = toService(n8n);
    expect(dtos).toHaveLength(6);
    expect(dtos[0]).toMatchObject({
      uuid: "svc-n8n-uuid",
      kind: "service",
      parentUuid: null,
      serverUuid: "srv-vps1-uuid",
      projectName: "Shop",
      environmentName: "production",
    });
    const parts = dtos.slice(1);
    expect(parts.map((p) => p.kind)).toEqual([
      "service-application",
      "service-application",
      "service-application",
      "service-database",
      "service-database",
    ]);
    for (const part of parts) {
      expect(part.parentUuid).toBe("svc-n8n-uuid");
      expect(part.serverUuid).toBe("srv-vps1-uuid");
    }
    expect(parts[0].fqdns).toEqual(["https://n8n.x"]);
    expect(parts[1].fqdns).toEqual([]);
    expect(parts[2].fqdns).toEqual([]);
    expectClean(dtos);
  });

  it("toApplication splits fqdn", () => {
    const dto = toApplication(application);
    expect(dto).toMatchObject({
      uuid: "app-web-uuid",
      id: 11,
      name: "web",
      kind: "application",
      status: "running:healthy",
      serverUuid: "srv-vps1-uuid",
      projectName: "Shop",
      environmentName: "production",
      parentUuid: null,
      engine: null,
    });
    expect(dto.fqdns).toEqual(["https://a.x", "https://b.x"]);
    expectClean(dto);
  });

  it("toDatabase keeps the engine and drops passwords", () => {
    const dto = toDatabase(database);
    expect(dto).toMatchObject({
      uuid: "db-main-uuid",
      kind: "database",
      engine: "standalone-postgresql",
      serverUuid: "srv-vps1-uuid",
      fqdns: [],
    });
    expectClean(dto);
  });

  it("toDeployment drops the build log", () => {
    const dto = toDeployment(deployment);
    expect(dto).toEqual({
      uuid: "dep-uuid",
      resourceUuid: "app-web-uuid",
      status: "finished",
      commit: "abc1234",
      createdAt: "2026-11-18T09:00:00.000000Z",
      finishedAt: "2026-11-18T09:03:00.000000Z",
    });
  });

  it("tolerates missing and unknown fields", () => {
    expect(() => toServer({ uuid: "x" })).not.toThrow();
    expect(toServer({ uuid: "x" })).toMatchObject({
      uuid: "x",
      name: "",
      port: 22,
      isTunnel: false,
      privateKeyId: null,
      hostKeyFingerprints: [],
      patch: null,
    });
    expect(toService({ uuid: "s" })).toHaveLength(1);
    expect(toApplication({ uuid: "a", fqdn: null }).fqdns).toEqual([]);
  });
});

describe("Coolify API wrappers", () => {
  function api(routes: Parameters<typeof fakeCoolify>[0]) {
    const fake = fakeCoolify(routes);
    const http = createCoolifyHttp(
      fake.fetch,
      {
        baseUrl: "https://coolify.example.test",
        token: "fake-token",
        cfAccess: null,
        allowPrivate: false,
        caCert: null,
      },
      { sleep: async () => {} },
    );
    return { fake, api: createCoolifyApi(http) };
  }

  it("returns DTOs, never raw payloads", async () => {
    const { api: coolify } = api({
      "GET /servers": { json: servers },
      "GET /servers/srv-vps1-uuid": { json: servers[0] },
      "GET /applications": { json: [application] },
      "GET /databases": { json: [database] },
      "GET /services": { json: [n8n] },
    });
    expectClean(await coolify.servers());
    expect((await coolify.server("srv-vps1-uuid")).isTunnel).toBe(true);
    expect(await coolify.applications()).toHaveLength(1);
    expectClean(await coolify.databases());
    expect(await coolify.services()).toHaveLength(6);
  });

  it("reads the version as text and the team, projects and keys without secrets", async () => {
    const { api: coolify } = api({
      "GET /version": { text: "v4.7.5\n" },
      "GET /team": { json: { id: 7, name: "Ops", description: "x" } },
      "GET /projects": {
        json: [{ id: 1, uuid: "p", name: "Shop", team_id: 7 }],
      },
      "GET /security/keys": {
        json: [
          {
            uuid: "k",
            name: "key",
            private_key: "-----BEGIN FAKE-----",
            fingerprint: "SHA256:f",
          },
        ],
      },
      "GET /security/keys/k": {
        json: { uuid: "k", name: "key", private_key: "-----BEGIN FAKE-----" },
      },
    });
    expect(await coolify.version()).toBe("v4.7.5");
    expect(await coolify.team()).toEqual({ id: "7", name: "Ops" });
    expect(await coolify.projects()).toEqual([
      { uuid: "p", name: "Shop", teamId: "7" },
    ]);
    const keys = await coolify.keys();
    expect(keys).toEqual([
      {
        uuid: "k",
        name: "key",
        fingerprint: "SHA256:f",
        privateKeyReadable: true,
      },
    ]);
    const key = await coolify.key("k");
    expect(key.privateKeyReadable).toBe(true);
    expect(JSON.stringify([keys, key])).not.toContain("BEGIN");
  });

  it("calls lifecycle, logs and deploy on the generated paths", async () => {
    const { api: coolify, fake } = api({
      "POST /services/svc/applications/part/restart": { json: {} },
      "POST /databases/db/stop": { json: {} },
      "GET /services/svc/databases/pdb/logs": { json: { logs: "x\ny" } },
      "POST /deploy": {
        json: { deployments: [{ deployment_uuid: "d1", resource_uuid: "a" }] },
      },
      "GET /deployments/applications/a": {
        json: { deployments: [deployment] },
      },
      "GET /deployments/dep-uuid": { json: deployment },
      "PATCH /servers/s/sentinel": { json: {} },
    });
    await coolify.lifecycle("service-application", "part", "restart", {
      parentUuid: "svc",
    });
    await coolify.lifecycle("database", "db", "stop");
    expect(
      await coolify.logs("service-database", "pdb", {
        lines: 5,
        parentUuid: "svc",
      }),
    ).toBe("x\ny");
    expect(await coolify.deploy("a", { force: true })).toEqual({
      deploymentUuids: ["d1"],
    });
    const list = await coolify.deployments("a", { skip: 0, take: 10 });
    expect(list[0].uuid).toBe("dep-uuid");
    expect((await coolify.deployment("dep-uuid")).status).toBe("finished");
    await coolify.patchSentinel("s", { is_sentinel_enabled: true });
    const urls = fake.calls.map((c) => `${c.method} ${c.url}`);
    expect(urls).toContain(
      "GET https://coolify.example.test/api/v1/services/svc/databases/pdb/logs?lines=5",
    );
    expect(urls).toContain(
      "POST https://coolify.example.test/api/v1/deploy?uuid=a&force=true",
    );
    expect(urls).toContain(
      "GET https://coolify.example.test/api/v1/deployments/applications/a?skip=0&take=10",
    );
  });

  it("refuses a part without its service", async () => {
    const { api: coolify } = api({});
    await expect(
      coolify.lifecycle("service-database", "pdb", "start"),
    ).rejects.toMatchObject({ cause: "validation" });
  });
});
