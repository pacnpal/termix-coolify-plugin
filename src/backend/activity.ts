import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import en from "../../locales/en.json";
import { ACTIVITY_TYPES, type ActivityKind } from "../shared/activity.js";
import type { Sync } from "./sync/service.js";

function errorName(err: unknown): string {
  return (err as Error)?.name ?? "error";
}

/**
 * Adds a Termix recent-activity entry for the actor on a Linked host, with
 * its text already in words. Only a host the actor can connect to gets one
 * (core checks that too). A failure is logged by its error name only, never
 * thrown: the shell or deploy it follows has already happened.
 */
async function record(
  ctx: PluginContext,
  hostId: number,
  kind: ActivityKind,
  text: string,
): Promise<void> {
  try {
    const access = await ctx.hosts.checkAccess(hostId, "connect");
    if (!access?.hasAccess) return;
    await ctx.hosts.recordActivity(hostId, ACTIVITY_TYPES[kind], text);
  } catch (err) {
    ctx.log.warn(`coolify recent activity not recorded: ${errorName(err)}`);
  }
}

/** "Opened shell in <name>" on a Linked host, once a shell or console opened. */
export async function recordShell(
  ctx: PluginContext,
  hostId: number | null | undefined,
  name: string,
): Promise<void> {
  if (!hostId) return;
  await record(
    ctx,
    hostId,
    "shell",
    en.activity.shell.replace("{{name}}", name),
  );
}

/** One resource a deploy path asked Coolify to deploy, and Coolify's answer. */
export interface DeployStart {
  name: string;
  kind: string;
  /** The deployment Coolify queued, if it named one. */
  deploymentUuid: string | null;
  /** The Linked host, when the caller already knows it. */
  hostId?: number | null;
  /** Otherwise the resource's server, looked up as a Linked host here. */
  serverUuid?: string | null;
  /** A pull request preview's id. */
  pullRequestId?: number;
}

/**
 * Whether Coolify started a deploy. An application's deploy is queued as a
 * deployment, so it counts only with a deployment uuid (none means Coolify
 * skipped it); a service or database is started straight away and never
 * gets one.
 */
export function deployStarted(
  start: Pick<DeployStart, "kind" | "deploymentUuid">,
) {
  return start.kind !== "application" || Boolean(start.deploymentUuid);
}

function deployText(start: DeployStart): string {
  const text = en.activity.deploy.replace("{{name}}", start.name);
  return start.pullRequestId === undefined
    ? text
    : en.activity.deployPreview
        .replace("{{name}}", start.name)
        .replace("{{pullRequestId}}", String(start.pullRequestId));
}

/**
 * The one post-start hook every deploy path calls (lifecycle, deploy by
 * tag, rollback and previews), after Coolify accepted the request:
 * "Deployed <name>" in the actor's recent activity, once per resource
 * Coolify started, on its Linked host. Resources with no Linked host, or one
 * the actor can't connect to, get none. Never throws.
 */
export function createDeployActivity(
  ctx: PluginContext,
  sync: Pick<Sync, "linkedHostFor">,
) {
  return async function deployed(
    connectionId: number,
    starts: DeployStart[],
  ): Promise<void> {
    const done = new Set<string>();
    for (const start of starts) {
      if (!deployStarted(start)) continue;
      let hostId = start.hostId ?? null;
      try {
        if (!hostId && start.serverUuid) {
          hostId = await sync.linkedHostFor(connectionId, start.serverUuid);
        }
      } catch (err) {
        ctx.log.warn(`coolify recent activity not recorded: ${errorName(err)}`);
        continue;
      }
      if (!hostId) continue;
      const text = deployText(start);
      const key = `${hostId}\n${text}`;
      if (done.has(key)) continue;
      done.add(key);
      await record(ctx, hostId, "deploy", text);
    }
  };
}

export type DeployActivity = ReturnType<typeof createDeployActivity>;
