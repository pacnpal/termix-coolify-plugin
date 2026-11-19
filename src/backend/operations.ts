import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "./connections/service.js";
import type { Resources } from "./resources/service.js";
import { registerConnectionOperations } from "./ops/connections.js";
import { registerSyncOperations } from "./ops/sync.js";
import type { Sync } from "./sync/service.js";
import { registerResourceOperations } from "./ops/resources.js";

export interface Services {
  connections: Connections;
  sync: Sync;
  resources: Resources;
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
}
