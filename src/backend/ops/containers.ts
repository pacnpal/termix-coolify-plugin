import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Containers } from "../containers/service.js";
import { connectionIdInput } from "./connections.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * coolify.shell-command: the exact docker exec line, for an API or MCP client
 * with its own SSH. It goes through the same checks as the shell route,
 * including the actor's connect access to the Linked host.
 */
export function registerContainerOperations(
  ctx: PluginContext,
  containers: Containers,
): void {
  ctx.operations.register("coolify.shell-command", {
    run: async (input) => {
      const id = connectionIdInput(input);
      const answer = await containers.shell(id, text(input.uuid), {
        part: text(input.part) || undefined,
        container: text(input.container) || undefined,
        console: text(input.console) || undefined,
      });
      if ("choices" in answer) {
        return {
          summary: `${answer.choices.length} containers match; pick one with container`,
          data: { choices: answer.choices },
        };
      }
      return {
        summary: `docker exec into ${answer.container} on host ${answer.hostId}`,
        data: {
          hostId: answer.hostId,
          container: answer.container,
          command: answer.command,
        },
      };
    },
  });
}
