import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { knownBaseUrl } from "../status/base-url.js";
import type { WebhookSetup } from "../webhooks/setup.js";
import { connectionIdInput } from "./connections.js";

/**
 * The team webhook actions (#92). An operation has no request, so the URL's
 * base is the acting user's own last address (base-url.ts), never another
 * user's; with none, setup refuses. No summary or data holds the URL.
 */
export function registerWebhookOperations(
  ctx: PluginContext,
  setup: WebhookSetup,
): void {
  const base = () => knownBaseUrl(ctx, ctx.currentActor());

  ctx.operations.register("coolify.webhook-status", {
    run: async (input) => {
      const data = await setup.status(connectionIdInput(input), {
        base: await base(),
      });
      return { summary: `Team webhook: ${data.state}`, data };
    },
  });

  ctx.operations.register("coolify.webhook-setup", {
    run: async (input) => {
      const data = await setup.setup(connectionIdInput(input), {
        base: await base(),
      });
      return data.outcome === "configured"
        ? { summary: "Team webhook configured", changed: true, data }
        : {
            summary:
              "The team webhook points somewhere else; replacing it needs Replace the Coolify webhook",
            changed: false,
            data,
          };
    },
  });

  // Destructive: core confirms every run before the handler, so confirmed
  // is passed on (MCP also refuses it without confirmed: true).
  ctx.operations.register("coolify.webhook-replace", {
    run: async (input) => {
      const data = await setup.setup(connectionIdInput(input), {
        base: await base(),
        replace: true,
        confirmed: true,
      });
      return { summary: "Team webhook configured", changed: true, data };
    },
  });

  ctx.operations.register("coolify.webhook-disable", {
    run: async (input) => {
      const data = await setup.disable(connectionIdInput(input), {
        confirmed: true,
      });
      return data.outcome === "disabled"
        ? { summary: "Team webhook turned off", changed: true, data }
        : { summary: "No team webhook was set", changed: false, data };
    },
  });
}
