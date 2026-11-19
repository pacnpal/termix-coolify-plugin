import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Companions } from "./companions/service.js";
import type { Connections } from "./connections/service.js";
import { registerCompanionOperations } from "./ops/companions.js";
import { registerConnectionOperations } from "./ops/connections.js";
import { registerSyncOperations } from "./ops/sync.js";
import type { Sync } from "./sync/service.js";

export interface Services {
  connections: Connections;
  sync: Sync;
  companions: Companions;
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
  registerCompanionOperations(ctx, services.companions);
}
