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
/** Sent as the test user for a request with no signed-in user (a public route). */
export const ANON = "anon";

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
  /** Calls a route and keeps the answer as text with its headers (HTML pages). */
  raw: (
    method: string,
    path: string,
    user?: string,
  ) => Promise<{ status: number; headers: Headers; text: string }>;
  close: () => Promise<void>;
  /** Where the router is served, or null with `serve: false`. */
  address: AddressInfo | null;
}

/**
 * Activates the backend on a mock ctx with the plugin-process rules, a test
 * database and a fake ctx.fetch, and serves its router.
 */
export async function startPlugin(
  options: {
    fetch?: (url: string, init?: PluginFetchInit) => Promise<Response>;
    permissions?: string[];
    /** Seed for the plugin's admin settings, like allowKeyCopy. */
    settings?: Record<string, unknown>;
    serve?: boolean;
    /** What ctx.plugins.list answers. */
    installedPlugins?: MockContextOptions["installedPlugins"];
    /** What ctx.credentials.list answers: the actor's own credentials. */
    credentialSummaries?: MockContextOptions["credentialSummaries"];
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
    settings: options.settings,
    fetch: options.fetch,
    installedPlugins: options.installedPlugins,
    credentialSummaries: options.credentialSummaries,
    hosts: options.hosts,
    actor: OWNER,
  });
  await activate(mock.ctx);

  let server: http.Server | null = null;
  let address: AddressInfo | null = null;
  if (options.serve !== false) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const user = String(req.headers["x-test-user"] ?? OWNER);
      mock.setActor(user === ANON ? undefined : user);
      next();
    });
    app.use((req, res, next) => router!(req, res, next));
    server = http.createServer(app);
    // 127.0.0.1 only: bound to "::", a port another process holds on
    // 127.0.0.1 still binds, and the requests below would reach that process.
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    address = server.address() as AddressInfo;
  }

  return {
    mock,
    db,
    address,
    async request(method, path, body, user = OWNER) {
      const response = await fetch(`http://127.0.0.1:${address?.port}${path}`, {
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
    async raw(method, path, user = OWNER) {
      const response = await fetch(`http://127.0.0.1:${address?.port}${path}`, {
        method,
        headers: { "x-test-user": user },
      });
      const text = await response.text();
      // A public request has no user; later direct ctx calls act as the owner.
      if (user === ANON) mock.setActor(OWNER);
      return { status: response.status, headers: response.headers, text };
    },
    async close() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      db.close();
    },
  };
}
