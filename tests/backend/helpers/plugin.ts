import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockContextOptions,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../../manifest.json";
import { activate } from "../../../src/backend/index.js";

const pluginDir = fileURLToPath(new URL("../../..", import.meta.url));
export const manifest = manifestJson as unknown as PluginManifest;

export const OWNER = "user-1";
export const OTHER = "user-2";

export interface PluginHarness {
  mock: MockPluginContext;
  db: TestDb;
  /** Calls a route as `user` (the owner unless given). */
  request: (
    method: string,
    path: string,
    body?: unknown,
    user?: string,
  ) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

/**
 * Activates the backend on a mock ctx with the plugin-process rules, a test
 * database and a fake ctx.fetch, and serves its router.
 */
export async function startPlugin(
  options: {
    fetch?: (url: string, init?: PluginFetchInit) => Promise<Response>;
    permissions?: string[];
    serve?: boolean;
    /** Admin settings, like allowKeyCopy. */
    settings?: Record<string, unknown>;
    /** What ctx.plugins.list answers. */
    installedPlugins?: MockContextOptions["installedPlugins"];
    /** What ctx.credentials.list answers: the actor's own credentials. */
    credentialSummaries?: MockContextOptions["credentialSummaries"];
    /** Other plugins' services, for the companion adapters. */
    services?: MockContextOptions["services"];
    /** Hosts ctx.hosts.get and checkAccess answer with. */
    hosts?: MockContextOptions["hosts"];
  } = {},
): Promise<PluginHarness> {
  const db = await createTestDb(pluginDir);
  for (const user of [OWNER, OTHER]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  let router: Router | null = null;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: options.permissions,
    fetch: options.fetch,
    settings: options.settings,
    installedPlugins: options.installedPlugins,
    credentialSummaries: options.credentialSummaries,
    services: options.services,
    hosts: options.hosts,
    actor: OWNER,
  });
  await activate(mock.ctx);

  let server: http.Server | null = null;
  let port = 0;
  if (options.serve !== false) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      mock.setActor(String(req.headers["x-test-user"] ?? OWNER));
      next();
    });
    app.use((req, res, next) => router!(req, res, next));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  }

  return {
    mock,
    db,
    async request(method, path, body, user = OWNER) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          "x-test-user": user,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      db.close();
    },
  };
}
