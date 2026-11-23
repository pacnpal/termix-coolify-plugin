import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { defineTables } from "./db.js";
import { createDeployActivity } from "./activity.js";
import { registerApiConsoleRoutes } from "./api/routes.js";
import { registerAttentionRoutes } from "./attention/routes.js";
import { createAttention } from "./attention/service.js";
import { registerCompanionRoutes } from "./companions/routes.js";
import { createCompanions } from "./companions/service.js";
import { createContainerCompanions } from "./companions/container-service.js";
import { registerContainerCompanionRoutes } from "./companions/container-routes.js";
import { createConnections } from "./connections/service.js";
import { createEvents } from "./events/service.js";
import { registerEventRoutes } from "./events/routes.js";
import { createDashboard } from "./dashboard/service.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { createResources } from "./resources/service.js";
import { createLifecycle } from "./resources/lifecycle.js";
import {
  registerLifecycleRoutes,
  registerResourceRoutes,
  registerServerHealthRoutes,
} from "./resources/routes.js";
import { createServerHealth } from "./resources/server-health.js";
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
import { createPoller, type Poller } from "./poll/service.js";
import { registerUpdateRoutes } from "./updates/routes.js";
import { rememberBaseUrlMiddleware } from "./status/base-url.js";
import { createStatusPages } from "./status/service.js";
import { PUBLIC_STATUS_PATHS, registerStatusRoutes } from "./status/routes.js";

export async function activate(ctx: PluginContext): Promise<void> {
  const tables = await defineTables(ctx);
  // Removing a connection unlinks its Linked hosts first (or deletes them
  // with removeHosts). Sync is made right after, before any call can arrive.
  let sync: Sync | null = null;
  // The poller is made once the services it reads exist; until then a
  // connection change has nothing to tell it.
  let poller: Poller | null = null;
  const connections = createConnections(ctx, tables, {
    releaseLinkedHosts: async (connectionId, opts, deleteRows) => {
      if (sync) await sync.releaseConnection(connectionId, opts, deleteRows);
      else await deleteRows();
    },
    changed: async (id) => {
      await poller?.changed(id);
    },
    pollError: (id) => poller?.lastError(id) ?? null,
  });
  sync = await createSync(ctx, { tables, connections });
  const resources = createResources(ctx, { tables, connections });
  // The one event pipeline. The poller and the team webhook feed it.
  const events = createEvents(ctx, { tables, connections, sync });
  // The one post-start hook every deploy path shares: recent activity.
  const deployed = createDeployActivity(ctx, sync);
  const lifecycle = createLifecycle(ctx, {
    connections,
    resources,
    sync,
    deployed,
    events,
  });
  const containers = createContainers(ctx, { connections, lifecycle, sync });
  const logs = createLogs(ctx, { connections, containers });
  const deployments = createDeployments(ctx, {
    connections,
    resources,
    deployed,
  });
  const previews = createPreviews(ctx, { deployments });
  const servers = createServerStatuses(ctx, { tables, connections });
  // The polling source of the event pipeline (the webhook is the other).
  poller = createPoller(ctx, {
    tables,
    connections,
    resources,
    deployments,
    servers,
    events,
  });
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
  const dashboard = createDashboard(ctx, { connections, resources, servers });
  const statusPages = createStatusPages(ctx, {
    tables,
    connections,
    resources,
  });
  // Linked host rows: the dot, resource counts and the deploying badge.
  const serverHealth = createServerHealth({
    connections,
    resources,
    servers,
    deployments,
  });
  const router = ctx.http.router<Router>({ public: PUBLIC_STATUS_PATHS });
  router.use(rememberBaseUrlMiddleware(ctx) as never);
  registerConnectionRoutes(router, ctx, connections);
  registerResourceRoutes(router, ctx, resources, connections);
  registerServerHealthRoutes(router, ctx, serverHealth);
  registerSyncRoutes(router, ctx, sync);
  registerLifecycleRoutes(router, ctx, lifecycle);
  registerDeploymentRoutes(router, ctx, deployments);
  registerPreviewRoutes(router, ctx, previews);
  registerAttentionRoutes(router, ctx, attention);
  registerEventRoutes(router, ctx, events);
  registerDashboardRoutes(router, ctx, dashboard);
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
    events,
    dashboard,
    serverHealth,
  });
  provideClient(ctx);
  await statusPages.start();
  await poller.start();
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
