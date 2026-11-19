import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { defineTables } from "./db.js";
import { createConnections } from "./connections/service.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { createResources } from "./resources/service.js";
import { createLifecycle } from "./resources/lifecycle.js";
import {
  registerLifecycleRoutes,
  registerResourceRoutes,
} from "./resources/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { registerOperations } from "./operations.js";
import { createSync, type Sync } from "./sync/service.js";
import { registerSyncRoutes } from "./sync/routes.js";
import { createUpdates } from "./updates/service.js";
import { registerUpdateRoutes } from "./updates/routes.js";

export async function activate(ctx: PluginContext): Promise<void> {
  const tables = await defineTables(ctx);
  // Removing a connection unlinks its Linked hosts first (or deletes them
  // with removeHosts). Sync is made right after, before any call can arrive.
  let sync: Sync | null = null;
  const connections = createConnections(ctx, tables, {
    releaseLinkedHosts: async (connectionId, opts) =>
      sync?.releaseConnection(connectionId, opts),
  });
  sync = await createSync(ctx, { tables, connections });
  const resources = createResources(ctx, { tables, connections });
  const lifecycle = createLifecycle(ctx, { connections, resources, sync });
  const updates = createUpdates(ctx, { tables, connections, sync });
  const router = ctx.http.router<Router>();
  registerConnectionRoutes(router, ctx, connections);
  registerSyncRoutes(router, ctx, sync);
  registerResourceRoutes(router, ctx, resources);
  registerLifecycleRoutes(router, ctx, lifecycle);
  registerUpdateRoutes(router, ctx, updates);
  registerMcpRoutes(router, ctx);
  registerOperations(ctx, {
    tables,
    connections,
    sync,
    resources,
    lifecycle,
    updates,
  });
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
