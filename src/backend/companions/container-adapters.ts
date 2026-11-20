import { posix } from "node:path";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto, StorageDto } from "../coolify/dto.js";
import { CompanionError, COMPANION_PLUGINS, missing } from "./detect.js";

// Container-level companion adapters: File Manager paths, Tunnels forwards
// and Reverse Proxy web endpoints for one Resource's container. Each call
// asks for the service at the time of the call (a companion can stop at any
// time) and sends only plain values: a host id, a name, an internal address
// and a port. Never a Coolify or Termix token, key or password.
//
// Unlike adapters.ts, these call services: Tunnels and Reverse Proxy publish
// no action that forwards a port or opens a web endpoint, only the services
// tunnels.access 1.0.0 and reverse-proxy.endpoints 1.0.0. Their published
// references name no methods; the calls here are checked against the
// providers' source (Plugin-Tunnels and Plugin-Reverse-Proxy,
// src/backend/service.ts):
// - tunnels.access.forward(sourceHostId, { targetHost, targetPort, bindHost?,
//   bindPort? }, { name?, idleTimeoutMs? }) answers { bindHost, bindPort,
//   close() }. The name must be "web:<sourceHostId>:<id>". Tunnels checks the
//   actor's host connect access itself. close() is a function and may not
//   cross the process boundary, so the forward is stopped with stop(name),
//   which holds off retries until the next forward of that name.
// - reverse-proxy.endpoints.available() and open({ hostId, target: { host,
//   port, scheme, ignoreCert? } }) answering { url }.
// A provider without these methods reads as companion-missing (fail closed).

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

/** The one root Coolify keeps resource folders under. */
export const COOLIFY_ROOT = "/data/coolify";

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/** The Coolify folder a Resource's storages and compose file belong to. */
export function storageOwner(
  res: ResourceDto,
): { kind: "application" | "service" | "database"; uuid: string } | null {
  const owner =
    res.kind === "service-application" || res.kind === "service-database"
      ? res.parentUuid
        ? { kind: "service" as const, uuid: res.parentUuid }
        : null
      : { kind: res.kind, uuid: res.uuid };
  return owner && UUID.test(owner.uuid) ? owner : null;
}

/**
 * `/data/coolify/{applications,services,databases}/<uuid>` and the compose
 * file Coolify writes there: `docker-compose.yaml` for an application,
 * `docker-compose.yml` for a service or database (Coolify v4.7.5). A Part
 * lives in its service's folder. Built only from this fixed template and a
 * uuid that passed the uuid check.
 */
export function dataPaths(res: ResourceDto): DataPaths | null {
  const owner = storageOwner(res);
  if (!owner) return null;
  const dataDir = `${COOLIFY_ROOT}/${KIND_DIR[owner.kind]}/${owner.uuid}`;
  const file =
    owner.kind === "application" ? "docker-compose.yaml" : "docker-compose.yml";
  return { dataDir, composeFile: `${dataDir}/${file}` };
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
// No control characters (a path is shown and handed to File Manager as is).
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * An absolute server path Coolify reported, normalized. Refused: relative,
 * any `..` segment, control characters, over 4096 characters, or `/`.
 */
function normalized(value: string | null): string | null {
  if (!value || value.length > 4096 || CONTROL.test(value)) return null;
  if (!value.startsWith("/")) return null;
  if (value.split("/").some((part) => part === "..")) return null;
  const path = posix.normalize(value).replace(/\/+$/, "");
  return path === "" ? null : path;
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Each storage's place on the server, for File Manager:
 * - a file storage's host path, only inside the resource's own data folder
 *   (Coolify writes them there);
 * - a volume's host path (a bind mount), anywhere but `/`, since Coolify
 *   reports it as that resource's volume;
 * - else a named Docker volume's `_data` folder.
 * A container's own mount path isn't on the server, so it is never listed.
 */
export function storagePaths(
  storages: StorageDto[],
  dataDir: string,
): string[] {
  const out: string[] = [];
  for (const s of storages) {
    let path = normalized(s.hostPath);
    if (path && s.kind === "file" && !under(path, dataDir)) path = null;
    if (!path && s.kind === "volume" && s.name && VOLUME_NAME.test(s.name)) {
      path = `/var/lib/docker/volumes/${s.name}/_data`;
    }
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

// --- Container address ---------------------------------------------------

/**
 * Prints each network's IPv4 (`IPAddress`) and IPv6 (`GlobalIPv6Address`)
 * address of a container, space separated; an empty one prints nothing.
 */
export const INSPECT_FORMAT =
  "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}";

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A full IPv6 address, normalized by the WHATWG URL parser, or null. */
function ipv6(text: string): string | null {
  if (!/^[0-9a-f:.]{2,45}$/i.test(text) || !text.includes(":")) return null;
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * Whether an address is one a container gets on a Docker network: IPv4
 * 10/8, 172.16/12 or 192.168/16, or IPv6 unique local (fc00::/7). Refused:
 * unspecified (0.0.0.0, ::), loopback, link-local (169.254/16 with cloud
 * metadata, fe80::/10), multicast, broadcast, and every public address.
 */
export function isContainerIp(text: string): boolean {
  if (IPV4.test(text)) {
    const [a, b] = text.split(".").map(Number) as [number, number];
    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  const v6 = ipv6(text);
  return v6 !== null && /^f[cd][0-9a-f]{0,2}:/i.test(v6);
}

export class BadContainerIp extends Error {
  constructor() {
    super("The container has no private address Termix can reach.");
    this.name = "BadContainerIp";
  }
}

/**
 * The container's first private network address from `docker inspect`.
 * Anything that isn't an IP address (an empty answer, `<no value>`, a word)
 * refuses the whole answer; addresses that aren't private container ones
 * are skipped. Only a parsed, private address ever reaches a companion.
 */
export function parseContainerIp(stdout: string): string {
  const tokens = stdout.split(/\s+/).filter(Boolean);
  if (!tokens.every((t) => IPV4.test(t) || ipv6(t) !== null)) {
    throw new BadContainerIp();
  }
  // IPv4 first; an IPv6 one is passed without brackets, as Tunnels takes it.
  const found =
    tokens.find((t) => IPV4.test(t) && isContainerIp(t)) ??
    tokens.find(isContainerIp);
  if (!found) throw new BadContainerIp();
  return IPV4.test(found) ? found : ipv6(found)!;
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
  } catch {
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

/**
 * The forward's name in Tunnels: one per Linked host and Resource. The uuid
 * passed the uuid check (no `:`), so a name parses back to one host and uuid.
 */
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
 * Forwards a port of the container through the Linked host, asking for a
 * listener on the Termix server's 127.0.0.1, not saved in the person's
 * Tunnels list. Tunnels decides where it really listens; its answer is
 * passed on as it is.
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
      tunnels.forward!(
        input.hostId,
        {
          targetHost: input.targetHost,
          targetPort: input.targetPort,
          bindHost: "127.0.0.1",
        },
        { name: input.name },
      ),
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
 * reverse-proxy.endpoints with available() and open(), or companion-missing;
 * `ready` is what available() answered.
 */
export async function proxyEndpoints(
  ctx: PluginContext,
): Promise<{ endpoints: Handle; ready: boolean }> {
  const endpoints = await service(
    ctx,
    "reverse-proxy.endpoints",
    ["available", "open"],
    REVERSE_PROXY,
  );
  const ready = await attempt(REVERSE_PROXY, () => endpoints.available!());
  return { endpoints, ready: ready === true };
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
