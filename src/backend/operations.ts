import type {
  PluginContext,
  PluginOperationHandler,
} from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "./connections/service.js";
import type { Tables } from "./db.js";
import type { Lifecycle } from "./resources/lifecycle.js";
import type { Resources } from "./resources/service.js";
import type { Containers } from "./containers/service.js";
import { registerConnectionOperations } from "./ops/connections.js";
import { registerContainerOperations } from "./ops/containers.js";
import { registerLifecycleOperations } from "./ops/lifecycle.js";
import { registerResourceOperations } from "./ops/resources.js";
import { registerSignalOperations } from "./ops/signals.js";
import { registerSyncOperations } from "./ops/sync.js";
import { registerUpdateOperations } from "./ops/updates.js";
import type { Sync } from "./sync/service.js";
import type { Updates } from "./updates/service.js";

export interface Services {
  tables: Tables;
  connections: Connections;
  sync: Sync;
  resources: Resources;
  lifecycle: Lifecycle;
  updates: Updates;
  containers: Containers;
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
  registerSyncOperations(ctx, services.sync);
  registerResourceOperations(ctx, services.resources);
  registerLifecycleOperations(ctx, services);
  registerSignalOperations(ctx, services);
  registerUpdateOperations(ctx, services.updates);
  registerContainerOperations(ctx, services.containers);
}
