import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import { createMockCtx, createTestDb } from "@termix-ssh/plugin-sdk/testing";
import { activate } from "../../../src/backend/index.js";
import { manifest } from "./plugin.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * The routes and sockets activate serves, as authz.json keys
 * (`GET /plugin-api/coolify/...`, `WS /plugin-ws/coolify/...`).
 */
export async function served(): Promise<{
  routes: string[];
  sockets: string[];
}> {
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
  const routes = (router!.stack as unknown as Layer[])
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route!.methods).map(
        (method) =>
          `${method.toUpperCase()} /plugin-api/${manifest.id}${layer.route!.path}`,
      ),
    )
    .sort();
  const sockets = mock.wsRoutes
    .map((r) => `WS /plugin-ws/${manifest.id}${r.path}`)
    .sort();
  db.close();
  return { routes, sockets };
}
