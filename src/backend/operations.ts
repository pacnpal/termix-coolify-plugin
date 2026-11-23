import type {
  PluginContext,
  PluginOperationHandler,
} from "@termix-ssh/plugin-sdk/backend";
import type { AttentionService } from "./attention/service.js";
import type { Companions } from "./companions/service.js";
import type { ContainerCompanions } from "./companions/container-service.js";
import type { Containers } from "./containers/service.js";
import type { Exec } from "./containers/exec.js";
import type { Alerts } from "./alerts/service.js";
import type { Events } from "./events/service.js";
import type { Logs } from "./containers/logs.js";
import type { Deployments } from "./deployments/service.js";
import type { Previews } from "./previews/service.js";
import type { Connections } from "./connections/service.js";
import type { Tables } from "./db.js";
import type { Lifecycle } from "./resources/lifecycle.js";
import type { Metrics } from "./metrics/service.js";
import type { Resources } from "./resources/service.js";
import { registerAttentionOperations } from "./ops/attention.js";
import { registerCompanionOperations } from "./ops/companions.js";
import type { StatusPages } from "./status/service.js";
import { registerConnectionOperations } from "./ops/connections.js";
import { registerAlertOperations } from "./ops/alerts.js";
import { registerEventOperations } from "./ops/events.js";
import {
  registerGenericApiOperations,
  type GenericApi,
} from "./ops/api-generic.js";
import { registerContainerOperations } from "./ops/containers.js";
import { registerDeploymentOperations } from "./ops/deployments.js";
import { registerPreviewOperations } from "./ops/previews.js";
import { registerLifecycleOperations } from "./ops/lifecycle.js";
import { registerMetricsOperations } from "./ops/metrics.js";
import { registerResourceOperations } from "./ops/resources.js";
import { registerRollbackOperations } from "./ops/rollback.js";
import {
  registerSignalOperations,
  type ServerStatuses,
} from "./ops/signals.js";
import { registerSyncOperations } from "./ops/sync.js";
import { registerUpdateOperations } from "./ops/updates.js";
import type { Sync } from "./sync/service.js";
import type { Updates } from "./updates/service.js";
import { registerStatusPageOperations } from "./ops/status-pages.js";

export interface Services {
  tables: Tables;
  connections: Connections;
  resources: Resources;
  sync: Sync;
  lifecycle: Lifecycle;
  deployments: Deployments;
  previews: Previews;
  containers: Containers;
  logs: Logs;
  exec: Exec;
  servers: ServerStatuses;
  updates: Updates;
  companions: Companions;
  containerCompanions: ContainerCompanions;
  statusPages: StatusPages;
  genericApi: GenericApi;
  metrics: Metrics;
  attention: AttentionService;
  events: Events;
  alerts: Alerts;
}

/**
 * A handler that stops before it starts when its run is already cancelled,
 * timed out or the plugin is stopping. Long handlers (a deploy that waits)
 * watch the signal themselves as well.
 */
export function abortable(
  handler: PluginOperationHandler,
): PluginOperationHandler {
  const { run, describe } = handler;
  return {
    run: async (input, c) => {
      c.signal.throwIfAborted();
      return await run(input, c);
    },
    ...(describe && {
      describe: async (input, c) => {
        c.signal.throwIfAborted();
        return await describe(input, c);
      },
    }),
  };
}

/** ctx, with every handler registered through it made abortable. */
function withAbortableHandlers(ctx: PluginContext): PluginContext {
  const operations = Object.create(ctx.operations, {
    register: {
      value: (id: string, handler: PluginOperationHandler) =>
        ctx.operations.register(id, abortable(handler)),
    },
  }) as PluginContext["operations"];
  return Object.create(ctx, {
    operations: { value: operations },
  }) as PluginContext;
}

/**
 * Registers every action declared in manifest.json contributes.operations.
 * Handlers call the same service functions the routes use, never the routes.
 * Every one honours its run's abort signal before it starts.
 */
export function registerOperations(
  base: PluginContext,
  services: Services,
): void {
  const ctx = withAbortableHandlers(base);
  registerConnectionOperations(ctx, services.connections);
  registerResourceOperations(ctx, services.resources);
  registerSyncOperations(ctx, services.sync);
  registerLifecycleOperations(ctx, services);
  registerDeploymentOperations(ctx, services.deployments);
  registerPreviewOperations(ctx, services.previews);
  registerRollbackOperations(ctx, services);
  registerSignalOperations(ctx, services);
  registerContainerOperations(
    ctx,
    services.containers,
    services.logs,
    services.exec,
  );
  registerUpdateOperations(ctx, services.updates);
  registerCompanionOperations(
    ctx,
    services.companions,
    services.containerCompanions,
  );
  registerStatusPageOperations(ctx, services.statusPages);
  registerGenericApiOperations(ctx, services.genericApi);
  registerMetricsOperations(ctx, services.metrics);
  registerAttentionOperations(ctx, services.attention);
  registerEventOperations(ctx, services.events);
  registerAlertOperations(ctx, services.alerts);
}
