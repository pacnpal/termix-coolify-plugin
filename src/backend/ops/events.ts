import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Events } from "../events/service.js";
import { connectionIdInput } from "./connections.js";

/**
 * coolify.events-list: a page of one connection's event log, newest first,
 * as GET /connections/:id/events answers it. A read for coolify.view, on the
 * actor's own connections (or ones granted to them) only.
 */
export function registerEventOperations(
  ctx: PluginContext,
  events: Events,
): void {
  ctx.operations.register("coolify.events-list", {
    run: async (input) => {
      const page = await events.list(connectionIdInput(input), {
        kind: input.kind,
        uuid: input.uuid,
        limit: input.limit,
        before: input.before,
      });
      const n = page.rows.length;
      return {
        summary: `${n} event${n === 1 ? "" : "s"}${page.nextBefore === null ? "" : ", more before"}`,
        data: page,
      };
    },
  });
}
