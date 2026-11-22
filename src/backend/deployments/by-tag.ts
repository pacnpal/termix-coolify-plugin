import type { DeployRow } from "../coolify/api.js";
import type { ResourceDto } from "../coolify/dto.js";
import { ConnectionError } from "../connections/service.js";

/** A Coolify tag name: no commas, since Coolify splits on them. */
const TAG = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,63}$/;
/** Coolify's own rule for a Docker image tag. */
const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const UUID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PR = 2_147_483_647;

/** What deploy by tag was asked for, checked. */
export interface TagDeployRequest {
  tag: string;
  force: boolean;
  /** A pull request's preview to deploy; services have none. */
  pullRequestId?: number;
  /** A Docker image tag for a Docker image preview; needs pullRequestId. */
  dockerTag?: string;
  /**
   * The uuids the person confirmed. When given, the run is refused unless
   * the tag still hits exactly these.
   */
  targets?: string[];
}

/** One resource deploy by tag will deploy. */
export interface TagTarget {
  uuid: string;
  name: string;
  kind: "application" | "service";
  serverName: string | null;
}

export interface TagTargets {
  tag: string;
  targets: TagTarget[];
  /** Services that carry the tag but are left out (a pull request was asked). */
  skippedServices: number;
}

export interface TagDeployResult extends TagTargets {
  deployments: DeployRow[];
}

/** The tag's targets changed between the confirm and the run. */
export class TargetsChangedError extends Error {
  readonly code = "targets-changed";
  readonly status = 409;

  constructor() {
    super(
      "The resources with this tag changed since they were confirmed. Review them again.",
    );
    this.name = "TargetsChangedError";
  }
}

const invalid = (message: string) =>
  new ConnectionError("invalid-input", message);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** A tag name from a query or an operation input, checked. */
export function readTag(value: unknown): string {
  const tag = text(value);
  if (!TAG.test(tag)) {
    throw invalid(
      "tag must be 1 to 64 letters, digits, spaces or _ . : / -, without commas",
    );
  }
  return tag;
}

/** A pull request id, or undefined when none was given. */
export function readPullRequest(value: unknown): number | undefined {
  if (!given(value)) return undefined;
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,10}$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PR) {
    throw invalid(`pullRequestId must be a whole number from 1 to ${MAX_PR}`);
  }
  return n;
}

/** Deploy by tag's whole input, checked before anything is read. */
export function readTagDeploy(
  input: Record<string, unknown>,
): TagDeployRequest {
  const tag = readTag(input.tag);
  const pullRequestId = readPullRequest(input.pullRequestId);
  let dockerTag: string | undefined;
  if (given(input.dockerTag)) {
    dockerTag = text(input.dockerTag);
    if (!DOCKER_TAG.test(dockerTag)) {
      throw invalid(
        "dockerTag must be letters, digits, _ . -, at most 128 characters",
      );
    }
    if (pullRequestId === undefined) {
      throw invalid("dockerTag needs pullRequestId");
    }
  }
  let targets: string[] | undefined;
  if (given(input.targets)) {
    const list = Array.isArray(input.targets)
      ? input.targets
      : text(input.targets).split(",");
    targets = list.map(text).filter(Boolean);
    if (!targets.length || targets.some((u) => !UUID.test(u))) {
      throw invalid("targets must be resource uuids");
    }
  }
  return {
    tag,
    force: input.force === true || input.force === "true",
    ...(pullRequestId === undefined ? {} : { pullRequestId }),
    ...(dockerTag === undefined ? {} : { dockerTag }),
    ...(targets ? { targets } : {}),
  };
}

/** A target row from one of the connection's own resources. */
export function toTarget(r: ResourceDto): TagTarget {
  return {
    uuid: r.uuid,
    name: r.name,
    kind: r.kind === "service" ? "service" : "application",
    serverName: r.serverName,
  };
}

/** Whether the confirmed uuids are exactly the targets found now. */
export function sameTargets(confirmed: string[], found: TagTarget[]): boolean {
  const a = [...new Set(confirmed)].sort();
  const b = found.map((t) => t.uuid).sort();
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

/** "Would deploy web (application) on vps1, n8n (service)…" for a dry run. */
export function describeTargets(found: TagTargets): string {
  if (!found.targets.length) {
    return `No resources on this connection have the tag ${found.tag}`;
  }
  const list = found.targets
    .map(
      (t) =>
        `${t.name} (${t.kind}${t.serverName ? ` on ${t.serverName}` : ""})`,
    )
    .join(", ");
  const skipped = found.skippedServices
    ? `; ${found.skippedServices} service${found.skippedServices === 1 ? "" : "s"} left out (no pull request previews)`
    : "";
  return `Would deploy ${found.targets.length} resource${found.targets.length === 1 ? "" : "s"} tagged ${found.tag}: ${list}${skipped}`;
}
