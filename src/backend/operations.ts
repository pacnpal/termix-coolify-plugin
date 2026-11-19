import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "./connections/service.js";
import { registerConnectionOperations } from "./ops/connections.js";
import { registerSyncOperations } from "./ops/sync.js";
import { registerUpdateOperations } from "./ops/updates.js";
import type { Sync } from "./sync/service.js";
import type { Updates } from "./updates/service.js";

export interface Services {
  connections: Connections;
  sync: Sync;
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
  registerUpdateOperations(ctx, services.updates);
}
