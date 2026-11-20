import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginWebSocketConnection } from "@termix-ssh/plugin-sdk/backend";
import {
  parseDockerStats,
  STATS_INTERVAL_MS,
  statsCommand,
} from "../../../src/backend/containers/stats.js";
import { grant } from "../helpers/lifecycle.js";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import { fakeDocker, startShell } from "./fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const STATS_LINE =
  '{"BlockIO":"0B / 0B","CPUPerc":"12.50%","Container":"web-abc","ID":"abc","MemPerc":"3.10%","MemUsage":"64MiB / 2GiB","Name":"web-abc","NetIO":"1.5kB / 2MB","PIDs":"4"}';

class FakeSocket extends EventEmitter {
  sent: Array<Record<string, any>> = [];
  closedWith: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.emit("close");
  }
  message(body: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(body)));
  }
}

async function start(options: { linked?: boolean } = {}) {
  const started = await startShell(options);
  harness = started.harness;
  const docker = fakeDocker(started.harness, {
    ps: [[/applicationUuid=app-web-uuid/, "web-abc|running||\n"]],
  });
  const exec = docker.exec.getMockImplementation()!;
  docker.exec.mockImplementation(async (target, command, opts) => {
    if (/docker stats /.test(command)) {
      docker.commands.push(command);
      return {
        stdout: `${STATS_LINE}\n`,
        stderr: "",
        code: 0,
        truncated: false,
        timedOut: false,
      };
    }
    return exec(target, command, opts);
  });
  const route = started.harness.mock.wsRoutes.find((r) => r.path === "/stats");
  if (!route?.handler) throw new Error("no /stats socket");
  const handler = route.handler;
  let unlocked = true;
  async function open(userId = OWNER) {
    const socket = new FakeSocket();
    const conn = {
      userId,
      request: {},
      socket,
      clientIp: "127.0.0.1",
      requestOrigin: "https://termix.example.test",
      isDataUnlocked: vi.fn(() => unlocked),
    } satisfies PluginWebSocketConnection;
    await handler(conn);
    return { socket, conn };
  }
  return {
    ...started,
    docker,
    open,
    lock: () => {
      unlocked = false;
    },
    statsRuns: () =>
      docker.commands.filter((c) => /docker stats /.test(c)).length,
  };
}

/** Lets the socket's promises settle without moving the 3 s clock. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

describe("stats socket", () => {
  it("stats parses docker stats json", () => {
    expect(parseDockerStats(STATS_LINE)).toEqual({
      cpu: 12.5,
      memPct: 3.1,
      memBytes: 64 * 1024 * 1024,
      netRx: 1500,
      netTx: 2_000_000,
    });
    expect(parseDockerStats("not json")).toBeNull();
    expect(parseDockerStats('{"CPUPerc":"--"}')).toBeNull();
  });

  it("runs docker stats once, with the name and format quoted", () => {
    expect(statsCommand("web-abc", false)).toBe(
      "docker stats --no-stream --format '{{json .}}' web-abc",
    );
    expect(statsCommand("web-abc", true)).toMatch(/^sudo -n docker stats /);
    expect(() => statsCommand("web;reboot", false)).toThrow();
  });

  it("sends a sample every 3 seconds while open and stops on close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, statsRuns } = await start();
    const { socket } = await open();
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(socket.sent).toEqual([
      {
        type: "stats",
        container: "web-abc",
        cpu: 12.5,
        memPct: 3.1,
        memBytes: 64 * 1024 * 1024,
        netRx: 1500,
        netTx: 2_000_000,
        at: expect.any(Number),
      },
    ]);
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    await settle();
    expect(statsRuns()).toBe(2);
    expect(socket.sent).toHaveLength(2);
    socket.close();
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS * 3);
    await settle();
    expect(statsRuns()).toBe(2);
  });

  it("stats socket re-checks isDataUnlocked every tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, statsRuns, lock } = await start();
    const { socket, conn } = await open();
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(statsRuns()).toBe(1);
    const checks = conn.isDataUnlocked.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    await settle();
    expect(conn.isDataUnlocked.mock.calls.length).toBeGreaterThan(checks);
    expect(statsRuns()).toBe(2);

    lock();
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    await settle();
    expect(statsRuns()).toBe(2);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "error",
      cause: "locked",
    });
    expect(socket.closedWith).toBe(1008);
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS * 3);
    await settle();
    expect(statsRuns()).toBe(2);
  });

  it("re-checks the host's connect access every tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, statsRuns, harness: h } = await start();
    const { socket } = await open();
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(statsRuns()).toBe(1);
    vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    await settle();
    expect(statsRuns()).toBe(1);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "error",
      cause: "no-host-access",
    });
  });

  it("socket refuses another user's connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, docker, harness: h } = await start();
    h.mock.setActor(OTHER);
    const { socket } = await open(OTHER);
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(socket.sent).toEqual([
      { type: "error", error: expect.any(String), cause: "not-found" },
    ]);
    expect(docker.commands).toEqual([]);
  });

  it("refuses a socket whose user isn't the acting user, a locked session and bad messages", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, docker, lock } = await start();
    const other = await open(OTHER);
    other.socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(other.socket.sent.at(-1)).toMatchObject({
      type: "error",
      cause: "forbidden",
    });

    const bad = await open();
    bad.socket.emit("message", Buffer.from("not json"));
    bad.socket.message({ connectionId, uuid: "../etc" });
    await settle();
    expect(bad.socket.sent.map((m) => m.cause)).toEqual([
      "invalid-input",
      "not-found",
    ]);

    lock();
    const locked = await open();
    locked.socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(locked.socket.sent.at(-1)).toMatchObject({ cause: "locked" });
    expect(docker.commands).toEqual([]);
  });

  it("answers not-linked when the server has no Linked host", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, docker } = await start({ linked: false });
    const { socket } = await open();
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "error",
      cause: "not-linked",
    });
    expect(docker.commands).toEqual([]);
  });

  it("a changed target stops the stream and closes the socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, statsRuns, harness: h } = await start();
    const { socket } = await open();
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(statsRuns()).toBe(1);
    h.db.sqlite
      .prepare("UPDATE p_coolify_connections SET base_url = ?")
      .run("https://other.example.test");
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    await settle();
    expect(statsRuns()).toBe(1);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "error",
      cause: "target-changed",
    });
    expect(socket.closedWith).toBe(1008);
  });

  it("re-runs lifecycle's check for the socket's user every tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, statsRuns, harness: h } = await start();
    grant(h, connectionId, OTHER, "operate");
    h.mock.setActor(OTHER);
    const { socket } = await open(OTHER);
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(statsRuns()).toBe(1);
    // Down to view: lifecycle's authorize refuses it.
    h.db.sqlite.prepare("UPDATE p_coolify_grants SET level = 'view'").run();
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    await settle();
    expect(statsRuns()).toBe(1);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "error",
      cause: "forbidden",
    });
    expect(socket.closedWith).toBe(1008);
  });

  it("runs at most 3 streams per person, and a closed one frees its place", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId } = await start();
    const sockets: FakeSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const { socket } = await open();
      socket.message({ connectionId, uuid: "app-web-uuid" });
      await settle();
      sockets.push(socket);
    }
    expect(sockets.slice(0, 3).map((s) => s.sent.at(-1)?.type)).toEqual([
      "stats",
      "stats",
      "stats",
    ]);
    expect(sockets[3].sent.at(-1)).toMatchObject({
      type: "error",
      cause: "too-many-streams",
    });
    sockets[0].close();
    const { socket: again } = await open();
    again.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(again.sent.at(-1)).toMatchObject({ type: "stats" });
  });

  it("takes one subscribe a second on a socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { open, connectionId, statsRuns } = await start();
    const { socket } = await open();
    socket.message({ connectionId, uuid: "app-web-uuid" });
    socket.message({ connectionId, uuid: "app-web-uuid" });
    await settle();
    expect(socket.sent.find((m) => m.type === "error")).toMatchObject({
      cause: "rate-limited",
    });
    expect(statsRuns()).toBe(1);
  });
});
