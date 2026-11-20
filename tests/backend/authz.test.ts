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

interface Entry {
  params?: Record<string, string | number>;
  send?: unknown[];
  refuseReply?: string;
}

const entries = authz.routes as Record<string, Entry>;
const keys = Object.keys(entries);
const captured = new Set(
  authz.seed.flatMap((s) => Object.keys(s.capture ?? {})),
);

/** The routes and sockets activate serves, as authz.json keys. */
async function served() {
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

describe("authz.json", () => {
  it("has an entry for every route and no entry for a route that is gone", async () => {
    const { routes } = await served();
    expect(routes).toEqual(keys.filter((k) => !k.startsWith("WS ")).sort());
  });

  it("has an entry for every socket and no entry for a socket that is gone", async () => {
    const { sockets } = await served();
    expect(sockets).toContain("WS /plugin-ws/coolify/logs");
    expect(sockets).toEqual(keys.filter((k) => k.startsWith("WS ")).sort());
    for (const key of sockets) {
      // The checks are per message, so the entry must send one.
      expect(entries[key].send?.length, key).toBeGreaterThan(0);
      expect(entries[key].refuseReply, key).toBeTruthy();
    }
  });

  it("names a captured fixture or an =literal in every param", () => {
    for (const [key, entry] of Object.entries(entries)) {
      for (const [param, value] of Object.entries(entry.params ?? {})) {
        const ok =
          typeof value === "string" &&
          (value.startsWith("=") || captured.has(value));
        expect(ok, `${key} ${param}`).toBe(true);
      }
    }
  });

  it("each route needs exactly the permissions it declares", async () => {
    const prefix = `/plugin-api/${manifest.id}`;
    for (const [key, entry] of Object.entries(authz.routes) as [
      string,
      { permission?: string | string[]; body?: unknown },
    ][]) {
      const [method, fullPath] = key.split(" ");
      // Sockets check per message; tests/backend/containers/logs.test.ts
      // covers the log socket's permission.
      if (method === "WS") continue;
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
