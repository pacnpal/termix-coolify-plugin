import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../connections/service.js";
import {
  handoffIdFor,
  stashOnceUrl,
  type StatusPages,
} from "../status/service.js";
import { connectionIdInput } from "./connections.js";

/** The status page `id` input: a choice from coolify.status-page-list. */
function pageIdInput(input: Record<string, unknown>): number {
  const raw = input.id;
  const id =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d{1,15}$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ConnectionError("not-found", "Status page not found");
  }
  return id;
}

/**
 * Hands the URL over without it reaching run history: it goes to the `url`
 * output, declared sensitive so core drops it before the run is stored or
 * shown, and into the one-time handoff for this actor and run.
 */
function handOver(
  ctx: PluginContext,
  runId: string | null,
  page: { id: number },
  url: string,
) {
  const handoffId = handoffIdFor(runId);
  stashOnceUrl(ctx.currentActor() ?? "", handoffId, url);
  return { id: page.id, handoffId, url };
}

/** The status page actions. Summaries name the page title, never its URL. */
export function registerStatusPageOperations(
  ctx: PluginContext,
  pages: StatusPages,
): void {
  ctx.operations.register("coolify.status-page-list", {
    run: async (input) => {
      const rows = await pages.list(
        input.connectionId === undefined || input.connectionId === ""
          ? undefined
          : connectionIdInput(input),
      );
      return {
        summary: `${rows.length} status page${rows.length === 1 ? "" : "s"}`,
        data: {
          options: rows.map((p) => ({ value: String(p.id), label: p.title })),
          rows,
        },
      };
    },
  });

  ctx.operations.register("coolify.status-page-create", {
    run: async (input, { runId }) => {
      const { page, url } = await pages.create(connectionIdInput(input), {
        title: input.title,
        resources: input.resources,
      });
      return {
        summary: `Published status page "${page.title}"`,
        changed: true,
        data: handOver(ctx, runId, page, url),
      };
    },
  });

  ctx.operations.register("coolify.status-page-rotate", {
    run: async (input, { runId }) => {
      const { page, url } = await pages.rotate(pageIdInput(input));
      return {
        summary: `Gave status page "${page.title}" a new link`,
        changed: true,
        data: handOver(ctx, runId, page, url),
      };
    },
  });

  ctx.operations.register("coolify.status-page-revoke", {
    run: async (input) => {
      const page = await pages.revoke(pageIdInput(input));
      return {
        summary: `Revoked status page "${page.title}"`,
        changed: true,
        data: { id: page.id },
      };
    },
  });
}
