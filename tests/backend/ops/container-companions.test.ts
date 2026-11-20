import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationAction } from "@termix-ssh/plugin-sdk/operations";
import { manifest, type PluginHarness } from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import {
  fakeDockerHost,
  HOST_ID,
  startCompanions,
  TOKEN,
  TUNNELS,
  WEB_RUNNING,
} from "../companions/container-fixtures.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function start(options: Parameters<typeof startCompanions>[0] = {}) {
  const started = await startCompanions(options);
  harness = started.harness;
  const runs = withRunHistory(started.harness.mock);
  return { ...started, runs, id: String(started.connectionId) };
}

function declared(id: string): OperationAction {
  return manifest.contributes!.operations!.actions!.find((a) => a.id === id)!;
}

function kinds(id: string): string[] {
  const field = declared(id).inputs!.find((f) => f.key === "kind")!;
  return (field.options ?? []).map((o) => String(o.value));
}

describe("container companion operations", () => {
  it("declares the container kinds on coolify.companion-read and coolify.companion", () => {
    expect(kinds("coolify.companion-read")).toEqual(
      expect.arrayContaining(["companions", "files-paths"]),
    );
    expect(kinds("coolify.companion")).toEqual(
      expect.arrayContaining(["tunnel-open", "tunnel-close", "web-ui"]),
    );
    expect(declared("coolify.companion-read").risk).toBe("read");
    const change = declared("coolify.companion");
    expect(change.risk).toBe("change");
    expect(change.permission).toBe("operate");
    expect(change.surfaces).toMatchObject({ assistant: false, mcp: false });
    // The one-time URL never reaches run history.
    expect(change.outputs?.find((o) => o.key === "url")).toMatchObject({
      sensitive: true,
    });
  });

  it("files-paths answers the same as the paths route", async () => {
    const { runs, id, harness: h, connectionId } = await start();
    const route = await h.request(
      "GET",
      `/connections/${connectionId}/resources/app-web-uuid/paths`,
    );
    const outcome = await runs.run("coolify.companion-read", {
      connectionId: id,
      kind: "files-paths",
      params: JSON.stringify({ uuid: "app-web-uuid" }),
    });
    expect(outcome.data).toEqual(route.body);
  });

  it("tunnel-open and tunnel-close forward and close by name", async () => {
    const { runs, id, harness: h, calls } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    const opened = await runs.run("coolify.companion", {
      connectionId: id,
      kind: "tunnel-open",
      params: JSON.stringify({ uuid: "app-web-uuid", port: 3000 }),
    });
    expect(opened.data).toMatchObject({
      name: `web:${HOST_ID}:coolify-app-web-uuid`,
      bindHost: "127.0.0.1",
      bindPort: 41234,
    });
    const closed = await runs.run("coolify.companion", {
      connectionId: id,
      kind: "tunnel-close",
      params: JSON.stringify({ uuid: "app-web-uuid", port: 3000 }),
    });
    expect(closed.data).toEqual({
      name: `web:${HOST_ID}:coolify-app-web-uuid`,
      closed: true,
    });
    expect(calls.stop).toEqual([[`web:${HOST_ID}:coolify-app-web-uuid`]]);
  });

  it("tunnel-open cancelled during the last revision check opens no forward", async () => {
    const { id, harness: h, calls } = await start();
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    const abort = new AbortController();
    // Armed once docker inspect answered: the next actor read is the access
    // check inside connections.revision(), awaited right before the forward.
    let armed = false;
    const answer = docker.exec.getMockImplementation()!;
    docker.exec.mockImplementation(async (...args) => {
      const out = await answer(...args);
      if (/docker inspect /.test(args[1])) armed = true;
      return out;
    });
    const actor = h.mock.ctx.currentActor.bind(h.mock.ctx);
    vi.spyOn(h.mock.ctx, "currentActor").mockImplementation(() => {
      if (armed) {
        armed = false;
        abort.abort(new Error("cancelled"));
      }
      return actor();
    });
    const handler = h.mock.operationHandlers.get("coolify.companion")!;
    await expect(
      Promise.resolve(
        handler.run(
          {
            connectionId: id,
            kind: "tunnel-open",
            params: JSON.stringify({ uuid: "app-web-uuid", port: 3000 }),
          },
          { runId: "r1", dryRun: false, signal: abort.signal, log: () => {} },
        ),
      ),
    ).rejects.toThrow("cancelled");
    expect(abort.signal.aborted).toBe(true);
    expect(calls.forward).toEqual([]);
    expect(calls.live.size).toBe(0);
  });

  it("web-ui keeps the one-time URL out of the summary and run history", async () => {
    const { runs, id, harness: h } = await start();
    fakeDockerHost(h, { ps: [WEB_RUNNING] });
    const outcome = await runs.run("coolify.companion", {
      connectionId: id,
      kind: "web-ui",
      params: JSON.stringify({ uuid: "app-web-uuid", port: 80 }),
    });
    expect(outcome.data).toMatchObject({
      url: expect.stringContaining("fake-one-time"),
    });
    expect(outcome.summary).not.toContain("fake-one-time");
    expect(JSON.stringify(runs.history)).not.toContain("fake-one-time");
    expect(JSON.stringify(runs.history)).not.toContain(TOKEN);
  });

  it("refuses a bad port and a missing companion, without SSH", async () => {
    const { runs, id, harness: h } = await start({ running: [] });
    const docker = fakeDockerHost(h, { ps: [WEB_RUNNING] });
    await expect(
      runs.run("coolify.companion", {
        connectionId: id,
        kind: "tunnel-open",
        params: JSON.stringify({ uuid: "app-web-uuid", port: 70000 }),
      }),
    ).rejects.toThrow(/port/i);
    await expect(
      runs.run("coolify.companion", {
        connectionId: id,
        kind: "tunnel-open",
        params: JSON.stringify({ uuid: "app-web-uuid", port: 3000 }),
      }),
    ).rejects.toThrow(new RegExp(TUNNELS));
    expect(docker.commands).toEqual([]);
  });

  it("files-paths needs coolify.view", async () => {
    const { runs, id } = await start({ permissions: ["coolify.configure"] });
    await expect(
      runs.run("coolify.companion-read", {
        connectionId: id,
        kind: "files-paths",
        params: JSON.stringify({ uuid: "app-web-uuid" }),
      }),
    ).rejects.toThrow(/view/i);
  });
});
