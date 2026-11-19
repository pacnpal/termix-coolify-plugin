import type { CoolifyApi } from "../coolify/api.js";
import type { ResourceDto } from "../coolify/dto.js";
import { CoolifyError } from "../coolify/http.js";

export type LifecycleVerb = "start" | "stop" | "restart" | "deploy";

export const LIFECYCLE_VERBS: readonly LifecycleVerb[] = [
  "start",
  "stop",
  "restart",
  "deploy",
];

/** What lifecycle needs to know about a resource to pick its endpoint. */
export type LifecycleTarget = Pick<ResourceDto, "uuid" | "kind" | "parentUuid">;

const isPart = (r: LifecycleTarget) =>
  r.kind === "service-application" || r.kind === "service-database";

/** Finds a uuid in the connection's per-type lists. Not found is a CoolifyError. */
async function find(api: CoolifyApi, uuid: string): Promise<LifecycleTarget> {
  const [applications, services, databases] = await Promise.all([
    api.applications(),
    api.services(),
    api.databases(),
  ]);
  const found = [...applications, ...services, ...databases].find(
    (r) => r.uuid === uuid,
  );
  if (!found) throw new CoolifyError("not-found", 404);
  return found;
}

/**
 * Starts, stops, restarts or deploys a resource or a service Part. A Part
 * starts, stops and restarts through its service's per-Part endpoint, and a
 * deploy of a Part deploys its service. Without `opts.resource` the uuid is
 * looked up in Coolify's lists first. Coolify failures (a 403 is
 * `forbidden-ability`) come through as the CoolifyError the request layer
 * made, unchanged.
 */
export async function lifecycle(
  api: CoolifyApi,
  uuid: string,
  action: LifecycleVerb,
  opts: { force?: boolean; resource?: LifecycleTarget } = {},
): Promise<{ deploymentUuid: string | null }> {
  const target =
    opts.resource && opts.resource.uuid === uuid
      ? opts.resource
      : await find(api, uuid);
  if (action === "deploy") {
    const deployUuid =
      isPart(target) && target.parentUuid ? target.parentUuid : target.uuid;
    const { deploymentUuids } = await api.deploy(deployUuid, {
      force: opts.force === true,
    });
    return { deploymentUuid: deploymentUuids[0] ?? null };
  }
  await api.lifecycle(target.kind, target.uuid, action, {
    parentUuid: target.parentUuid ?? undefined,
  });
  return { deploymentUuid: null };
}
