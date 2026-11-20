import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import express, { type Router } from "express";
import { createMockCtx, createTestDb } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import authz from "../../authz.json";
import { activate } from "../../src/backend/index.js";
import { healthyCoolify } from "./helpers/fake-coolify.js";
import { OWNER, startPlugin } from "./helpers/plugin.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

describe("authz.json", () => {
  it("has an entry for every route and no entry for a route that is gone", async () => {
    const db = await createTestDb(pluginDir);
    let router: Router | null = null;
    const mock = createMockCtx({
      pluginId: manifest.id,
      manifest,
      sandbox: true,
      capabilities: manifest.capabilities,
      db: db.database,
      router: () => (router = express.Router()),
    });
    await activate(mock.ctx);
    const served = (router!.stack as unknown as Layer[])
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route!.methods).map(
          (method) =>
            `${method.toUpperCase()} /plugin-api/${manifest.id}${layer.route!.path}`,
        ),
      )
      .sort();
    expect(served).toEqual(Object.keys(authz.routes).sort());
    db.close();
  });

  it("each route needs exactly the permissions it declares", async () => {
    const prefix = `/plugin-api/${manifest.id}`;
    for (const [key, entry] of Object.entries(authz.routes) as [
      string,
      { permission?: string | string[]; body?: unknown },
    ][]) {
      const [method, fullPath] = key.split(" ");
      const declared = ([] as string[]).concat(entry.permission ?? []);
      const answer = async (permissions: string[]) => {
        const harness = await startPlugin({
          fetch: healthyCoolify().fetch,
          permissions,
        });
        try {
          const sealed = await harness.mock.ctx.secrets.seal("fake-token");
          harness.db.sqlite
            .prepare(
              "INSERT INTO p_coolify_connections (user_id, name, base_url, token_sealed) VALUES (?, ?, ?, ?)",
            )
            .run(OWNER, "authz", "https://coolify.example.test", sealed);
          const path = fullPath.slice(prefix.length).replace(":id", "1");
          return (await harness.request(method, path, entry.body)).status;
        } finally {
          await harness.close();
        }
      };
      expect(await answer(declared), `${key} with ${declared}`).not.toBe(403);
      for (const missing of declared) {
        const fewer = declared.filter((p) => p !== missing);
        expect(await answer(fewer), `${key} without ${missing}`).toBe(403);
      }
    }
  });
});
