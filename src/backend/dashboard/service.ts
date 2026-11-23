import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { forRevision } from "../connections/hold.js";
import { ConnectionError, type Connections } from "../connections/service.js";
import type { ServerStatuses } from "../ops/signals.js";
import type { Resources } from "../resources/service.js";
import type {
  ConnectionOverview,
  VulnerabilitySummary,
} from "../../shared/dashboard.js";
import { countResources } from "../../shared/resource-health.js";
import { createVulnerabilityCache } from "./vulnerabilities.js";

const notFound = () =>
  new ConnectionError("not-found", "Coolify connection not found");

/**
 * The two reads made for the dashboard cards and homepage widgets. The
 * single resource and deployments cards use the resource list and the
 * deployment queue routes as they are.
 *
 * - `overview`: resource counts and servers, from the resources (20 s) and
 *   server status (a minute) caches the tab and the host dots already read
 *   through, so it asks Coolify nothing of its own.
 * - `vulnerabilities`: counts from Coolify's `/vulnerabilities`, kept five
 *   minutes per connection (vulnerabilities.ts).
 *
 * Both need coolify.view and any access to the connection; another user's
 * connection is not-found, and a connection whose access went away while it
 * was read is not-found too.
 */
export function createDashboard(
  ctx: PluginContext,
  deps: {
    connections: Connections;
    resources: Pick<Resources, "load">;
    servers: Pick<ServerStatuses, "list">;
    now?: () => number;
  },
) {
  const { connections, resources, servers } = deps;
  const vulnerabilities = createVulnerabilityCache({
    revision: (id) => connections.revision(id),
    now: deps.now,
  });

  async function needView(): Promise<void> {
    if (!(await ctx.rbac.has("view"))) {
      throw new ConnectionError(
        "forbidden",
        "Coolify dashboard cards need the View Coolify permission",
      );
    }
  }

  return {
    async overview(
      connectionId: number,
      opts: { refresh?: boolean; signal?: AbortSignal } = {},
    ): Promise<ConnectionOverview> {
      await needView();
      // Both lists return what they fetched even across a repoint (their
      // revision only decides what they cache), so the answer is given only
      // while the revision is the one taken before them; access is checked
      // before and after with it.
      const [list, statuses] = await forRevision(
        connections,
        connectionId,
        () => {
          opts.signal?.throwIfAborted();
          return Promise.allSettled([
            resources.load(connectionId, { refresh: opts.refresh }),
            servers.list(connectionId),
          ]);
        },
      );
      opts.signal?.throwIfAborted();
      if (list.status === "rejected") throw list.reason;
      const counts = countResources(list.value.rows);
      const rows = statuses.status === "fulfilled" ? statuses.value : null;
      return {
        connectionId,
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        servers: rows && {
          total: rows.length,
          unreachable: rows.filter((s) => !s.reachable).length,
          unusable: rows.filter((s) => !s.usable).length,
        },
        fetchedAt: new Date(list.value.fetchedAt).toISOString(),
      };
    },

    async vulnerabilities(
      connectionId: number,
      opts: { refresh?: boolean; signal?: AbortSignal } = {},
    ): Promise<VulnerabilitySummary> {
      await needView();
      // Another user's connection is not-found here.
      const snap = await connections.snapshot(connectionId);
      opts.signal?.throwIfAborted();
      const value = await vulnerabilities.read(
        connectionId,
        snap.view.revision,
        snap.api,
        { refresh: opts.refresh },
      );
      // Still the actor's to view, and still the target that was read.
      if (!(await connections.access(connectionId))) throw notFound();
      if ((await connections.revision(connectionId)) !== snap.view.revision) {
        throw new ConnectionError(
          "target-changed",
          "The connection's address, token or Access settings changed. Try again.",
        );
      }
      return {
        connectionId,
        resources: value.resources,
        affected: value.affected,
        statuses: value.statuses,
        problems: value.problems,
        fetchedAt: new Date(value.fetchedAt).toISOString(),
      };
    },
  };
}

export type Dashboard = ReturnType<typeof createDashboard>;
