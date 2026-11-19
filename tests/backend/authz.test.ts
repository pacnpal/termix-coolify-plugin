import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import express, { type Router } from "express";
import { createMockCtx, createTestDb } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import authz from "../../authz.json";
import { activate } from "../../src/backend/index.js";

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
      );
    const sockets = mock.wsRoutes.map(
      (route) => `WS /plugin-ws/${manifest.id}${route.path}`,
    );
    expect([...served, ...sockets].sort()).toEqual(
      Object.keys(authz.routes).sort(),
    );
    db.close();
  });
});
