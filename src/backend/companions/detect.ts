import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/** The plugin id behind each companion feature. */
export const COMPANION_PLUGINS = {
  files: "file-manager",
  tunnels: "tunnels",
  reverseProxy: "reverse-proxy",
  dns: "dns",
  uptime: "uptime",
  logSearch: "log-search",
  packageManager: "package-manager",
  securityCenter: "security-center",
  hostMetrics: "host-metrics",
  databases: "databases",
  backups: "backups",
} as const;

export type CompanionKey = keyof typeof COMPANION_PLUGINS;
export type CompanionMap = Record<CompanionKey, boolean>;

const MAX_AGE_MS = 60_000;

// One cached answer per plugin context, so a disable and enable (a new ctx)
// starts fresh and nothing outlives the context it was read for.
const cached = new WeakMap<object, { at: number; map: CompanionMap }>();

function noneRunning(): CompanionMap {
  const map = {} as CompanionMap;
  for (const key of Object.keys(COMPANION_PLUGINS) as CompanionKey[]) {
    map[key] = false;
  }
  return map;
}

/**
 * Which companion plugins are installed and running, from ctx.plugins.list,
 * cached for 60 seconds. A list that can't be read counts every companion as
 * missing, so a feature hides rather than fails.
 */
export async function companions(ctx: PluginContext): Promise<CompanionMap> {
  const hit = cached.get(ctx);
  if (hit && Date.now() - hit.at < MAX_AGE_MS) return hit.map;
  const map = noneRunning();
  try {
    const active = new Set(
      (await ctx.plugins.list())
        .filter((p) => p.state === "active")
        .map((p) => p.id),
    );
    for (const key of Object.keys(COMPANION_PLUGINS) as CompanionKey[]) {
      map[key] = active.has(COMPANION_PLUGINS[key]);
    }
  } catch {
    // Read as none running.
  }
  cached.set(ctx, { at: Date.now(), map });
  return map;
}

export type CompanionErrorCode =
  // The plugin isn't running, or doesn't offer the service or action.
  | "companion-missing"
  // The plugin is running but failed, or answered nothing usable.
  | "companion-failed"
  // The DNS plugin has no zone for the name.
  | "no-dns-zone"
  // No DNS record with that id was made here for that resource.
  | "dns-record-not-found";

const STATUS: Record<CompanionErrorCode, 404 | 409 | 502> = {
  "companion-missing": 404,
  "companion-failed": 502,
  "no-dns-zone": 409,
  "dns-record-not-found": 404,
};

const MESSAGES: Record<CompanionErrorCode, (plugin: string) => string> = {
  "companion-missing": (p) => `The ${p} plugin is not installed or not running`,
  "companion-failed": (p) => `The ${p} plugin could not answer`,
  "no-dns-zone": () => "The DNS plugin has no zone for this name",
  "dns-record-not-found": () => "No DNS record made here has that id",
};

/**
 * A refusal or failure about a companion plugin. Routes answer it as
 * `{ error, cause, plugin }`; the message is fixed, never the companion's.
 */
export class CompanionError extends Error {
  readonly status: 404 | 409 | 502;
  readonly code: CompanionErrorCode;
  readonly plugin: string;

  constructor(code: CompanionErrorCode, plugin: string) {
    super(MESSAGES[code](plugin));
    this.name = "CompanionError";
    this.code = code;
    this.plugin = plugin;
    this.status = STATUS[code];
  }
}

export const missing = (plugin: string) =>
  new CompanionError("companion-missing", plugin);

/** Throws companion-missing unless the companion's plugin runs. */
export async function requireCompanion(
  ctx: PluginContext,
  key: CompanionKey,
): Promise<void> {
  if (!(await companions(ctx))[key]) {
    throw missing(COMPANION_PLUGINS[key]);
  }
}
