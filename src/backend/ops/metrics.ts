import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Metrics } from "../metrics/service.js";
import { connectionIdInput } from "./connections.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The metric and traffic reads. They return the same data as the routes,
 * through the same checks: SSH reads need coolify.operate and the actor's own
 * connect access to the Linked host, and IPs stay hidden unless Coolify keeps
 * them in full.
 */
export function registerMetricsOperations(
  ctx: PluginContext,
  metrics: Metrics,
): void {
  ctx.operations.register("coolify.resource-metrics", {
    run: async (input) => {
      const data = await metrics.resourceMetrics(
        connectionIdInput(input),
        text(input.uuid),
        { minutes: input.minutes },
      );
      return {
        summary: `${count(data.cpu.length, "CPU point")} and ${count(data.memory.length, "memory point")} over ${data.minutes} minutes, from Sentinel`,
        data,
      };
    },
  });

  ctx.operations.register("coolify.resource-traffic", {
    run: async (input) => {
      const data = await metrics.resourceTraffic(
        connectionIdInput(input),
        text(input.uuid),
        { view: input.view, dim: input.dim, range: input.range },
      );
      const what = data.dim ? `${data.view} by ${data.dim}` : data.view;
      return {
        summary: `Traffic ${what} for the last ${data.range}${data.ipsHidden ? ", IPs hidden" : ""}`,
        data,
      };
    },
  });

  ctx.operations.register("coolify.server-metrics", {
    run: async (input) => {
      const data = await metrics.serverMetrics(
        connectionIdInput(input),
        text(input.serverUuid),
        { minutes: input.minutes },
      );
      const cpu = data.current?.cpu_percent;
      return {
        summary: `Server metrics over ${data.minutes} minutes from ${data.source === "mcp" ? "Coolify's MCP" : "Sentinel"}${typeof cpu === "number" ? `, CPU ${cpu.toFixed(1)}%` : ""}`,
        data,
      };
    },
  });
}
