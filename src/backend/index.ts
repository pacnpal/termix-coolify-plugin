import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { defineTables } from "./db.js";
import { createConnections } from "./connections/service.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { createResources } from "./resources/service.js";
import { registerResourceRoutes } from "./resources/routes.js";
import { createContainers } from "./containers/service.js";
import { registerContainerRoutes } from "./containers/routes.js";
import { registerStatsSocket } from "./containers/sockets.js";
import { createMetrics } from "./metrics/service.js";
import { registerMetricsRoutes } from "./metrics/routes.js";
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
  const router = ctx.http.router<Router>();
  registerConnectionRoutes(router, ctx, connections);
  registerSyncRoutes(router, ctx, sync);
  const resources = createResources(ctx, { tables, connections });
  registerResourceRoutes(router, ctx, resources);
  const containers = createContainers(ctx, { connections, resources, sync });
  registerContainerRoutes(router, ctx, containers);
  registerStatsSocket(ctx, { connections, containers });
  const metrics = createMetrics(ctx, { connections, resources, sync });
  registerMetricsRoutes(router, ctx, metrics);
  registerOperations(ctx, { connections, sync, resources, containers });
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
