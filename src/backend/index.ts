import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { defineTables } from "./db.js";
import { registerApiConsoleRoutes } from "./api/routes.js";
import { registerAttentionRoutes } from "./attention/routes.js";
import { createAttention } from "./attention/service.js";
import { registerCompanionRoutes } from "./companions/routes.js";
import { createCompanions } from "./companions/service.js";
import { createContainerCompanions } from "./companions/container-service.js";
import { registerContainerCompanionRoutes } from "./companions/container-routes.js";
import { createConnections } from "./connections/service.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { createResources } from "./resources/service.js";
import { createLifecycle } from "./resources/lifecycle.js";
import {
  registerLifecycleRoutes,
  registerResourceRoutes,
} from "./resources/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { provideClient } from "./service.js";
import { createContainers } from "./containers/service.js";
import { registerContainerRoutes } from "./containers/routes.js";
import { createLogs } from "./containers/logs.js";
import { createDeployments } from "./deployments/service.js";
import { registerDeploymentRoutes } from "./deployments/routes.js";
import { createPreviews } from "./previews/service.js";
import { registerPreviewRoutes } from "./previews/routes.js";
import { createExec } from "./containers/exec.js";
import { registerLogSocket } from "./containers/sockets.js";
import { registerStatsSocket } from "./containers/stats.js";
import { createMetrics } from "./metrics/service.js";
import { registerMetricsRoutes } from "./metrics/routes.js";
import { createGenericApi } from "./ops/api-generic.js";
import { registerOperations } from "./operations.js";
import { createSync, type Sync } from "./sync/service.js";
import { registerSyncRoutes } from "./sync/routes.js";
import { createServerStatuses } from "./ops/signals.js";
import { createUpdates } from "./updates/service.js";
import { registerUpdateRoutes } from "./updates/routes.js";
import { rememberBaseUrlMiddleware } from "./status/base-url.js";
import { createStatusPages } from "./status/service.js";
import { PUBLIC_STATUS_PATHS, registerStatusRoutes } from "./status/routes.js";

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
  const lifecycle = createLifecycle(ctx, { connections, resources, sync });
  const containers = createContainers(ctx, { connections, lifecycle, sync });
  const logs = createLogs(ctx, { connections, containers });
  const deployments = createDeployments(ctx, { connections, resources });
  const previews = createPreviews(ctx, { deployments });
  const servers = createServerStatuses(ctx, { tables, connections });
  const exec = createExec(ctx, {
    connections,
    containers,
    sync,
    resources,
    servers,
  });
  const metrics = createMetrics(ctx, { connections, containers, sync });
  const updates = createUpdates(ctx, {
    tables,
    connections,
    resources,
    servers,
    sync,
  });
  const genericApi = createGenericApi(ctx, {
    connections,
    resources,
    servers,
  });
  const companions = createCompanions(ctx, {
    tables,
    connections,
    resources,
    sync,
  });
  const containerCompanions = createContainerCompanions(ctx, {
    connections,
    containers,
    resources,
    sync,
  });
  const attention = createAttention(ctx, {
    connections,
    resources,
    deployments,
    servers,
  });
  const statusPages = createStatusPages(ctx, {
    tables,
    connections,
    resources,
  });
  const router = ctx.http.router<Router>({ public: PUBLIC_STATUS_PATHS });
  router.use(rememberBaseUrlMiddleware(ctx) as never);
  registerConnectionRoutes(router, ctx, connections);
  registerResourceRoutes(router, ctx, resources);
  registerSyncRoutes(router, ctx, sync);
  registerLifecycleRoutes(router, ctx, lifecycle);
  registerDeploymentRoutes(router, ctx, deployments);
  registerPreviewRoutes(router, ctx, previews);
  registerAttentionRoutes(router, ctx, attention);
  registerContainerRoutes(router, ctx, containers, logs);
  registerLogSocket(ctx, { logs });
  registerStatsSocket(ctx, { connections, containers });
  registerMetricsRoutes(router, ctx, metrics);
  registerUpdateRoutes(router, ctx, updates);
  registerCompanionRoutes(router, ctx, companions);
  registerContainerCompanionRoutes(router, ctx, containerCompanions);
  registerApiConsoleRoutes(router, ctx, genericApi);
  registerMcpRoutes(router, ctx);
  registerStatusRoutes(router, ctx, statusPages);
  registerOperations(ctx, {
    tables,
    connections,
    sync,
    resources,
    lifecycle,
    deployments,
    previews,
    containers,
    logs,
    exec,
    servers,
    updates,
    companions,
    containerCompanions,
    statusPages,
    genericApi,
    metrics,
    attention,
  });
  provideClient(ctx);
  await statusPages.start();
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
