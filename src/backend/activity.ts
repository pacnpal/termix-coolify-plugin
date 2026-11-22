import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import en from "../../locales/en.json";
import { ACTIVITY_TYPES, type ActivityKind } from "../shared/activity.js";

/**
 * Adds a Termix recent-activity entry for the actor, "Opened shell in <name>"
 * or "Deployed <name>", on a Linked host. Callers call it once, after the
 * action worked. Only a host the actor can connect to gets one (core checks
 * that too). A failure is logged by its error name only, never thrown: the
 * shell or deploy it follows has already happened.
 */
export async function recordActivity(
  ctx: PluginContext,
  hostId: number | null | undefined,
  kind: ActivityKind,
  name: string,
): Promise<void> {
  if (!hostId) return;
  try {
    const access = await ctx.hosts.checkAccess(hostId, "connect");
    if (!access?.hasAccess) return;
    await ctx.hosts.recordActivity(
      hostId,
      ACTIVITY_TYPES[kind],
      en.activity[kind].replace("{{name}}", name),
    );
  } catch (err) {
    ctx.log.warn(
      `coolify recent activity not recorded: ${(err as Error)?.name ?? "error"}`,
    );
  }
}
