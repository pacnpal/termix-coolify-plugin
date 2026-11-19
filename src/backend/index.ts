import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { defineTables } from "./db.js";
import { createConnections } from "./connections/service.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { createResources } from "./resources/service.js";
import { registerResourceRoutes } from "./resources/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { registerOperations } from "./operations.js";
import { createSync, type Sync } from "./sync/service.js";
import { registerSyncRoutes } from "./sync/routes.js";

export async function activate(ctx: PluginContext): Promise<void> {
  const tables = await defineTables(ctx);
  // Removing a connection unlinks its Linked hosts first (or deletes them
  // with removeHosts). Sync is made right after, before any call can arrive.
  let sync: Sync | null = null;
  const connections = createConnections(ctx, tables, {
    releaseLinkedHosts: async (connectionId, opts, deleteRows) => {
      if (sync) await sync.releaseConnection(connectionId, opts, deleteRows);
      else await deleteRows();
    },
  });
  sync = await createSync(ctx, { tables, connections });
  const resources = createResources(ctx, { tables, connections });
  const router = ctx.http.router<Router>();
  registerConnectionRoutes(router, ctx, connections);
  registerResourceRoutes(router, ctx, resources);
  registerSyncRoutes(router, ctx, sync);
  registerMcpRoutes(router, ctx);
  registerOperations(ctx, { connections, resources, sync });
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
