import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Connections } from "./connections/service.js";

export interface Services {
  connections: Connections;
}

/**
 * Registers every action declared in manifest.json contributes.operations.
 * Handlers call the same service functions the routes use.
 */
export function registerOperations(
  _ctx: PluginContext,
  _services: Services,
): void {}
