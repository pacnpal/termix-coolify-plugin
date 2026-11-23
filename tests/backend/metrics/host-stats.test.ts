import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSshExecResult } from "@termix-ssh/plugin-sdk/backend";
import { STATS_INTERVAL_MS } from "../../../src/backend/containers/stats.js";
import {
  HOST_STATS_TTL_MS,
  MAX_HOST_STATS_SERVERS,
  parseHostStats,
} from "../../../src/backend/metrics/service.js";
import { grant } from "../helpers/lifecycle.js";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import {
  HOST_ID,
  SERVER_UUID,
  startMetrics,
  type MetricsOptions,
} from "./fixtures.js";

const T0 = Date.parse("2026-11-22T10:00:00Z");

/** docker info's two numbers, then one docker stats line per container. */
const STATS_OUTPUT = [
  "4 8000000000",
  `{"CPUPerc":"12.50%","MemPerc":"3.10%","MemUsage":"64MiB / 2GiB","NetIO":"1.5kB / 2MB","Name":"web-abc"}`,
  `{"CPUPerc":"25.00%","MemPerc":"1.00%","MemUsage":"1GiB / 8GiB","NetIO":"0B / 0B","Name":"db-def"}`,
  "",
].join("\n");

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

function result(stdout: string, code = 0): PluginSshExecResult {
  return { stdout, stderr: "", code, truncated: false, timedOut: false };
}

/** Stands in for ctx.ssh.exec on the Linked host: root, docker answering. */
function fakeDocker(h: PluginHarness, stats = STATS_OUTPUT) {
  const commands: string[] = [];
  const exec = vi
    .spyOn(h.mock.ctx.ssh, "exec")
    .mockImplementation(async (_target, command) => {
      commands.push(command);
      if (command === "id -u; id -Gn") return result("0\nroot\n");
      if (/docker stats --no-stream/.test(command)) return result(stats);
      return result("", 127);
    });
  const statsRuns = () => commands.filter((c) => /docker stats/.test(c));
  return { exec, commands, statsRuns };
}

async function start(options: MetricsOptions = {}) {
  const started = await startMetrics(options);
  harness = started.harness;
  const id = started.connectionId;
  return {
    ...started,
    id,
    read: (servers = SERVER_UUID, user?: string) =>
      started.harness.request(
        "GET",
        `/connections/${id}/host-metrics?servers=${servers}`,
        undefined,
        user,
      ),
  };
}

describe("parseHostStats", () => {
  it("sums every container's CPU and memory, with the host's CPUs and memory", () => {
    expect(parseHostStats(STATS_OUTPUT, T0)).toEqual({
      containers: 2,
      cpuPercent: 37.5,
      memoryBytes: 64 * 1024 ** 2 + 1024 ** 3,
      cpus: 4,
      memoryTotalBytes: 8_000_000_000,
      at: new Date(T0).toISOString(),
    });
  });

  it("no running container is zero; docker info that failed leaves the totals unknown", () => {
    expect(parseHostStats("", T0)).toMatchObject({
      containers: 0,
      cpuPercent: 0,
      memoryBytes: 0,
      cpus: null,
      memoryTotalBytes: null,
    });
  });
});

describe("host container stats route", () => {
  it("answers a Linked host's container summary, never addresses or names", async () => {
    const { read, harness: h } = await start();
    const ssh = fakeDocker(h);
    const answer = await read();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      servers: {
        [SERVER_UUID]: expect.objectContaining({
          containers: 2,
          cpuPercent: 37.5,
          cpus: 4,
          memoryTotalBytes: 8_000_000_000,
        }),
      },
      errors: {},
    });
    expect(JSON.stringify(answer.body)).not.toContain("web-abc");
    expect(ssh.statsRuns()).toEqual([
      "docker info --format '{{.NCPU}} {{.MemTotal}}' 2>/dev/null; docker stats --no-stream --format '{{json .}}'",
    ]);
  });

  it("an unlinked server answers not-linked for that server and runs no SSH", async () => {
    const { read, harness: h } = await start({ linked: false });
    const ssh = fakeDocker(h);
    const answer = await read();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      servers: {},
      errors: { [SERVER_UUID]: "not-linked" },
    });
    expect(ssh.commands).toEqual([]);
  });

  it("without connect access to the Linked host, nothing runs", async () => {
    const { read, harness: h } = await start();
    const ssh = fakeDocker(h);
    vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
    } as never);
    const answer = await read();
    expect(answer.body.errors).toEqual({ [SERVER_UUID]: "no-host-access" });
    expect(ssh.commands).toEqual([]);
  });

  it("needs coolify.operate: a viewer is refused before any SSH", async () => {
    const { read, harness: h } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const ssh = fakeDocker(h);
    expect((await read()).status).toBe(403);
    expect(ssh.commands).toEqual([]);
  });

  it("needs an operate grant: a view grant is refused, another user's connection is 404", async () => {
    const { id, read, harness: h } = await start();
    const ssh = fakeDocker(h);
    expect((await read(SERVER_UUID, OTHER)).status).toBe(404);
    grant(h, id, OTHER, "view");
    expect((await read(SERVER_UUID, OTHER)).status).toBe(403);
    expect(ssh.commands).toEqual([]);
    h.db.sqlite.prepare("UPDATE p_coolify_grants SET level = 'operate'").run();
    expect((await read(SERVER_UUID, OTHER)).status).toBe(200);
  });

  it("reads docker stats at most once per window, however many callers", async () => {
    expect(HOST_STATS_TTL_MS).toBeGreaterThanOrEqual(STATS_INTERVAL_MS);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { read, harness: h } = await start();
    const ssh = fakeDocker(h);
    const [a, b] = await Promise.all([read(), read()]);
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect((await read()).body).toEqual(a.body);
    expect(ssh.statsRuns()).toHaveLength(1);
    vi.setSystemTime(T0 + HOST_STATS_TTL_MS - 1);
    await read();
    expect(ssh.statsRuns()).toHaveLength(1);
    vi.setSystemTime(T0 + HOST_STATS_TTL_MS);
    await read();
    expect(ssh.statsRuns()).toHaveLength(2);
  });

  it("a target change while docker stats runs answers target-changed and keeps nothing", async () => {
    const { read, harness: h } = await start();
    const ssh = fakeDocker(h);
    const inner = ssh.exec.getMockImplementation()!;
    let moved = false;
    ssh.exec.mockImplementation(async (target, command, opts) => {
      const answer = await inner(target, command, opts);
      if (!moved && command.includes("docker stats")) {
        moved = true;
        h.db.sqlite
          .prepare("UPDATE p_coolify_connections SET token_sealed = ?")
          .run(await h.mock.ctx.secrets.seal("fake-token-metrics-moved"));
      }
      return answer;
    });
    const answer = await read();
    expect(answer.status).toBe(409);
    expect(answer.body.cause).toBe("target-changed");
    // Nothing was kept for the old target: the next read runs again.
    expect((await read()).status).toBe(200);
    expect(ssh.statsRuns()).toHaveLength(2);
  });

  it("refuses a missing, malformed or too long server list", async () => {
    const { read, harness: h } = await start();
    const ssh = fakeDocker(h);
    expect((await read("")).status).toBe(400);
    expect((await read("../x")).status).toBe(400);
    const many = Array.from(
      { length: MAX_HOST_STATS_SERVERS + 1 },
      (_, i) => `srv-${i}`,
    ).join(",");
    expect((await read(many)).status).toBe(400);
    expect(ssh.commands).toEqual([]);
  });

  it("a failed docker stats is ssh-failed for that server, never zero", async () => {
    const { read, harness: h } = await start();
    const ssh = fakeDocker(h);
    const inner = ssh.exec.getMockImplementation()!;
    ssh.exec.mockImplementation(async (target, command, opts) =>
      command.includes("docker stats")
        ? result("", 1)
        : inner(target, command, opts),
    );
    const answer = await read();
    expect(answer.body).toEqual({
      servers: {},
      errors: { [SERVER_UUID]: "ssh-failed" },
    });
  });
});

describe("coolify.host-metrics", () => {
  it("answers the Linked host's summary, and linked: false on any other host", async () => {
    const { harness: h, id } = await start();
    const ssh = fakeDocker(h);
    h.mock.setActor(OWNER);
    const linked = await h.mock.ctx.operations.run("coolify.host-metrics", {
      hostId: HOST_ID,
    });
    expect(linked.data).toMatchObject({
      linked: true,
      connectionId: id,
      serverUuid: SERVER_UUID,
      stats: { containers: 2, cpuPercent: 37.5 },
    });
    const before = ssh.commands.length;
    const plain = await h.mock.ctx.operations.run("coolify.host-metrics", {
      hostId: 999,
    });
    expect(plain.data).toEqual({ linked: false });
    expect(ssh.commands.length).toBe(before);
  });

  it("is refused without coolify.operate, before any SSH", async () => {
    const { harness: h } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const ssh = fakeDocker(h);
    await expect(
      h.mock.ctx.operations.run("coolify.host-metrics", { hostId: HOST_ID }),
    ).rejects.toBeTruthy();
    expect(ssh.commands).toEqual([]);
  });
});
