import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { defineTables } from "./db.js";
import { registerCompanionRoutes } from "./companions/routes.js";
import { createCompanions } from "./companions/service.js";
import { createConnections } from "./connections/service.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { registerOperations } from "./operations.js";
import { createSync, type Sync } from "./sync/service.js";
import { registerSyncRoutes } from "./sync/routes.js";

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
  const companions = createCompanions(ctx, { tables, connections, sync });
  const router = ctx.http.router<Router>();
  registerConnectionRoutes(router, ctx, connections);
  registerSyncRoutes(router, ctx, sync);
  registerCompanionRoutes(router, ctx, companions);
  registerOperations(ctx, { connections, sync, companions });
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
