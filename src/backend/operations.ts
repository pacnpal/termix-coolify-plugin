import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Companions } from "./companions/service.js";
import type { Containers } from "./containers/service.js";
import type { Connections } from "./connections/service.js";
import type { Tables } from "./db.js";
import type { Lifecycle } from "./resources/lifecycle.js";
import type { Resources } from "./resources/service.js";
import { registerCompanionOperations } from "./ops/companions.js";
import { registerConnectionOperations } from "./ops/connections.js";
import { registerContainerOperations } from "./ops/containers.js";
import { registerLifecycleOperations } from "./ops/lifecycle.js";
import { registerResourceOperations } from "./ops/resources.js";
import {
  registerSignalOperations,
  type ServerStatuses,
} from "./ops/signals.js";
import { registerSyncOperations } from "./ops/sync.js";
import { registerUpdateOperations } from "./ops/updates.js";
import type { Sync } from "./sync/service.js";
import type { Updates } from "./updates/service.js";

export interface Services {
  tables: Tables;
  connections: Connections;
  resources: Resources;
  sync: Sync;
  lifecycle: Lifecycle;
  containers: Containers;
  servers: ServerStatuses;
  updates: Updates;
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
  registerResourceOperations(ctx, services.resources);
  registerSyncOperations(ctx, services.sync);
  registerLifecycleOperations(ctx, services);
  registerSignalOperations(ctx, services);
  registerContainerOperations(ctx, services.containers);
  registerUpdateOperations(ctx, services.updates);
  registerCompanionOperations(ctx, services.companions);
}
