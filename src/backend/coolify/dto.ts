import { IMAGE_TAG } from "../../shared/image-tag.js";
// Strippers from Coolify payloads to the plugin's own DTOs. Each one picks the
// fields it needs by name, never with a spread, so a secret Coolify adds to a
// payload later can't ride along. Coolify returns fields its OpenAPI schema
// lacks and omits others, so every read tolerates a missing or odd value.

export interface PatchItem {
  package: string;
  newVersion: string;
  currentVersion: string;
  security: boolean;
  risk: "docker" | "kernel" | "system" | null;
}

export interface PatchStatus {
  /** Null when unknown: the check failed (`error`), so nothing is counted. */
  updates: number | null;
  security: number | null;
  rebootRequired: boolean | null;
  checkedAt: string | null;
  error: string | null;
  items: PatchItem[];
}

export interface ServerDto {
  uuid: string;
  name: string;
  ip: string;
  port: number;
  user: string;
  isTunnel: boolean;
  isCoolifyHost: boolean;
  reachable: boolean;
  usable: boolean;
  privateKeyId: number | null;
  hostKeyFingerprints: string[];
  patch: PatchStatus | null;
  metricsEnabled: boolean;
  sentinelEnabled: boolean;
  trafficEnabled: boolean;
}

export type ResourceKind =
  | "application"
  | "service"
  | "database"
  | "service-application"
  | "service-database";

export interface ResourceDto {
  uuid: string;
  id: number | null;
  name: string;
  kind: ResourceKind;
  status: string;
  serverUuid: string | null;
  /** The Coolify server's name, when the payload carries it. */
  serverName: string | null;
  projectName: string | null;
  environmentName: string | null;
  fqdns: string[];
  parentUuid: string | null;
  engine: string | null;
  lastDeployAt: string | null;
  /**
   * An application's build pack (nixpacks, static, dockerfile,
   * dockercompose, dockerimage and so on), which decides what a preview
   * needs; null for anything else.
   */
  buildPack: string | null;
}

export interface DeploymentDto {
  uuid: string;
  /** The application's uuid, or null when the answer doesn't name it. */
  resourceUuid: string | null;
  status: string;
  commit: string | null;
  commitMessage: string | null;
  /** The pull request a preview deployment is for; 0 when it isn't one. */
  pullRequestId: number;
  rollback: boolean;
  serverName: string | null;
  createdAt: string;
  updatedAt: string | null;
  finishedAt: string | null;
}

/** One service's domains on a Docker Compose preview. */
export interface ComposeDomainDto {
  name: string;
  domain: string | null;
}

/**
 * One pull request preview of an application. Coolify's domain port
 * overrides and anything else it sends are left out.
 */
export interface PreviewDto {
  pullRequestId: number;
  uuid: string;
  pullRequestUrl: string | null;
  gitType: string | null;
  /** The preview's containers, as Coolify reports a resource's status. */
  status: string;
  /** The public domains, portless, as Coolify lists them. */
  domains: string[];
  composeDomains: ComposeDomainDto[];
  /**
   * Coolify's internal port per portless domain URL (Docker Compose
   * services' domains included). A save sends ports inline and replaces
   * these, so an editor must start from the domains with them put back.
   */
  portOverrides: Record<string, number>;
  dockerTag: string | null;
  lastOnlineAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A Coolify team as the plugin keeps it. Ids are strings, so instanceKey reads the same everywhere. */
export interface TeamDto {
  id: string;
  name: string;
}

export interface ProjectDto {
  uuid: string;
  name: string;
  teamId: string | null;
}

/** A Coolify private key without its material: only whether this token could read it. */
export interface KeyDto {
  /** Coolify's numeric id, which a server's private_key_id points at. */
  id: number | null;
  uuid: string;
  name: string;
  fingerprint: string | null;
  privateKeyReadable: boolean;
}

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function strOrNull(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function boolOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return bool(value);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("[")) {
      try {
        return strings(JSON.parse(text));
      } catch {
        return [];
      }
    }
    return text ? [text] : [];
  }
  return list(value).filter((v): v is string => typeof v === "string");
}

const COOLIFY_HOST_IPS = new Set(["host.docker.internal", "localhost", "::1"]);

function isCoolifyHostIp(ip: string): boolean {
  return COOLIFY_HOST_IPS.has(ip) || ip.startsWith("127.");
}

const RISKS = new Set(["docker", "kernel", "system"]);

/** Coolify's patch_check_result, with its time and error, as a PatchStatus. */
export function toPatch(
  result: unknown,
  checkedAt: unknown,
  error: unknown,
): PatchStatus | null {
  const raw = result && typeof result === "object" ? obj(result) : null;
  const errorText = strOrNull(error);
  if (!raw && !errorText) return null;
  const items: PatchItem[] = list(raw?.updates).map((entry) => {
    const item = obj(entry);
    const risk = str(item.risk);
    return {
      package: str(item.package ?? item.name),
      newVersion: str(item.new_version ?? item.newVersion),
      currentVersion: str(item.current_version ?? item.currentVersion),
      security: bool(item.security),
      risk: RISKS.has(risk) ? (risk as PatchItem["risk"]) : null,
    };
  });
  const securityCount = items.filter((item) => item.security).length;
  // An explicit null means Coolify can't tell (pacman, apk), so the per-item
  // false flags don't make it zero. Only a result without the field counts.
  const securityKnown = raw !== null && "security_updates" in raw;
  // A check that failed counts nothing, whatever result is left from before:
  // unknown, never zero updates.
  if (errorText) {
    return {
      updates: null,
      security: null,
      rebootRequired: null,
      checkedAt: strOrNull(checkedAt),
      error: errorText,
      items: [],
    };
  }
  return {
    updates: num(raw?.total_updates) ?? items.length,
    security: securityKnown
      ? num(raw.security_updates)
      : items.length
        ? securityCount
        : null,
    rebootRequired: boolOrNull(raw?.reboot_required),
    checkedAt: strOrNull(checkedAt),
    error: errorText,
    items,
  };
}

export type TrafficIpMode = "full" | "anonymized" | "off";

/** A server's Sentinel settings without the token, push URL or GeoIP key. */
export interface SentinelSettingsDto {
  sentinelEnabled: boolean;
  metricsEnabled: boolean;
  historyDays: number | null;
  /** How Sentinel keeps client IPs; null when unknown (treated as hidden). */
  trafficIpMode: TrafficIpMode | null;
}

export function toSentinelSettings(input: unknown): SentinelSettingsDto {
  const raw = obj(input);
  const mode = raw.traffic_ip_mode;
  return {
    sentinelEnabled: bool(raw.is_sentinel_enabled),
    metricsEnabled: bool(raw.is_metrics_enabled),
    historyDays: num(raw.sentinel_metrics_history_days),
    trafficIpMode:
      mode === "full" || mode === "anonymized" || mode === "off" ? mode : null,
  };
}

export function toServer(input: unknown): ServerDto {
  const raw = obj(input);
  const settings = obj(raw.settings);
  const ip = str(raw.ip);
  return {
    uuid: str(raw.uuid),
    name: str(raw.name),
    ip,
    port: num(raw.port) ?? 22,
    user: str(raw.user, "root"),
    isTunnel: bool(settings.is_cloudflare_tunnel),
    isCoolifyHost: bool(raw.is_coolify_host) || isCoolifyHostIp(ip),
    reachable: bool(settings.is_reachable),
    usable: bool(settings.is_usable),
    privateKeyId: num(raw.private_key_id),
    hostKeyFingerprints: strings(settings.ssh_host_key_fingerprints),
    patch: toPatch(
      settings.patch_check_result ?? raw.patch_check_result,
      settings.patch_checked_at ?? raw.patch_checked_at,
      settings.patch_check_error ?? raw.patch_check_error,
    ),
    metricsEnabled: bool(settings.is_metrics_enabled),
    sentinelEnabled: bool(settings.is_sentinel_enabled),
    trafficEnabled: bool(settings.is_traffic_analytics_enabled),
  };
}

function fqdns(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function serverUuidOf(raw: Raw): string | null {
  return (
    strOrNull(raw.server_uuid) ??
    strOrNull(obj(raw.server).uuid) ??
    strOrNull(obj(obj(raw.destination).server).uuid)
  );
}

function serverNameOf(raw: Raw): string | null {
  return (
    strOrNull(obj(raw.server).name) ??
    strOrNull(obj(obj(raw.destination).server).name)
  );
}

function placeOf(raw: Raw): {
  projectName: string | null;
  environmentName: string | null;
} {
  const environment = obj(raw.environment);
  return {
    projectName:
      strOrNull(obj(environment.project).name) ?? strOrNull(raw.project_name),
    environmentName:
      strOrNull(environment.name) ?? strOrNull(raw.environment_name),
  };
}

/** Fields a stripper sets from outside the raw object, or reads differently. */
type ResourceExtra = Partial<
  Pick<
    ResourceDto,
    | "serverUuid"
    | "serverName"
    | "projectName"
    | "environmentName"
    | "fqdns"
    | "parentUuid"
    | "engine"
    | "lastDeployAt"
    | "buildPack"
  >
>;

/** Picks each field by name; nothing from `raw` or `extra` is spread. */
function resource(
  raw: Raw,
  kind: ResourceKind,
  extra: ResourceExtra = {},
): ResourceDto {
  const place = placeOf(raw);
  return {
    uuid: str(raw.uuid),
    id: num(raw.id),
    name: str(raw.name),
    kind,
    status: str(raw.status, "unknown"),
    serverUuid:
      extra.serverUuid !== undefined ? extra.serverUuid : serverUuidOf(raw),
    serverName:
      extra.serverName !== undefined ? extra.serverName : serverNameOf(raw),
    projectName:
      extra.projectName !== undefined ? extra.projectName : place.projectName,
    environmentName:
      extra.environmentName !== undefined
        ? extra.environmentName
        : place.environmentName,
    fqdns: extra.fqdns ?? [],
    parentUuid: extra.parentUuid ?? null,
    engine: extra.engine ?? null,
    lastDeployAt: extra.lastDeployAt ?? null,
    buildPack: extra.buildPack ?? null,
  };
}

export function toApplication(input: unknown): ResourceDto {
  const raw = obj(input);
  return resource(raw, "application", {
    fqdns: fqdns(raw.fqdn),
    lastDeployAt: strOrNull(raw.last_deployment_at),
    buildPack: strOrNull(raw.build_pack),
  });
}

export function toDatabase(input: unknown): ResourceDto {
  const raw = obj(input);
  return resource(raw, "database", {
    engine: strOrNull(raw.database_type),
  });
}

/** The service, then each of its Parts with parentUuid set. */
export function toService(input: unknown): ResourceDto[] {
  const raw = obj(input);
  const service = resource(raw, "service");
  const inherit = (more: ResourceExtra): ResourceExtra => ({
    parentUuid: service.uuid,
    serverUuid: service.serverUuid,
    serverName: service.serverName,
    projectName: service.projectName,
    environmentName: service.environmentName,
    fqdns: more.fqdns,
    engine: more.engine,
  });
  const apps = list(raw.applications).map((part) => {
    const p = obj(part);
    return resource(
      p,
      "service-application",
      inherit({ fqdns: fqdns(p.fqdn) }),
    );
  });
  const dbs = list(raw.databases).map((part) => {
    const p = obj(part);
    return resource(
      p,
      "service-database",
      inherit({ engine: strOrNull(p.image) }),
    );
  });
  return [service, ...apps, ...dbs];
}

/** One Part read on its own, with the service it belongs to. */
export function toPart(
  input: unknown,
  kind: "service-application" | "service-database",
  parentUuid: string,
): ResourceDto {
  const raw = obj(input);
  return kind === "service-application"
    ? resource(raw, kind, { parentUuid, fqdns: fqdns(raw.fqdn) })
    : resource(raw, kind, { parentUuid, engine: strOrNull(raw.image) });
}

const DEPLOYMENT_LINK =
  /\/application\/([A-Za-z0-9_-]{1,64})\/deployment\/([A-Za-z0-9_-]{1,64})$/;

/**
 * The application's uuid in a deployment's link (`deployment_url`, like
 * `/project/…/application/<app uuid>/deployment/<deployment uuid>`), when
 * the link is to this same deployment.
 */
function applicationOfLink(link: unknown, uuid: string): string | null {
  if (typeof link !== "string") return null;
  const match = DEPLOYMENT_LINK.exec(link.split(/[?#]/)[0] ?? "");
  return match && match[2] === uuid ? match[1] : null;
}

/**
 * One deployment, without its build log. `appUuid` is the application it
 * was listed for, when known. `application_id` is a database id, never a
 * uuid, so it is not used; Coolify's answer for one deployment names its
 * application only in its link.
 */
export function toDeployment(input: unknown, appUuid?: string): DeploymentDto {
  const raw = obj(input);
  const uuid = str(raw.deployment_uuid ?? raw.uuid);
  return {
    uuid,
    resourceUuid:
      strOrNull(raw.application_uuid) ??
      applicationOfLink(raw.deployment_url, uuid) ??
      appUuid ??
      null,
    status: str(raw.status, "unknown"),
    commit: strOrNull(raw.commit),
    commitMessage: strOrNull(raw.commit_message),
    pullRequestId: num(raw.pull_request_id) ?? 0,
    rollback: bool(raw.rollback),
    serverName: strOrNull(raw.server_name),
    createdAt: str(raw.created_at),
    updatedAt: strOrNull(raw.updated_at),
    finishedAt: strOrNull(raw.finished_at),
  };
}

/**
 * A deployment's raw build log (Coolify's JSON lines in one string), or null
 * when the answer has none: Coolify leaves it out for a token without
 * read:sensitive. It holds secrets: deployments/log.ts redacts it before it
 * goes anywhere.
 */
export function toDeploymentLog(input: unknown): string | null {
  const logs = obj(input).logs;
  return typeof logs === "string" ? logs : null;
}

/** Coolify's port overrides: only whole ports from 1 to 65535 are kept. */
function portOverridesOf(value: unknown): Record<string, number> {
  const entries: [string, number][] = [];
  for (const [domain, port] of Object.entries(obj(value))) {
    const n = num(port);
    if (n !== null && Number.isInteger(n) && n >= 1 && n <= 65_535) {
      entries.push([domain, n]);
    }
  }
  return Object.fromEntries(entries);
}

/** One pull request preview, as `GET /applications/{uuid}/previews` lists it. */
export function toPreview(input: unknown): PreviewDto {
  const raw = obj(input);
  return {
    pullRequestId: num(raw.pull_request_id) ?? 0,
    uuid: str(raw.uuid),
    pullRequestUrl: strOrNull(raw.pull_request_html_url),
    gitType: strOrNull(raw.git_type),
    status: str(raw.status, "unknown"),
    domains: fqdns(raw.domains ?? raw.fqdn),
    composeDomains: list(raw.docker_compose_domains)
      .map(obj)
      .filter((d) => typeof d.name === "string" && d.name !== "")
      .map((d) => ({ name: str(d.name), domain: strOrNull(d.domain) })),
    portOverrides: portOverridesOf(raw.domain_port_overrides),
    dockerTag: strOrNull(raw.docker_registry_image_tag),
    lastOnlineAt: strOrNull(raw.last_online_at),
    createdAt: strOrNull(raw.created_at),
    updatedAt: strOrNull(raw.updated_at),
  };
}

/** One image an application can be rolled back to. */
export interface RollbackImageDto {
  /** The image tag (a commit for a built app); what a rollback is sent. */
  tag: string;
  createdAt: string | null;
  /** The image the application runs now. */
  current: boolean;
  /** On the server (`local`) or in the Docker registry (`registry`). */
  source: "local" | "registry" | null;
}

export interface RollbackImagesDto {
  /** The tag running now, or null when nothing is. */
  current: string | null;
  images: RollbackImageDto[];
}

/** A Docker image tag: what Coolify lists and what a rollback may name. */
export { IMAGE_TAG };

/**
 * An application's rollback images, in Coolify's order. Rows without a
 * valid tag are dropped; `current` is kept only when it is a valid tag.
 */
export function toRollbackImages(input: unknown): RollbackImagesDto {
  const raw = obj(input);
  const images: RollbackImageDto[] = [];
  for (const item of list(raw.images)) {
    const row = obj(item);
    const tag = str(row.tag);
    if (!IMAGE_TAG.test(tag)) continue;
    images.push({
      tag,
      createdAt: strOrNull(row.created_at),
      current: bool(row.is_current),
      source:
        row.source === "local" || row.source === "registry" ? row.source : null,
    });
  }
  const current = strOrNull(raw.current);
  return {
    current: current && IMAGE_TAG.test(current) ? current : null,
    images,
  };
}

export function toTeam(input: unknown): TeamDto {
  const raw = obj(input);
  return { id: str(raw.id), name: str(raw.name) };
}

export function toProject(input: unknown): ProjectDto {
  const raw = obj(input);
  return {
    uuid: str(raw.uuid),
    name: str(raw.name),
    teamId: strOrNull(raw.team_id),
  };
}

/** Reads whether the key material came back, then drops it. */
export function toKey(input: unknown): KeyDto {
  const raw = obj(input);
  const material = raw.private_key;
  return {
    id: num(raw.id),
    uuid: str(raw.uuid),
    name: str(raw.name),
    fingerprint: strOrNull(raw.fingerprint),
    privateKeyReadable: typeof material === "string" && material.trim() !== "",
  };
}

/**
 * A resource's storage as Coolify's storages list gives it: a Docker volume
 * (persistent storage) or a file or folder mounted from the server. Never a
 * file storage's content.
 */
export interface StorageDto {
  kind: "volume" | "file";
  /** The Docker volume's name, for a volume. */
  name: string | null;
  /** Where it is mounted inside the container. */
  mountPath: string | null;
  /** Where it is on the server, when Coolify says (a bind mount or a file). */
  hostPath: string | null;
}

/** `{ persistent_storages, file_storages }` as StorageDtos. */
export function toStorages(input: unknown): StorageDto[] {
  const raw = obj(input);
  const volumes = list(raw.persistent_storages).map((entry): StorageDto => {
    const item = obj(entry);
    return {
      kind: "volume",
      name: strOrNull(item.name),
      mountPath: strOrNull(item.mount_path),
      hostPath: strOrNull(item.host_path),
    };
  });
  const files = list(raw.file_storages).map((entry): StorageDto => {
    const item = obj(entry);
    return {
      kind: "file",
      name: null,
      mountPath: strOrNull(item.mount_path),
      hostPath: strOrNull(item.fs_path),
    };
  });
  return [...volumes, ...files];
}

/** Coolify's security statuses from image scanning. */
export const SECURITY_STATUSES = [
  "update_now",
  "update_available",
  "no_fix",
  "check_needed",
  "ok",
  "not_checked",
] as const;
export type SecurityStatus = (typeof SECURITY_STATUSES)[number];

/**
 * One row of Coolify's `/vulnerabilities`: the resource's security status
 * and its problem counts. Names, labels, actions and image references are
 * left out: the summary built from it carries counts only.
 */
export interface VulnerabilityDto {
  uuid: string;
  /** An unknown or missing status reads as not checked. */
  status: SecurityStatus;
  problems: number;
  critical: number;
  high: number;
  medium: number;
  exploited: number;
}

const count = (value: unknown) => {
  const n = num(value);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export function toVulnerability(input: unknown): VulnerabilityDto {
  const raw = obj(input);
  const security = obj(raw.security);
  const status = SECURITY_STATUSES.find((s) => s === security.status);
  return {
    uuid: str(raw.uuid),
    status: status ?? "not_checked",
    problems: count(security.problem_count),
    critical: count(security.critical_count),
    high: count(security.high_count),
    medium: count(security.medium_count),
    exploited: count(security.exploited_count),
  };
}
