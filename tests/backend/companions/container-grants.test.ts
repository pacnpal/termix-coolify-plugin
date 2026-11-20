import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER, type PluginHarness } from "../helpers/plugin.js";
import { isContainerIp } from "../../../src/backend/companions/container-adapters.js";
import { grant } from "./fixtures.js";
import {
  fakeDockerHost,
  fakeServices,
  startCompanions,
  WEB_RUNNING,
} from "./container-fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

const base = (id: number) => `/connections/${id}/resources/app-web-uuid`;

describe("a grant lowered while SSH runs", () => {
  it.each(["tunnel", "web-ui"])(
    "%s opens nothing once the actor's grant drops below operate",
    async (path) => {
      const started = await startCompanions();
      harness = started.harness;
      const { harness: h, connectionId, calls } = started;
      grant(h, connectionId, OTHER, "operate");
      vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isShared: true,
      });
      const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
      const inner = docker.exec.getMockImplementation()!;
      docker.exec.mockImplementation(async (target, command, ...rest) => {
        const out = await inner(target, command, ...rest);
        if (/docker inspect /.test(command)) {
          h.db.sqlite
            .prepare(
              "UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?",
            )
            .run(OTHER);
        }
        return out;
      });
      const res = await h.request(
        "POST",
        `${base(connectionId)}/${path}`,
        { port: 3000 },
        OTHER,
      );
      expect(res.status).toBe(403);
      expect(calls.forward).toEqual([]);
      expect(calls.open).toEqual([]);
    },
  );
});

describe("unique local IPv6 addresses", () => {
  it("is exactly fc00::/7", () => {
    for (const ok of ["fc00::1", "fdff::1", "fd00::2", "fc12:3456::1"]) {
      expect(isContainerIp(ok), ok).toBe(true);
    }
    for (const bad of ["fbff::1", "fe00::1", "fc::2", "fd::1", "::fc00:1"]) {
      expect(isContainerIp(bad), bad).toBe(false);
    }
  });
});

describe("a forward Tunnels may hold after a bad answer", () => {
  it("stays counted and closable until stop succeeds", async () => {
    const fakes = fakeServices();
    const tunnels = fakes.services["tunnels.access"];
    let stopFails = true;
    const services = {
      ...fakes.services,
      "tunnels.access": {
        async forward(...args: unknown[]) {
          await tunnels.forward(...args);
          return { bindHost: "127.0.0.1", bindPort: "not-a-port" };
        },
        async stop(...args: unknown[]) {
          if (stopFails) throw new Error("tunnels down");
          return tunnels.stop(...args);
        },
      },
    };
    const started = await startCompanions({ services });
    harness = started.harness;
    const { harness: h, connectionId } = started;
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    const opened = await h.request("POST", `${base(connectionId)}/tunnel`, {
      port: 3000,
    });
    expect(opened.status).toBe(502);
    expect(fakes.calls.live.size).toBe(1);
    // Its record is kept, so it can still be stopped from here.
    stopFails = false;
    const closed = await h.request(
      "DELETE",
      `${base(connectionId)}/tunnel/3000`,
    );
    expect(closed.status).toBe(200);
    expect(fakes.calls.live.size).toBe(0);
  });
});
