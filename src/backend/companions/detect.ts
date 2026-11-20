import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { COMPANION_PLUGINS, activePlugins } from "../plugins.js";

export { COMPANION_PLUGINS };

export type CompanionKey = keyof typeof COMPANION_PLUGINS;
export type CompanionMap = Record<CompanionKey, boolean>;

export type CompanionErrorCode =
  // The plugin isn't running, or doesn't offer the service or action.
  | "companion-missing"
  // The plugin is running but failed, or answered nothing usable.
  | "companion-failed"
  // Termix's plugin list can't be read, so whether a plugin runs is unknown.
  | "companions-unknown"
  // The DNS plugin has no zone for the name.
  | "no-dns-zone"
  // No DNS record with that id was made here for that resource.
  | "dns-record-not-found";

const STATUS: Record<CompanionErrorCode, 404 | 409 | 502> = {
  "companion-missing": 404,
  "companion-failed": 502,
  "companions-unknown": 409,
  "no-dns-zone": 409,
  "dns-record-not-found": 404,
};

const MESSAGES: Record<CompanionErrorCode, (plugin: string) => string> = {
  "companion-missing": (p) => `The ${p} plugin is not installed or not running`,
  "companion-failed": (p) => `The ${p} plugin could not answer`,
  "companions-unknown": () =>
    "Termix's plugin list could not be read, so nothing ran. Try again.",
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

/**
 * Which companion plugins are installed and running, read fresh through the
 * shared `activePlugins`, as sync and updates read it. A list that can't be
 * read is companions-unknown, never "none running".
 */
export async function companions(ctx: PluginContext): Promise<CompanionMap> {
  const active = await activePlugins(ctx);
  if (!active) throw new CompanionError("companions-unknown", "termix");
  const map = {} as CompanionMap;
  for (const key of Object.keys(COMPANION_PLUGINS) as CompanionKey[]) {
    map[key] = active.has(COMPANION_PLUGINS[key]);
  }
  return map;
}

/** Throws companion-missing unless the companion's plugin runs. */
export async function requireCompanion(
  ctx: PluginContext,
  key: CompanionKey,
): Promise<void> {
  if (!(await companions(ctx))[key]) {
    throw missing(COMPANION_PLUGINS[key]);
  }
}
