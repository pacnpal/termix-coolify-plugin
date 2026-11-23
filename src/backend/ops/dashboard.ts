import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Dashboard } from "../dashboard/service.js";
import { refreshFlag } from "../deployments/queue.js";
import { connectionIdInput } from "./connections.js";

/**
 * coolify.connection-overview and coolify.vulnerability-summary: what the
 * dashboard cards and homepage widgets show, through the same reads.
 */
export function registerDashboardOperations(
  ctx: PluginContext,
  dashboard: Dashboard,
): void {
  ctx.operations.register("coolify.connection-overview", {
    run: async (input, { signal }) => {
      const overview = await dashboard.overview(connectionIdInput(input), {
        refresh: refreshFlag(input.refresh),
        signal,
      });
      const { running, degraded, stopped, deploying } = overview.counts;
      const servers = overview.servers
        ? `, ${overview.servers.total} servers (${overview.servers.unreachable} unreachable)`
        : "";
      return {
        summary: `${overview.total} resources: ${running} running, ${degraded} degraded, ${stopped} stopped, ${deploying} deploying${servers}`,
        data: overview,
      };
    },
  });

  ctx.operations.register("coolify.vulnerability-summary", {
    run: async (input, { signal }) => {
      const summary = await dashboard.vulnerabilities(
        connectionIdInput(input),
        { refresh: refreshFlag(input.refresh), signal },
      );
      const { critical, high } = summary.problems;
      return {
        summary: `${summary.affected} of ${summary.resources} resources have known vulnerabilities (${critical} critical, ${high} high)`,
        data: summary,
      };
    },
  });
}
