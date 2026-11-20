import { describe, expect, it } from "vitest";
import type { PluginSshExecResult } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto } from "../../../src/backend/coolify/dto.js";
import { resolveContainers } from "../../../src/backend/containers/resolver.js";
import type { SshRunner } from "../../../src/backend/ssh.js";

function ok(stdout: string): PluginSshExecResult {
  return { stdout, stderr: "", code: 0, truncated: false, timedOut: false };
}

/** A runner that answers docker ps by the first filter that matches a rule. */
function fakeRunner(rules: Array<[RegExp, string]>) {
  const commands: string[] = [];
  const run: SshRunner = async (_hostId, command) => {
    commands.push(command);
    for (const [pattern, out] of rules) {
      if (pattern.test(command)) return ok(out);
    }
    return ok("");
  };
  return { run, commands };
}

function resource(over: Partial<ResourceDto>): ResourceDto {
  return {
    uuid: "app-web-uuid",
    id: 11,
    name: "web",
    kind: "application",
    status: "running:healthy",
    serverUuid: "srv-vps1-uuid",
    serverName: "vps1",
    projectName: "Shop",
    environmentName: "production",
    fqdns: [],
    parentUuid: null,
    engine: null,
    lastDeployAt: null,
    ...over,
  };
}

describe("container resolver", () => {
  it("resolver uses uuid label first", async () => {
    const { run, commands } = fakeRunner([
      [/coolify\.applicationUuid=app-web-uuid/, "web-abc|running||\n"],
    ]);
    const found = await resolveContainers(run, 7, resource({}));
    expect(found).toEqual([{ name: "web-abc", running: true, part: null }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(
      "--filter 'label=coolify.applicationUuid=app-web-uuid'",
    );
    expect(commands[0]).toMatch(/^docker ps -a /);
  });

  it("resolver falls back to pre-4.4 labels using the numeric id", async () => {
    const legacy = resource({ uuid: "app-legacy-uuid", id: 42 });
    const { run, commands } = fakeRunner([
      [
        /coolify\.applicationId=42.*name=app-legacy-uuid/,
        "app-legacy-uuid-1200|exited||\n",
      ],
    ]);
    const found = await resolveContainers(run, 7, legacy);
    expect(found).toEqual([
      { name: "app-legacy-uuid-1200", running: false, part: null },
    ]);
    expect(commands[0]).toContain(
      "label=coolify.applicationUuid=app-legacy-uuid",
    );
    expect(commands[1]).toContain("--filter 'label=coolify.applicationId=42'");
    expect(commands[1]).toContain(
      "--filter 'label=com.docker.compose.project=app-legacy-uuid'",
    );
    expect(commands[2]).toContain("--filter 'label=coolify.applicationId=42'");
    expect(commands[2]).toContain("--filter 'name=app-legacy-uuid'");
    // The uuid is never used where the numeric id belongs.
    expect(commands.join("\n")).not.toContain("applicationId=app-legacy-uuid");
  });

  it("databases and services use their own label names", async () => {
    const db = fakeRunner([]);
    await resolveContainers(
      db.run,
      7,
      resource({ uuid: "db-main-uuid", id: 21, kind: "database" }),
    );
    expect(db.commands[0]).toContain("label=coolify.databaseUuid=db-main-uuid");
    expect(db.commands[1]).toContain("label=coolify.databaseId=21");

    const svc = fakeRunner([
      [
        /coolify\.serviceUuid=svc-n8n-uuid'/,
        "n8n-svc|running|part-n8n-uuid|n8n\npostgresql-svc|running||postgresql\n",
      ],
    ]);
    const found = await resolveContainers(
      svc.run,
      7,
      resource({ uuid: "svc-n8n-uuid", id: 31, kind: "service" }),
    );
    expect(found).toEqual([
      { name: "n8n-svc", running: true, part: "part-n8n-uuid" },
      { name: "postgresql-svc", running: true, part: "postgresql" },
    ]);
  });

  it("a service part matches by sub-uuid, then by compose service name", async () => {
    const part = resource({
      uuid: "part-postgres-uuid",
      id: 51,
      name: "postgresql",
      kind: "service-database",
      parentUuid: "svc-n8n-uuid",
      engine: "postgres:16-alpine",
    });
    const bySub = fakeRunner([
      [
        /coolify\.service\.subUuid=part-postgres-uuid/,
        "pg-1|running|part-postgres-uuid|postgresql\n",
      ],
    ]);
    expect(await resolveContainers(bySub.run, 7, part)).toEqual([
      { name: "pg-1", running: true, part: "part-postgres-uuid" },
    ]);
    expect(bySub.commands).toHaveLength(1);

    const byCompose = fakeRunner([
      [
        /com\.docker\.compose\.service=postgresql/,
        "postgresql-old|running||postgresql\n",
      ],
    ]);
    expect(await resolveContainers(byCompose.run, 7, part)).toEqual([
      { name: "postgresql-old", running: true, part: "part-postgres-uuid" },
    ]);
    expect(byCompose.commands[1]).toContain(
      "--filter 'label=com.docker.compose.project=svc-n8n-uuid'",
    );
    expect(byCompose.commands[1]).toContain(
      "--filter 'label=com.docker.compose.service=postgresql'",
    );
  });

  it("quotes every value and runs docker through sudo when asked", async () => {
    const part = resource({
      uuid: "part-x-uuid",
      name: "it's; $(id)",
      kind: "service-application",
      parentUuid: "svc-n8n-uuid",
    });
    const { run, commands } = fakeRunner([]);
    await resolveContainers(run, 7, part, { sudo: true });
    for (const command of commands) {
      expect(command).toMatch(/^sudo -n docker ps -a /);
    }
    expect(commands[1]).toContain(
      `--filter 'label=com.docker.compose.service=it'\\''s; $(id)'`,
    );
  });

  it("drops lines it can't parse and names outside the allowed set", async () => {
    const { run } = fakeRunner([
      [
        /applicationUuid/,
        "good-1|running||\nbad;name|running||\nnot a line\n|running||\ngood-2|exited||\n",
      ],
    ]);
    expect(await resolveContainers(run, 7, resource({}))).toEqual([
      { name: "good-1", running: true, part: null },
      { name: "good-2", running: false, part: null },
    ]);
  });

  it("a failed docker ps is an error, not an empty list", async () => {
    const run: SshRunner = async () => ({
      stdout: "",
      stderr: "permission denied",
      code: 1,
      truncated: false,
      timedOut: false,
    });
    await expect(resolveContainers(run, 7, resource({}))).rejects.toThrow();
  });
});
