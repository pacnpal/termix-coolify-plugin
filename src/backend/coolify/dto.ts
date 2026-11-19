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
  updates: number;
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
}

export interface DeploymentDto {
  uuid: string;
  resourceUuid: string;
  status: string;
  commit: string | null;
  createdAt: string;
  finishedAt: string | null;
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
  return {
    updates: num(raw?.total_updates) ?? items.length,
    security:
      num(raw?.security_updates) ?? (items.length ? securityCount : null),
    rebootRequired: boolOrNull(raw?.reboot_required),
    checkedAt: strOrNull(checkedAt),
    error: errorText,
    items,
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

function resource(
  raw: Raw,
  kind: ResourceKind,
  extra: Partial<ResourceDto> = {},
): ResourceDto {
  return {
    uuid: str(raw.uuid),
    id: num(raw.id),
    name: str(raw.name),
    kind,
    status: str(raw.status, "unknown"),
    serverUuid: serverUuidOf(raw),
    serverName: serverNameOf(raw),
    ...placeOf(raw),
    fqdns: [],
    parentUuid: null,
    engine: null,
    lastDeployAt: null,
    ...extra,
  };
}

export function toApplication(input: unknown): ResourceDto {
  const raw = obj(input);
  return resource(raw, "application", {
    fqdns: fqdns(raw.fqdn),
    lastDeployAt: strOrNull(raw.last_deployment_at),
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
  const inherit = {
    parentUuid: service.uuid,
    serverUuid: service.serverUuid,
    serverName: service.serverName,
    projectName: service.projectName,
    environmentName: service.environmentName,
  };
  const apps = list(raw.applications).map((part) => {
    const p = obj(part);
    return resource(p, "service-application", {
      ...inherit,
      fqdns: fqdns(p.fqdn),
    });
  });
  const dbs = list(raw.databases).map((part) => {
    const p = obj(part);
    return resource(p, "service-database", {
      ...inherit,
      engine: strOrNull(p.image),
    });
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

export function toDeployment(input: unknown): DeploymentDto {
  const raw = obj(input);
  return {
    uuid: str(raw.deployment_uuid ?? raw.uuid),
    resourceUuid: str(raw.application_uuid ?? raw.application_id),
    status: str(raw.status, "unknown"),
    commit: strOrNull(raw.commit),
    createdAt: str(raw.created_at),
    finishedAt: strOrNull(raw.finished_at),
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
