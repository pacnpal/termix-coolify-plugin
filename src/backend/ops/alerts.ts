import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { AlertPrefs, Alerts } from "../alerts/service.js";
import { connectionIdInput } from "./connections.js";

function summaryOf(prefs: AlertPrefs): string {
  if (prefs.isDefault) return "Default alerts";
  const n = prefs.kinds.length;
  return n === 0 ? "No alerts" : `${n} alert kind${n === 1 ? "" : "s"}`;
}

/**
 * coolify.alert-prefs and coolify.alert-prefs-set: the actor's own alert
 * kinds for one connection they own or were granted, as GET and PUT
 * /connections/:id/alert-prefs answer them. Nobody reads or writes another
 * person's preferences; another user's connection is 404.
 */
export function registerAlertOperations(
  ctx: PluginContext,
  alerts: Alerts,
): void {
  ctx.operations.register("coolify.alert-prefs", {
    run: async (input) => {
      const prefs = await alerts.prefs(connectionIdInput(input));
      return { summary: summaryOf(prefs), data: prefs };
    },
  });

  ctx.operations.register("coolify.alert-prefs-set", {
    run: async (input) => {
      const prefs = await alerts.setPrefs(
        connectionIdInput(input),
        input.reset === true ? null : input.kinds,
      );
      return { summary: summaryOf(prefs), data: prefs };
    },
  });
}
