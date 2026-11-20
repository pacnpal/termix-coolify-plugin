import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import { grant } from "./fixtures.js";
import { fakeDockerHost, startCompanions } from "./container-fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const base = (id: number, uuid: string) =>
  `/connections/${id}/resources/${uuid}`;

const SEVEN = Array.from({ length: 7 }, (_, n) => `app-c${n}-uuid`);

/** Seven applications on srv-vps1-uuid, one running container each. */
async function startSeven() {
  const started = await startCompanions();
  harness = started.harness;
  started.fake.set("GET /applications", {
    json: SEVEN.map((uuid, n) => ({
      id: 100 + n,
      uuid,
      name: `c${n}`,
      status: "running",
      destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
    })),
  });
  const docker = fakeDockerHost(started.harness, {
    ps: SEVEN.map((uuid, n): [RegExp, string] => [
      new RegExp(`applicationUuid=${uuid}`),
      `c${n}|running||\n`,
    ]),
  });
  // docker inspect waits a moment, so every open is past its checks at once.
  const inner = docker.exec.getMockImplementation()!;
  docker.exec.mockImplementation(async (target, command, ...rest) => {
    if (/docker inspect /.test(command)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return inner(target, command, ...rest);
  });
  return { ...started, docker, inner };
}

const open = (h: PluginHarness, id: number, uuid: string, user = OWNER) =>
  h.request("POST", `${base(id, uuid)}/tunnel`, { port: 3000 }, user);

describe("container companions: concurrent opens", () => {
  it("seven concurrent opens for one actor open exactly five", async () => {
    const { harness: h, connectionId, calls } = await startSeven();
    const answers = await Promise.all(
      SEVEN.map((uuid) => open(h, connectionId, uuid)),
    );
    const opened = SEVEN.filter((_, i) => answers[i]!.status === 200);
    const refused = answers.filter((a) => a.body.cause === "too-many-tunnels");
    expect(opened).toHaveLength(5);
    expect(refused).toHaveLength(2);
    expect(calls.forward).toHaveLength(5);
    expect(calls.stop).toEqual([]);
    // A refused open held no slot: after one stop, one more opens.
    await h.request("DELETE", `${base(connectionId, opened[0]!)}/tunnel/3000`);
    const late = SEVEN.find((u) => !opened.includes(u))!;
    expect((await open(h, connectionId, late)).status).toBe(200);
  });

  it("a failed open gives its slot back", async () => {
    const {
      harness: h,
      connectionId,
      calls,
      docker,
      inner,
    } = await startSeven();
    docker.exec.mockImplementation(async (target, command, ...rest) =>
      /docker inspect /.test(command)
        ? { stdout: "", stderr: "", code: 1, truncated: false, timedOut: false }
        : inner(target, command, ...rest),
    );
    for (const uuid of SEVEN) {
      expect((await open(h, connectionId, uuid)).body.cause, uuid).toBe(
        "ssh-failed",
      );
    }
    docker.exec.mockImplementation(inner);
    expect((await open(h, connectionId, SEVEN[0]!)).status).toBe(200);
    expect(calls.forward).toHaveLength(1);
  });

  it("two concurrent opens of one resource run one after the other", async () => {
    const { harness: h, connectionId, calls } = await startSeven();
    grant(h, connectionId, OTHER, "operate");
    // The same person: the second reopens it, so one forward is left open.
    const same = await Promise.all(
      [OWNER, OWNER].map((user) => open(h, connectionId, SEVEN[0]!, user)),
    );
    expect(same.map((a) => a.status)).toEqual([200, 200]);
    // Two people: the second finds it in use.
    const two = await Promise.all(
      [OWNER, OTHER].map((user) => open(h, connectionId, SEVEN[1]!, user)),
    );
    expect(two.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(two.find((a) => a.status === 409)!.body.cause).toBe("tunnel-in-use");
    expect([...calls.live.keys()].sort()).toEqual(
      [SEVEN[0]!, SEVEN[1]!].map((u) => `web:7:coolify-${u}`).sort(),
    );
  });
});
