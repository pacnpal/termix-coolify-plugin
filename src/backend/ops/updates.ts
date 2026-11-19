import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { PatchStatus } from "../coolify/dto.js";
import type { Updates } from "../updates/service.js";
import { connectionIdInput } from "./connections.js";

function counts(status: PatchStatus | null): string {
  if (!status) return "no check yet";
  const security =
    status.security === null ? "" : `, ${status.security} security`;
  const reboot = status.rebootRequired ? ", reboot required" : "";
  return `${status.updates} update${status.updates === 1 ? "" : "s"}${security}${reboot}`;
}

/**
 * Server update actions. They call the same updates service the routes use,
 * so the same permission, connection and Linked host checks apply. Nothing
 * they return carries a secret: package names, versions and counts only.
 */
export function registerUpdateOperations(
  ctx: PluginContext,
  updates: Updates,
): void {
  ctx.operations.register("coolify.server-updates", {
    run: async (input) => {
      const view = await updates.status(
        connectionIdInput(input),
        input.serverUuid,
      );
      const latest = view.fresh ?? view.coolify;
      return {
        summary: `${view.server.name}: ${counts(latest)}`,
        data: view,
      };
    },
  });

  ctx.operations.register("coolify.server-updates-check", {
    run: async (input) => {
      const result = await updates.check(
        connectionIdInput(input),
        input.serverUuid,
      );
      return {
        summary: `${counts(result.fresh)} (via ${result.via})`,
        data: result,
      };
    },
  });

  ctx.operations.register("coolify.server-updates-install", {
    run: async (input) => {
      const result = await updates.install(
        connectionIdInput(input),
        input.serverUuid,
        { confirm: input.confirm },
      );
      return {
        summary: `${result.summary} (via ${result.via})`,
        changed: result.changed,
        data: result,
      };
    },
  });

  ctx.operations.register("coolify.server-reboot", {
    run: async (input) => {
      const result = await updates.reboot(
        connectionIdInput(input),
        input.serverUuid,
        { confirmName: input.confirmName },
      );
      return { summary: result.summary, changed: true, data: result };
    },
  });
}
