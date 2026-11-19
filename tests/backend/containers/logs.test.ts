import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import { fakeDocker, HOST_ID, setSensitive, startShell } from "./fixtures.js";

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

const logsPath = (id: number, uuid: string, query = "") =>
  `/connections/${id}/resources/${uuid}/logs${query}`;

const WEB_RUNNING: [RegExp, string] = [
  /applicationUuid=app-web-uuid/,
  "web-abc|running||\n",
];

function logCalls(fake: { calls: { path: string; url: string }[] }) {
  return fake.calls.filter((c) => c.path.endsWith("/logs"));
}

describe("logs snapshot route", () => {
  it("with read:sensitive logs come from Coolify labelled coolify", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", {
      json: { logs: "one\ntwo\n" },
    });
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ source: "coolify", text: "one\ntwo\n" });
    const [call] = logCalls(fake).slice(-1);
    expect(new URL(call.url).searchParams.get("lines")).toBe("100");
    expect(docker.commands).toEqual([]);
  });

  it("without read:sensitive logs come over SSH labelled ssh", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const before = logCalls(fake).length;
    const docker = fakeDocker(h, {
      ps: [WEB_RUNNING],
      logs: "from docker\n",
    });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: "ssh",
      text: "from docker\n",
      container: "web-abc",
    });
    expect(docker.commands).toContain(
      "docker logs --tail '100' 'web-abc' 2>&1",
    );
    expect(docker.exec.mock.calls.every(([host]) => host === HOST_ID)).toBe(
      true,
    );
    expect(logCalls(fake).length).toBe(before);
  });

  it("a view grant reads logs over SSH, never through Coolify", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    h.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
      )
      .run(connectionId, OTHER, "view");
    const before = logCalls(fake).length;
    fakeDocker(h, { ps: [WEB_RUNNING], logs: "x\n" });
    const res = await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid"),
      undefined,
      OTHER,
    );
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("ssh");
    expect(logCalls(fake).length).toBe(before);
  });

  it("falls back to SSH when Coolify refuses the token's ability", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    fake.set("GET /applications/app-web-uuid/logs", {
      status: 403,
      json: { message: "Missing ability." },
    });
    fakeDocker(h, { ps: [WEB_RUNNING], logs: "fallback\n" });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "ssh", text: "fallback\n" });
  });

  it("lines are capped at 10000", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    const many = Array.from({ length: 10_005 }, (_, i) => `l${i}`).join("\n");
    fake.set("GET /applications/app-web-uuid/logs", { json: { logs: many } });
    const viaCoolify = await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=50000"),
    );
    expect(viaCoolify.status).toBe(200);
    const [call] = logCalls(fake).slice(-1);
    expect(new URL(call.url).searchParams.get("lines")).toBe("10000");
    const coolifyLines = viaCoolify.body.text.split("\n");
    expect(coolifyLines).toHaveLength(10_000);
    expect(coolifyLines.at(-1)).toBe("l10004");

    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING], logs: many });
    const viaSsh = await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=50000"),
    );
    expect(viaSsh.status).toBe(200);
    expect(docker.commands).toContain(
      "docker logs --tail '10000' 'web-abc' 2>&1",
    );
    expect(viaSsh.body.text.split("\n")).toHaveLength(10_000);
  });

  it("asks for timestamps from Coolify and from docker", async () => {
    const { harness: h, fake, connectionId } = await start();
    setSensitive(h, connectionId, true);
    await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=5&timestamps=true"),
    );
    const [call] = logCalls(fake).slice(-1);
    const query = new URL(call.url).searchParams;
    expect(query.get("lines")).toBe("5");
    expect(query.get("show_timestamps")).toBe("true");

    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid", "?lines=5&timestamps=true"),
    );
    expect(docker.commands).toContain(
      "docker logs --tail '5' --timestamps 'web-abc' 2>&1",
    );
  });

  it("refuses a line count or flag that isn't one", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    for (const query of ["?lines=abc", "?lines=0", "?timestamps=maybe"]) {
      const res = await h.request(
        "GET",
        logsPath(connectionId, "app-web-uuid", query),
      );
      expect(res.status, query).toBe(400);
      expect(res.body.cause).toBe("invalid-input");
    }
    expect(docker.commands).toEqual([]);
  });

  it("no linked host answers not-linked for SSH logs", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    // app-api-uuid runs on srv-edge-uuid, which has no Linked host.
    const res = await h.request("GET", logsPath(connectionId, "app-api-uuid"));
    expect(res.status).toBe(409);
    expect(res.body.cause).toBe("not-linked");
    expect(res.body.error).toMatch(/Link this server first/);
    expect(docker.commands).toEqual([]);
  });

  it("SSH logs need the actor's own connect access to the Linked host", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const access = vi
      .spyOn(h.mock.ctx.hosts, "checkAccess")
      .mockResolvedValue({ hasAccess: false, isOwner: false, isShared: false });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(403);
    expect(res.body.cause).toBe("no-host-access");
    expect(access).toHaveBeenCalledWith(HOST_ID, "connect");
    expect(docker.commands).toEqual([]);
  });

  it("several containers answer choices, and a chosen one is read", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, {
      ps: [
        [
          /serviceUuid=svc-n8n-uuid/,
          "n8n-a|running|part-n8n-uuid|n8n\npg-a|exited|part-postgres-uuid|postgresql\n",
        ],
      ],
      logs: "pg says hi\n",
    });
    const several = await h.request(
      "GET",
      logsPath(connectionId, "svc-n8n-uuid"),
    );
    expect(several.status).toBe(300);
    expect(several.body.choices.map((c: { name: string }) => c.name)).toEqual([
      "n8n-a",
      "pg-a",
    ]);
    // A stopped container still has logs.
    const chosen = await h.request(
      "GET",
      logsPath(connectionId, "svc-n8n-uuid", "?container=pg-a"),
    );
    expect(chosen.status).toBe(200);
    expect(chosen.body).toEqual({
      source: "ssh",
      text: "pg says hi\n",
      container: "pg-a",
    });
    expect(docker.commands).toContain("docker logs --tail '100' 'pg-a' 2>&1");
  });

  it("a container name with ; or $( is refused before any SSH", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    for (const container of ["web-abc;id", "web$(id)", "-f"]) {
      const res = await h.request(
        "GET",
        logsPath(
          connectionId,
          "app-web-uuid",
          `?container=${encodeURIComponent(container)}`,
        ),
      );
      expect(res.status).toBe(400);
    }
    expect(docker.commands).toEqual([]);
  });

  it("uses sudo -n for a user outside the docker group", async () => {
    const { harness: h, connectionId } = await start();
    setSensitive(h, connectionId, false);
    const docker = fakeDocker(h, {
      uid: 1000,
      groups: "deploy",
      ps: [WEB_RUNNING],
    });
    await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(docker.commands).toContain(
      "sudo -n docker logs --tail '100' 'web-abc' 2>&1",
    );
  });

  it("another user's connection is a 404 and reads nothing", async () => {
    const { harness: h, fake, connectionId } = await start();
    const before = logCalls(fake).length;
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request(
      "GET",
      logsPath(connectionId, "app-web-uuid"),
      undefined,
      OTHER,
    );
    expect(res.status).toBe(404);
    expect(docker.commands).toEqual([]);
    expect(logCalls(fake).length).toBe(before);
  });

  it("without coolify.operate 403", async () => {
    const { harness: h, connectionId } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const res = await h.request("GET", logsPath(connectionId, "app-web-uuid"));
    expect(res.status).toBe(403);
    expect(docker.commands).toEqual([]);
  });
});

/** Stands in for an ssh2 exec channel. */
class FakeStream extends EventEmitter {
  stderr = new EventEmitter();
  signals: string[] = [];
  closed = false;
  signal(name: string) {
    this.signals.push(name);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

/** ctx.ssh.connect answering a client whose exec opens FakeStreams. */
function fakeFollowSsh(h: PluginHarness) {
  const execs: { command: string; options: unknown; stream: FakeStream }[] = [];
  const dispose = vi.fn();
  const client = {
    exec(
      command: string,
      options: unknown,
      callback: (err: Error | undefined, stream: FakeStream) => void,
    ) {
      const stream = new FakeStream();
      execs.push({ command, options, stream });
      callback(undefined, stream);
      return true;
    },
  };
  const connect = vi.spyOn(h.mock.ctx.ssh, "connect").mockResolvedValue({
    client,
    jumpClient: null,
    host: { id: HOST_ID, ip: "203.0.113.5", port: 22, username: "deploy" },
    dispose,
  } as never);
  return { execs, dispose, connect };
}

/** Stands in for the ws socket core hands a socket route. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = code ?? 1000;
    this.emit("close");
  }
  message(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

function openFollow(h: PluginHarness, user = OWNER) {
  const route = h.mock.wsRoutes.find((r) => r.path === "/logs");
  if (!route?.handler) throw new Error("no /logs socket route");
  const socket = new FakeSocket();
  const state = { unlocked: true };
  // Core runs a socket's events as the user who opened it.
  h.mock.setActor(user);
  void route.handler({
    userId: user,
    request: {},
    socket,
    clientIp: "198.51.100.2",
    requestOrigin: "https://termix.test",
    isDataUnlocked: () => state.unlocked,
  });
  return { socket, state };
}

function sentOf(socket: FakeSocket, type: string) {
  return socket.sent.filter((m) => m.type === type);
}

describe("logs follow socket", () => {
  async function following() {
    const started = await start();
    setSensitive(started.harness, started.connectionId, true);
    fakeDocker(started.harness, { ps: [WEB_RUNNING] });
    const ssh = fakeFollowSsh(started.harness);
    const { socket, state } = openFollow(started.harness);
    socket.message({
      type: "subscribe",
      connectionId: started.connectionId,
      uuid: "app-web-uuid",
    });
    await vi.waitFor(() => expect(sentOf(socket, "started")).toHaveLength(1));
    return { ...started, ssh, socket, state };
  }

  it("streams new lines of docker logs -f over SSH, labelled ssh", async () => {
    const { ssh, socket } = await following();
    expect(sentOf(socket, "started")[0]).toEqual({
      type: "started",
      source: "ssh",
      container: "web-abc",
    });
    expect(ssh.connect).toHaveBeenCalledWith(HOST_ID, expect.anything());
    expect(ssh.execs).toHaveLength(1);
    expect(ssh.execs[0].command).toBe(
      "docker logs -f --tail '0' 'web-abc' 2>&1",
    );
    ssh.execs[0].stream.emit("data", Buffer.from("one\r\ntwo\nthr"));
    ssh.execs[0].stream.emit("data", Buffer.from("ee\n"));
    await vi.waitFor(() =>
      expect(
        sentOf(socket, "lines").flatMap((m) => m.lines as string[]),
      ).toEqual(["one", "two", "three"]),
    );
  });

  it("stops and kills the SSH process when the socket closes", async () => {
    const { ssh, socket } = await following();
    socket.close();
    const stream = ssh.execs[0].stream;
    expect(stream.signals).toContain("KILL");
    expect(stream.closed).toBe(true);
    expect(ssh.dispose).toHaveBeenCalled();
  });

  it("stops on unsubscribe and keeps the socket open", async () => {
    const { ssh, socket } = await following();
    socket.message({ type: "unsubscribe" });
    await vi.waitFor(() => expect(sentOf(socket, "stopped")).toHaveLength(1));
    expect(ssh.execs[0].stream.signals).toContain("KILL");
    expect(ssh.dispose).toHaveBeenCalled();
    expect(socket.closedWith).toBeNull();
  });

  it("follow socket checks isDataUnlocked on every message", async () => {
    const { ssh, socket, state, connectionId } = await following();
    state.unlocked = false;
    socket.message({ type: "ping" });
    await vi.waitFor(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({ cause: "locked" });
    expect(ssh.execs[0].stream.signals).toContain("KILL");
    expect(ssh.dispose).toHaveBeenCalled();

    // A locked session never starts one.
    const second = openFollow(harness!);
    second.state.unlocked = false;
    const before = ssh.connect.mock.calls.length;
    second.socket.message({
      type: "subscribe",
      connectionId,
      uuid: "app-web-uuid",
    });
    await vi.waitFor(() => expect(second.socket.closedWith).toBe(1008));
    expect(ssh.connect.mock.calls.length).toBe(before);
  });

  it("checks access again on every message and stops when it is gone", async () => {
    const { ssh, socket, harness: h } = await following();
    vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    socket.message({ type: "ping" });
    await vi.waitFor(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "no-host-access",
    });
    expect(ssh.dispose).toHaveBeenCalled();
  });

  it("follow socket refuses another user's connection", async () => {
    const { harness: h, connectionId } = await start();
    const docker = fakeDocker(h, { ps: [WEB_RUNNING] });
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h, OTHER);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await vi.waitFor(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "not-found",
    });
    expect(ssh.connect).not.toHaveBeenCalled();
    expect(docker.commands).toEqual([]);
  });

  it("refuses a message that doesn't run as the socket's own user", async () => {
    const { harness: h, connectionId } = await start();
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h, OTHER);
    h.mock.setActor(OWNER);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await vi.waitFor(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "forbidden",
    });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it("refuses a user without coolify.operate before any SSH", async () => {
    const { harness: h, connectionId } = await start({
      permissions: ["coolify.view", "coolify.configure"],
    });
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h);
    socket.message({ type: "subscribe", connectionId, uuid: "app-web-uuid" });
    await vi.waitFor(() => expect(socket.closedWith).toBe(1008));
    expect(sentOf(socket, "error").at(-1)).toMatchObject({
      cause: "forbidden",
    });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it("no linked host answers not-linked on the socket", async () => {
    const { harness: h, connectionId } = await start();
    const ssh = fakeFollowSsh(h);
    const { socket } = openFollow(h);
    socket.message({ type: "subscribe", connectionId, uuid: "app-api-uuid" });
    await vi.waitFor(() => expect(sentOf(socket, "error")).toHaveLength(1));
    expect(sentOf(socket, "error")[0]).toMatchObject({ cause: "not-linked" });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it("ends when docker logs ends on its own", async () => {
    const { ssh, socket } = await following();
    ssh.execs[0].stream.emit("data", Buffer.from("last words"));
    ssh.execs[0].stream.close();
    await vi.waitFor(() => expect(sentOf(socket, "ended")).toHaveLength(1));
    expect(sentOf(socket, "lines").flatMap((m) => m.lines as string[])).toEqual(
      ["last words"],
    );
    expect(ssh.dispose).toHaveBeenCalled();
  });
});
