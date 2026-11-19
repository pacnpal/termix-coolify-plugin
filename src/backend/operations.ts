import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "./connections/service.js";
import type { Tables } from "./db.js";
import type { Lifecycle } from "./resources/lifecycle.js";
import type { Resources } from "./resources/service.js";
import { registerConnectionOperations } from "./ops/connections.js";
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
}

/**
 * Registers every action declared in manifest.json contributes.operations.
 * Handlers call the same service functions the routes use, never the routes.
 */
export function registerOperations(
  ctx: PluginContext,
  services: Services,
): void {
  registerConnectionOperations(ctx, services.connections);
  registerSyncOperations(ctx, services.sync);
  registerResourceOperations(ctx, services.resources);
  registerLifecycleOperations(ctx, services);
  registerSignalOperations(ctx, services);
  registerUpdateOperations(ctx, services.updates);
}
