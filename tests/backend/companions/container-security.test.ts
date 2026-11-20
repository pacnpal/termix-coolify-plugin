import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import { isContainerIp } from "../../../src/backend/companions/container-adapters.js";
import { changeTarget, grant } from "./fixtures.js";
import {
  fakeDockerHost,
  startCompanions,
  TOKEN,
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

const ONE_TIME = "fake-one-time";

describe("container companions: addresses", () => {
  it("only a private container address reaches Tunnels or Reverse Proxy", async () => {
    for (const ips of [
      "169.254.169.254 \n",
      "127.0.0.1 \n",
      "0.0.0.0 \n",
      "203.0.113.9 \n",
      "::1 \n",
      "fe80::1 \n",
    ]) {
      const { harness: h, connectionId, calls } = await start();
      fakeDockerHost(h, { ps: [WEB_RUNNING], ips });
      const tunnel = await h.request(
        "POST",
        `${base(connectionId, "app-web-uuid")}/tunnel`,
        { port: 3000 },
      );
      expect(tunnel.status, ips).toBe(502);
      expect(tunnel.body.cause, ips).toBe("bad-container-ip");
      const web = await h.request(
        "POST",
        `${base(connectionId, "app-web-uuid")}/web-ui`,
        { port: 80 },
      );
      expect(web.body.cause, ips).toBe("bad-container-ip");
      expect(calls.forward).toEqual([]);
      expect(calls.open).toEqual([]);
      await h.close();
      harness = null;
    }
  });

  it("skips a link-local address for the container's private one", async () => {
    const { harness: h, connectionId, calls } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING], ips: "169.254.1.2 172.18.0.4 \n" });
    const res = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/tunnel`,
      { port: 3000 },
    );
    expect(res.status).toBe(200);
    expect((calls.forward[0]![1] as { targetHost: string }).targetHost).toBe(
      "172.18.0.4",
    );
  });

  it("isContainerIp accepts Docker's private ranges only", () => {
    for (const ok of [
      "10.0.0.2",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.2",
      "fd00::2",
    ]) {
      expect(isContainerIp(ok), ok).toBe(true);
    }
    for (const bad of [
      "172.32.0.1",
      "8.8.8.8",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "2001:db8::1",
    ]) {
      expect(isContainerIp(bad), bad).toBe(false);
    }
  });
});

describe("container companions: tunnels", () => {
  it("closes only a forward this actor opened here, on that port", async () => {
    const { harness: h, connectionId, calls } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    // Nothing opened yet: a name we never made is never stopped.
    const none = await h.request(
      "DELETE",
      `${base(connectionId, "app-web-uuid")}/tunnel/3000`,
    );
    expect(none.status).toBe(404);
    expect(none.body.cause).toBe("tunnel-not-found");
    expect(calls.stop).toEqual([]);

    await h.request("POST", `${base(connectionId, "app-web-uuid")}/tunnel`, {
      port: 3000,
    });
    const wrongPort = await h.request(
      "DELETE",
      `${base(connectionId, "app-web-uuid")}/tunnel/4000`,
    );
    expect(wrongPort.body.cause).toBe("tunnel-not-found");

    // Another person with operate access can't stop it either.
    grant(h, connectionId, OTHER, "operate");
    const other = await h.request(
      "DELETE",
      `${base(connectionId, "app-web-uuid")}/tunnel/3000`,
      undefined,
      OTHER,
    );
    expect(other.status).toBe(404);
    expect(calls.stop).toEqual([]);

    const mine = await h.request(
      "DELETE",
      `${base(connectionId, "app-web-uuid")}/tunnel/3000`,
    );
    expect(mine.status).toBe(200);
    expect(calls.stop).toHaveLength(1);
  });

  it("refuses to take over another person's forward", async () => {
    const { harness: h, connectionId, calls } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    grant(h, connectionId, OTHER, "operate");
    await h.request("POST", `${base(connectionId, "app-web-uuid")}/tunnel`, {
      port: 3000,
    });
    const other = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/tunnel`,
      { port: 3000 },
      OTHER,
    );
    expect(other.status).toBe(409);
    expect(other.body.cause).toBe("tunnel-in-use");
    expect(calls.forward).toHaveLength(1);
  });

  it("caps the forwards one actor has open", async () => {
    const { harness: h, connectionId, calls } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    // Each Linked host's forward of the resource has its own name.
    for (let n = 0; n < 5; n++) {
      vi.spyOn(h.mock.ctx.hosts, "checkAccess").mockResolvedValue({
        hasAccess: true,
        isOwner: true,
        isShared: false,
      });
      h.db.sqlite
        .prepare(
          "UPDATE p_coolify_servers SET host_id = ? WHERE connection_id = ?",
        )
        .run(100 + n, connectionId);
      const res = await h.request(
        "POST",
        `${base(connectionId, "app-web-uuid")}/tunnel`,
        { port: 3000 },
      );
      expect(res.status, String(n)).toBe(200);
    }
    h.db.sqlite
      .prepare(
        "UPDATE p_coolify_servers SET host_id = ? WHERE connection_id = ?",
      )
      .run(200, connectionId);
    const sixth = await h.request(
      "POST",
      `${base(connectionId, "app-web-uuid")}/tunnel`,
      { port: 3000 },
    );
    expect(sixth.status).toBe(429);
    expect(sixth.body.cause).toBe("too-many-tunnels");
    expect(calls.forward).toHaveLength(5);
  });
});

describe("container companions: a changed target", () => {
  it("re-checks the revision after docker inspect and opens nothing", async () => {
    for (const path of ["tunnel", "web-ui"]) {
      const { harness: h, connectionId, calls } = await start();
      const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
      const inner = docker.exec.getMockImplementation()!;
      docker.exec.mockImplementation(async (target, command, ...rest) => {
        const out = await inner(target, command, ...rest);
        if (/docker inspect /.test(command))
          await changeTarget(h, connectionId);
        return out;
      });
      const res = await h.request(
        "POST",
        `${base(connectionId, "app-web-uuid")}/${path}`,
        { port: 3000 },
      );
      expect(res.status, path).toBe(409);
      expect(res.body.cause, path).toBe("target-changed");
      expect(calls.forward).toEqual([]);
      expect(calls.open).toEqual([]);
      await h.close();
      harness = null;
    }
  });
});

describe("container companions: files", () => {
  it("keeps file storages inside the data folder and normalizes volume paths", async () => {
    const { harness: h, connectionId, fake } = await start();
    fake.set("GET /applications/app-web-uuid/storages", {
      json: {
        persistent_storages: [
          { id: 1, name: "v1", mount_path: "/a", host_path: "/srv//data/./x/" },
          { id: 2, name: "v2", mount_path: "/b", host_path: "/srv/../etc" },
          { id: 3, name: "v3", mount_path: "/c", host_path: "/" },
        ],
        file_storages: [
          { id: 4, fs_path: "/etc/shadow", mount_path: "/d" },
          {
            id: 5,
            fs_path: "/data/coolify/applications/app-web-uuid/../other/x",
            mount_path: "/e",
          },
          {
            id: 6,
            fs_path: "/data/coolify/applications/app-web-uuid/conf/app.yml",
            mount_path: "/f",
          },
        ],
      },
    });
    const res = await h.request(
      "GET",
      `${base(connectionId, "app-web-uuid")}/paths`,
    );
    expect(res.status).toBe(200);
    expect(res.body.volumes).toEqual([
      "/srv/data/x",
      "/var/lib/docker/volumes/v2/_data",
      "/var/lib/docker/volumes/v3/_data",
      "/data/coolify/applications/app-web-uuid/conf/app.yml",
    ]);
  });

  it("fails closed with companions-unknown when the plugin list can't be read", async () => {
    const { harness: h, connectionId, calls } = await start();
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    vi.spyOn(h.mock.ctx.plugins, "list").mockRejectedValue(new Error("down"));
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
      expect(res.status, path).toBe(409);
      expect(res.body.cause, path).toBe("companions-unknown");
    }
    expect(docker.commands).toEqual([]);
    expect(calls.forward).toEqual([]);
    expect(calls.open).toEqual([]);
  });
});

type Run = (
  actionId: string,
  options?: PluginOperationInvokeOptions,
) => Promise<PluginOperationOutcome>;

function withRun(ctx: PluginContext, run: Run): PluginContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "operations") return { ...target.operations, run };
      return Reflect.get(target, prop);
    },
  });
}

async function mcpCall(
  h: PluginHarness,
  ctx: PluginContext,
  args: Record<string, unknown>,
) {
  h.mock.setActor(OWNER);
  const answer = await handleMcp(ctx, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "coolify__companion", arguments: args },
  });
  return answer?.result as {
    isError: boolean;
    content: { text: string }[];
  };
}

describe("container companions over MCP", () => {
  it("tunnel-open and web-ui need Allow changes and confirmed", async () => {
    for (const allow of [false, true]) {
      const {
        harness: h,
        connectionId,
        calls,
      } = await start({
        settings: { allowMcpChanges: allow },
      });
      fakeDockerHost(h, { ps: [WEB_RUNNING] });
      const runs = withRunHistory(h.mock);
      const ctx = withRun(h.mock.ctx, (id, options) =>
        runs.run(id, options?.input ?? {}),
      );
      for (const kind of ["tunnel-open", "web-ui"]) {
        const result = await mcpCall(h, ctx, {
          connectionId: String(connectionId),
          kind,
          params: { uuid: "app-web-uuid", port: 3000 },
        });
        expect(result.isError, `${kind} allow=${allow}`).toBe(true);
        expect(result.content[0]!.text).toMatch(
          allow ? /confirm-required/ : /mcp-changes-off/,
        );
      }
      expect(calls.forward).toEqual([]);
      expect(calls.open).toEqual([]);
      await h.close();
      harness = null;
    }
  });

  it("web-ui hands the one-time URL over once, never into run history", async () => {
    const { harness: h, connectionId } = await start({
      settings: { allowMcpChanges: true },
    });
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    const runs = withRunHistory(h.mock);
    const ctx = withRun(h.mock.ctx, (id, options) =>
      runs.run(id, options?.input ?? {}),
    );
    const result = await mcpCall(h, ctx, {
      connectionId: String(connectionId),
      kind: "web-ui",
      params: { uuid: "app-web-uuid", port: 80 },
      confirmed: true,
    });
    expect(result.isError).toBe(false);
    const shown = result.content.map((c) => c.text).join("\n");
    expect(shown).toContain(ONE_TIME);
    const history = JSON.stringify(runs.history);
    expect(history).not.toContain(ONE_TIME);
    expect(history).not.toContain(TOKEN);
  });
});
