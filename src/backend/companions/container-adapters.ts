import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto, StorageDto } from "../coolify/dto.js";
import { ContainerError } from "../containers/service.js";
import { CompanionError, COMPANION_PLUGINS, missing } from "./detect.js";

// Container-level companion adapters: File Manager paths, Tunnels forwards
// and Reverse Proxy web endpoints for one Resource's container. Each call
// asks for the service at the time of the call (a companion can stop at any
// time) and sends only plain values: a host id, a name, an internal address
// and a port. Never a Coolify token, key or password.
//
// Termix's published references for these plugins name the services
// (tunnels.access 1.0.0, reverse-proxy.endpoints 1.0.0) but not their
// methods. The method names follow the design's "Companion plugins" section;
// a provider without them reads as companion-missing (fail closed).

// --- File Manager -----------------------------------------------------

/** Where Coolify keeps a Resource's files on its server. */
export interface DataPaths {
  dataDir: string;
  composeFile: string;
}

const KIND_DIR = {
  application: "applications",
  service: "services",
  database: "databases",
} as const;

/** The Coolify folder a Resource's storages and compose file belong to. */
export function storageOwner(
  res: ResourceDto,
): { kind: "application" | "service" | "database"; uuid: string } | null {
  if (res.kind === "service-application" || res.kind === "service-database") {
    return res.parentUuid ? { kind: "service", uuid: res.parentUuid } : null;
  }
  return { kind: res.kind, uuid: res.uuid };
}

/**
 * `/data/coolify/{applications,services,databases}/<uuid>` and the compose
 * file Coolify writes there: `docker-compose.yaml` for an application,
 * `docker-compose.yml` for a service or database (Coolify v4.7.5). A Part
 * lives in its service's folder.
 */
export function dataPaths(res: ResourceDto): DataPaths | null {
  const owner = storageOwner(res);
  if (!owner || !SAFE_SEGMENT.test(owner.uuid)) return null;
  const dataDir = `/data/coolify/${KIND_DIR[owner.kind]}/${owner.uuid}`;
  const file =
    owner.kind === "application" ? "docker-compose.yaml" : "docker-compose.yml";
  return { dataDir, composeFile: `${dataDir}/${file}` };
}

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,255}$/;
// No control characters (a path is shown and handed to File Manager as is).
const CONTROL = /[\u0000-\u001f\u007f]/;

function absolutePath(value: string | null): string | null {
  if (!value || value.length > 4096 || CONTROL.test(value)) return null;
  if (!value.startsWith("/")) return null;
  if (value.split("/").some((part) => part === "..")) return null;
  return value;
}

/**
 * Each storage's place on the server, for File Manager: a bind mount's or a
 * file storage's host path, or a named Docker volume's `_data` folder. A
 * container's own mount path isn't on the server, so it is never listed.
 */
export function storagePaths(storages: StorageDto[]): string[] {
  const out: string[] = [];
  for (const s of storages) {
    let path = absolutePath(s.hostPath);
    if (!path && s.kind === "volume" && s.name && SAFE_SEGMENT.test(s.name)) {
      path = `/var/lib/docker/volumes/${s.name}/_data`;
    }
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

// --- Container address ---------------------------------------------------

/** Prints each network's address of a container, space separated. */
export const INSPECT_FORMAT =
  "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}";

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function isIpv6(text: string): boolean {
  if (!/^[0-9a-f:]{2,39}$/i.test(text)) return false;
  const shortened = text.split("::").length - 1;
  if (shortened > 1) return false;
  const parts = text.split(":");
  const groups = parts.filter((g) => g !== "");
  if (groups.some((g) => g.length > 4)) return false;
  return shortened === 1
    ? groups.length <= 7
    : parts.length === 8 && groups.length === 8;
}

function isIp(text: string): boolean {
  return IPV4.test(text) || isIpv6(text);
}

/**
 * The container's first network address from `docker inspect`. Anything
 * that isn't an IP address (an empty answer, `<no value>`, a word) is
 * refused, so only a parsed address ever reaches a companion.
 */
export function parseContainerIp(stdout: string): string {
  const tokens = stdout.split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens.every(isIp)) {
    throw new ContainerError(
      "bad-container-ip",
      "The container has no address Termix can reach on its server.",
    );
  }
  return tokens[0]!;
}

// --- Companion services ------------------------------------------------

type Handle = Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * Another plugin's service, or companion-missing when it isn't offered or
 * lacks one of `methods`.
 */
async function service(
  ctx: PluginContext,
  name: string,
  methods: string[],
  plugin: string,
): Promise<Handle> {
  let handle: unknown;
  try {
    handle = await ctx.services.get<object>(name);
  } catch {
    throw missing(plugin);
  }
  const usable =
    !!handle &&
    (typeof handle === "object" || typeof handle === "function") &&
    methods.every(
      (m) => typeof (handle as Record<string, unknown>)[m] === "function",
    );
  if (!usable) throw missing(plugin);
  return handle as Handle;
}

/** Runs a companion call; any failure of its own is companion-failed. */
async function attempt<T>(plugin: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof CompanionError) throw err;
    throw new CompanionError("companion-failed", plugin);
  }
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// --- Tunnels -----------------------------------------------------------

const TUNNELS = COMPANION_PLUGINS.tunnels;

/** The forward's name in Tunnels: one per Linked host and Resource. */
export function tunnelName(hostId: number, uuid: string): string {
  return `web:${hostId}:coolify-${uuid}`;
}

export interface ForwardAnswer {
  bindHost: string;
  bindPort: number;
}

/** Throws companion-missing unless tunnels.access can forward and stop. */
export async function tunnelsAccess(ctx: PluginContext): Promise<Handle> {
  return service(ctx, "tunnels.access", ["forward", "stop"], TUNNELS);
}

/**
 * Forwards a port of the container through the Linked host, listening on the
 * Termix server's loopback, not saved in the person's Tunnels list.
 */
export async function openForward(
  tunnels: Handle,
  input: {
    hostId: number;
    name: string;
    targetHost: string;
    targetPort: number;
  },
): Promise<ForwardAnswer> {
  const answer = obj(
    await attempt(TUNNELS, () =>
      tunnels.forward!(input.hostId, {
        name: input.name,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        bindHost: "127.0.0.1",
        persist: false,
      }),
    ),
  );
  const bindPort = Number(answer.bindPort ?? answer.localPort ?? answer.port);
  if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) {
    throw new CompanionError("companion-failed", TUNNELS);
  }
  const bindHost =
    typeof answer.bindHost === "string" && answer.bindHost
      ? answer.bindHost
      : "127.0.0.1";
  return { bindHost, bindPort };
}

/** Stops the forward with that name. */
export async function closeForward(
  tunnels: Handle,
  name: string,
): Promise<void> {
  await attempt(TUNNELS, () => tunnels.stop!(name));
}

// --- Reverse Proxy -----------------------------------------------------

const REVERSE_PROXY = COMPANION_PLUGINS.reverseProxy;

/**
 * Throws companion-missing unless reverse-proxy.endpoints offers available()
 * and open(), and proxy-not-configured when available() is false.
 */
export async function proxyEndpoints(ctx: PluginContext): Promise<Handle> {
  const endpoints = await service(
    ctx,
    "reverse-proxy.endpoints",
    ["available", "open"],
    REVERSE_PROXY,
  );
  const ready = await attempt(REVERSE_PROXY, () => endpoints.available!());
  if (ready !== true) {
    throw new ContainerError(
      "proxy-not-configured",
      "Reverse Proxy can't open web pages yet. An admin sets its Termix address and Web endpoint domain (a wildcard DNS name pointing at the proxy) in Settings.",
    );
  }
  return endpoints;
}

/** A one-time signed-in URL to the container's HTTP port. */
export async function openWebEndpoint(
  endpoints: Handle,
  input: {
    hostId: number;
    host: string;
    port: number;
    scheme: "http" | "https";
  },
): Promise<string> {
  const answer = await attempt(REVERSE_PROXY, () =>
    endpoints.open!({
      hostId: input.hostId,
      target: { host: input.host, port: input.port, scheme: input.scheme },
    }),
  );
  const url = typeof answer === "string" ? answer : obj(answer).url;
  if (typeof url !== "string" || !/^https?:\/\/[^\s]+$/i.test(url)) {
    throw new CompanionError("companion-failed", REVERSE_PROXY);
  }
  return url;
}
