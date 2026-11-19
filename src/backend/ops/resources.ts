import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../connections/service.js";
import { countResources } from "../../shared/resource-health.js";
import type { Resources } from "../resources/service.js";
import { connectionIdInput } from "./connections.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The resource reads. Their data is the stripped DTOs the routes return, so
 * no environment value, key, token or compose file can reach a run.
 */
export function registerResourceOperations(
  ctx: PluginContext,
  resources: Resources,
): void {
  ctx.operations.register("coolify.list-resources-all", {
    run: async (input) => {
      const id = connectionIdInput(input);
      const serverUuid = text(input.serverUuid);
      const all = await resources.list(id);
      const rows = serverUuid
        ? all.filter((r) => r.serverUuid === serverUuid)
        : all;
      const counts = countResources(rows);
      const total =
        counts.running + counts.degraded + counts.stopped + counts.deploying;
      return {
        summary: `${total} resource${total === 1 ? "" : "s"}: ${counts.running} running, ${counts.degraded} degraded, ${counts.stopped} stopped, ${counts.deploying} deploying`,
        data: { rows, counts },
      };
    },
  });

  ctx.operations.register("coolify.resource-get", {
    run: async (input) => {
      const id = connectionIdInput(input);
      const found = await resources.get(id, text(input.uuid));
      if (!found) {
        throw new ConnectionError("not-found", "Coolify resource not found");
      }
      return {
        summary: `${found.name} (${found.kind}): ${found.status}`,
        data: found,
      };
    },
  });
}
