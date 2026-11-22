import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { attentionBody, type AttentionService } from "../attention/service.js";
import { refreshFlag } from "../deployments/queue.js";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * coolify.attention: what the sidebar panel shows, across every connection
 * the actor can view, from the same cached reads.
 */
export function registerAttentionOperations(
  ctx: PluginContext,
  attention: AttentionService,
): void {
  ctx.operations.register("coolify.attention", {
    run: async (input, { signal }) => {
      const answer = await attention.read({
        refresh: refreshFlag(input.refresh),
        signal,
      });
      const { running, failed, degraded, unreachable } = answer.counts;
      return {
        summary: [
          `${plural(running, "deployment", "deployments")} in progress`,
          plural(failed, "recent failure", "recent failures"),
          plural(degraded, "degraded resource", "degraded resources"),
          plural(unreachable, "unreachable server", "unreachable servers"),
        ].join(", "),
        data: attentionBody(answer),
      };
    },
  });
}
