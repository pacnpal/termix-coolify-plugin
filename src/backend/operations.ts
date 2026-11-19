import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "./connections/service.js";
import { registerConnectionOperations } from "./ops/connections.js";
import type { Sync } from "./sync/service.js";

export interface Services {
  connections: Connections;
  sync: Sync;
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
}
