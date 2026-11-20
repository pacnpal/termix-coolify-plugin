import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changes, startLifecycle } from "./helpers/lifecycle.js";
import { manifest, type PluginHarness } from "./helpers/plugin.js";
import {
  CLIENT_SERVICE,
  type CoolifyClient,
} from "../../src/backend/service.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  vi.restoreAllMocks();
});

async function start(options: Parameters<typeof startLifecycle>[0] = {}) {
  const started = await startLifecycle(options);
  harness = started.harness;
  const run = vi.spyOn(harness.mock.ctx.operations, "run");
  const client =
    await harness.mock.ctx.services.get<CoolifyClient>(CLIENT_SERVICE);
  return { ...started, run, client };
}

describe("coolify.client service", () => {
  it("is declared in the manifest's provides with the view permission", () => {
    expect(manifest.provides).toContainEqual({
      service: CLIENT_SERVICE,
      version: manifest.version,
      permission: "coolify.view",
    });
  });

  it("each method runs one Termix operation as the caller", async () => {
    const { client, run, id } = await start();
    const conn = String(id);
    await client.listConnections();
    await client.listResources(conn);
    await client.deploy(conn, "app-web-uuid", { force: true });
    await client.lifecycle(conn, "app-web-uuid", "restart");
    await client.lifecycle(conn, "app-web-uuid", "stop", { confirmed: true });
    expect(run.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [
        "coolify.list-connections",
        { input: {}, dryRun: false, via: "service" },
      ],
      [
        "coolify.list-resources-all",
        { input: { connectionId: conn }, dryRun: false, via: "service" },
      ],
      [
        "coolify.resource-deploy",
        {
          input: {
            connectionId: conn,
            uuid: "app-web-uuid",
            force: true,
            wait: false,
          },
          dryRun: false,
          via: "service",
        },
      ],
      [
        "coolify.resource-restart",
        {
          input: { connectionId: conn, uuid: "app-web-uuid" },
          dryRun: false,
          via: "service",
        },
      ],
      [
        "coolify.resource-action",
        {
          input: { connectionId: conn, uuid: "app-web-uuid", action: "stop" },
          dryRun: false,
          via: "service",
          confirmed: true,
        },
      ],
    ]);
  });

  it("answers plain data with no token in it", async () => {
    const { client, id } = await start();
    const answer = await client.listConnections();
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    expect(JSON.stringify(answer)).not.toContain("fake-token");
    const listed = await client.listResources(String(id));
    expect(listed.status).toBe("success");
    expect(JSON.stringify(listed)).not.toContain("fake-token");
  });

  it("a caller without the action's permission is refused before any run", async () => {
    const { client, run, fake, id } = await start({
      permissions: ["coolify.view"],
    });
    await expect(
      client.deploy(String(id), "app-web-uuid"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      client.lifecycle(String(id), "app-web-uuid", "stop", { confirmed: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(run).not.toHaveBeenCalled();
    expect(changes(fake)).toEqual([]);
  });

  it("a caller with no Coolify permission at all can't even list", async () => {
    const { client, run } = await start({ permissions: [] });
    await expect(client.listConnections()).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("a destructive call still needs its confirm", async () => {
    const { client, run, fake, id } = await start();
    for (const verb of ["start", "stop"] as const) {
      await expect(
        client.lifecycle(String(id), "app-web-uuid", verb),
      ).rejects.toMatchObject({ code: "confirm-required" });
    }
    expect(run).not.toHaveBeenCalled();
    expect(changes(fake)).toEqual([]);
  });

  it("logs need the caller's confirm, which reaches the action's own check", async () => {
    const { client, run, id } = await start();
    const refused = client.logsTail(String(id), "app-web-uuid", 10);
    await expect(refused).rejects.toBeTruthy();
    expect(run.mock.calls[0][1]?.input).toMatchObject({ confirm: false });
  });

  it("docs/api.md documents every method", async () => {
    const { client } = await start();
    const doc = readFileSync(
      new URL("../../docs/api.md", import.meta.url),
      "utf8",
    );
    for (const name of Object.keys(client)) {
      expect(doc, name).toContain("| `" + name + "(");
    }
  });

  it("refuses a lifecycle verb it doesn't know", async () => {
    const { client, run, id } = await start();
    await expect(
      client.lifecycle(String(id), "app-web-uuid", "delete" as never),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(run).not.toHaveBeenCalled();
  });
});
