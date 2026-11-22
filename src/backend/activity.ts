import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import en from "../../locales/en.json";
import { ACTIVITY_TYPES, type ActivityKind } from "../shared/activity.js";
import type { Sync } from "./sync/service.js";

function errorName(err: unknown): string {
  return (err as Error)?.name ?? "error";
}

/**
 * Fills `{{key}}` placeholders in one pass. A callback, so `$&`, `$1` or a
 * placeholder inside an inserted value is kept as it is, never read again.
 */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : match,
  );
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
  await record(ctx, hostId, "shell", fill(en.activity.shell, { name }));
}

/** One resource a deploy path asked Coolify to deploy, and Coolify's answer. */
export interface DeployStart {
  /** The resource's uuid: one entry per resource, whatever its name. */
  uuid: string;
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
  return start.pullRequestId === undefined
    ? fill(en.activity.deploy, { name: start.name })
    : fill(en.activity.deployPreview, {
        name: start.name,
        pullRequestId: start.pullRequestId,
      });
}

/**
 * The one post-start hook every deploy path calls (lifecycle, deploy by
 * tag, rollback and previews) once Coolify accepted the request, whatever
 * the deployment's outcome later: "Deployed <name>" in the actor's recent
 * activity, once per resource (host, kind and uuid) Coolify started, on its
 * Linked host. Resources with no Linked host, or one the actor can't
 * connect to, get none. Never throws.
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
      const key = `${hostId}:${start.kind}:${start.uuid}`;
      if (done.has(key)) continue;
      done.add(key);
      await record(ctx, hostId, "deploy", deployText(start));
    }
  };
}

export type DeployActivity = ReturnType<typeof createDeployActivity>;
