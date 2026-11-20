import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ContainerError, type Containers } from "../containers/service.js";
import type { Logs } from "../containers/logs.js";
import { connectionIdInput } from "./connections.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * coolify.shell-command: the exact docker exec line, for an API or MCP client
 * with its own SSH. It goes through the same checks as the shell route,
 * including the actor's connect access to the Linked host.
 *
 * coolify.logs-tail: the same snapshot as the logs route, labelled with its
 * source. The text is a sensitive output, so run history never keeps it,
 * and it needs confirm: true.
 */
export function registerContainerOperations(
  ctx: PluginContext,
  containers: Containers,
  logs: Logs,
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

  ctx.operations.register("coolify.logs-tail", {
    run: async (input) => {
      // Logs carry secrets: an ops run or MCP call reads them only when the
      // caller asked for exactly that.
      if (input.confirm !== true) {
        throw new ContainerError(
          "invalid-input",
          "Reading logs needs confirm: true",
        );
      }
      const id = connectionIdInput(input);
      const answer = await logs.snapshot(id, text(input.uuid), {
        part: text(input.part) || undefined,
        container: text(input.container) || undefined,
        lines: input.lines,
        timestamps: input.timestamps,
      });
      if ("choices" in answer) {
        return {
          summary: `${answer.choices.length} containers match; pick one with container`,
          data: { choices: answer.choices },
        };
      }
      const count = answer.text
        ? answer.text.replace(/\n$/, "").split("\n").length
        : 0;
      return {
        summary: `${count} log lines from ${answer.source === "coolify" ? "Coolify" : "the server over SSH"}`,
        data: { ...answer },
      };
    },
  });
}
