import type { PluginHostCreateInput } from "@termix-ssh/plugin-sdk/backend";
import type { ServerDto } from "../coolify/dto.js";
import { ConnectionError } from "../connections/service.js";

/** The tag every Linked host carries. */
export const LINKED_TAG = "coolify";

/**
 * The SSH Terminal plugin's host setting names for its Cloudflare tunnel.
 * Sync writes them on tunnelled Linked hosts, and SSH Terminal's transport
 * then carries every SSH connection to the host over the tunnel. These are
 * SSH Terminal's names, not ours: they must match its own settings.
 */
export const SSH_TERMINAL_KEYS = {
  enabled: "cloudflareTunnelEnabled",
  hostname: "cloudflareTunnelHostname",
  port: "cloudflareTunnelPort",
  clientId: "cloudflareTunnelClientId",
  clientSecret: "cloudflareTunnelClientSecret",
} as const;

/** The SSH Terminal plugin that carries tunnels, and what sync needs of it. */
export const SSH_TERMINAL = {
  id: "ssh-terminal",
  /** 1.0.3 tunnelled only its own terminal tab; 1.2.0 tunnels every SSH connection. */
  minVersion: "1.2.0",
  /** Cloudflare tunnels are reached on 443; the host's port is the origin's. */
  tunnelPort: 443,
} as const;

/** Whether SSH Terminal runs and at which version. Unknown means not running. */
export interface SshTerminalState {
  running: boolean;
  version: string | null;
}

export type PlanCause =
  | "needs-address"
  | "needs-ssh-terminal"
  | "ssh-terminal-too-old"
  | "needs-ssh-terminal-to-clear-tunnel";

// Both sides name both fields, so `cause` reads the same with or without
// strict null checks.
export type HostPlan =
  | { ok: true; input: PluginHostCreateInput; cause?: undefined }
  | { ok: false; cause: PlanCause; input?: undefined };

/** What planHost needs besides the server. Everything is already decided. */
export interface PlanContext {
  connectionId: number;
  connectionName: string;
  /** The connection's base URL, for the note linking back to Coolify. */
  baseUrl: string;
  /** The address entered for this server, or null. */
  override: string | null;
  credentialId: number;
  folder: string;
  /** Whether the Docker plugin runs, so its host switch can be turned on. */
  dockerRunning: boolean;
  /** SSH Terminal, which carries tunnels. Only tunnelled servers need it. */
  sshTerminal: SshTerminalState;
  /**
   * The connection's Cloudflare Access service token, written onto tunnelled
   * hosts only. Null when none is set, and always null for a preview.
   */
  cfAccess: { id: string; secret: string } | null;
  /**
   * Whether this sync wrote SSH Terminal's tunnel settings on the server's
   * current Linked host and hasn't cleared them since.
   */
  tunnelApplied: boolean;
}

const MAX_ADDRESS = 253;
// A host name, an IPv4 address or an IPv6 address: letters, digits, dots,
// dashes, underscores and colons, nothing that could carry a command or URL.
const ADDRESS = /^[A-Za-z0-9._:-]+$/;
const LOOPBACK = new Set(["host.docker.internal", "localhost", "::1"]);

function isLoopback(address: string): boolean {
  return LOOPBACK.has(address.toLowerCase()) || address.startsWith("127.");
}

/**
 * An address override as entered: undefined when absent (keep the stored
 * one), null when empty (clear it), or the trimmed address. Refuses anything
 * that isn't a plain host name or IP, and the loopback names an override is
 * meant to replace.
 */
export function cleanAddress(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ConnectionError("invalid-input", "addressOverride must be text");
  }
  const address = value.trim();
  if (!address) return null;
  if (
    address.length > MAX_ADDRESS ||
    !ADDRESS.test(address) ||
    isLoopback(address)
  ) {
    throw new ConnectionError(
      "invalid-input",
      "addressOverride must be a host name or IP address Termix can reach",
    );
  }
  return address;
}

/** "Coolify", or "Coolify / <name>" when the user has several connections. */
export function folderName(
  connectionName: string,
  connections: number,
): string {
  return connections > 1 ? `Coolify / ${connectionName}` : "Coolify";
}

/** major.minor.patch of a version, or null when it isn't one. */
function versionParts(
  version: string,
): { core: number[]; pre: boolean } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+.*)?$/.exec(
    version.trim(),
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] !== undefined,
  };
}

/**
 * Whether a version is at least `min` (a plain x.y.z), by semver order: a
 * pre-release of `min` is below it. Anything unreadable is below it.
 */
export function atLeast(version: string | null, min: string): boolean {
  const have = version ? versionParts(version) : null;
  const need = versionParts(min);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have.core[i] !== need.core[i]) return have.core[i] > need.core[i];
  }
  return !have.pre;
}

/**
 * The tunnel step: a tunnelled server is reached through SSH Terminal's
 * Cloudflare tunnel at the tunnel hostname, which is also the host address.
 * Refused while SSH Terminal 1.2.0 or newer isn't running.
 */
export function planTunnel(
  input: PluginHostCreateInput,
  ctx: PlanContext,
): HostPlan {
  if (!ctx.sshTerminal.running) {
    return { ok: false, cause: "needs-ssh-terminal" };
  }
  if (!atLeast(ctx.sshTerminal.version, SSH_TERMINAL.minVersion)) {
    return { ok: false, cause: "ssh-terminal-too-old" };
  }
  // A host update merges the keys it is given and keeps the rest, so a token
  // removed from the connection is written as empty, never left out.
  const tunnel: Record<string, unknown> = {
    [SSH_TERMINAL_KEYS.enabled]: true,
    [SSH_TERMINAL_KEYS.hostname]: input.ip,
    [SSH_TERMINAL_KEYS.port]: SSH_TERMINAL.tunnelPort,
    [SSH_TERMINAL_KEYS.clientId]: ctx.cfAccess?.id ?? "",
    [SSH_TERMINAL_KEYS.clientSecret]: ctx.cfAccess?.secret ?? "",
  };
  return {
    ok: true,
    input: {
      ...input,
      pluginSettings: {
        ...input.pluginSettings,
        [SSH_TERMINAL.id]: tunnel,
      },
    },
  };
}

/** The Termix host a Coolify server becomes, or why it can't become one yet. */
export function planHost(server: ServerDto, ctx: PlanContext): HostPlan {
  const ip = ctx.override ?? (server.isCoolifyHost ? null : server.ip);
  if (!ip || isLoopback(ip)) return { ok: false, cause: "needs-address" };

  const input: PluginHostCreateInput = {
    name: server.name || server.uuid,
    ip,
    port: server.port,
    username: server.user,
    authType: "credential",
    credentialId: ctx.credentialId,
    overrideCredentialUsername: true,
    folder: ctx.folder,
    tags: [LINKED_TAG],
    notes:
      `Managed by Coolify for Termix (connection "${ctx.connectionName}"). ` +
      `Coolify server: ${ctx.baseUrl}/server/${server.uuid}`,
    statusCheckEnabled: true,
    pluginSettings: {
      coolify: {
        coolifyConnectionId: String(ctx.connectionId),
        coolifyServerUuid: server.uuid,
      },
    },
    pluginEnable: ctx.dockerRunning
      ? { coolify: true, docker: true }
      : { coolify: true },
  };
  if (server.isTunnel) return planTunnel(input, ctx);
  // A host that never had tunnel settings needs nothing of SSH Terminal.
  if (!ctx.tunnelApplied) return { ok: true, input };
  // A Linked host keeps settings an update leaves out, so a host this sync
  // tunnelled before has its tunnel turned off and cleared, once. Core skips
  // settings for a plugin that isn't running, so without a running SSH
  // Terminal the host is left as it is rather than given a direct address
  // beside a stale tunnel. Only the tunnel keys are written.
  if (!ctx.sshTerminal.running) {
    return { ok: false, cause: "needs-ssh-terminal-to-clear-tunnel" };
  }
  input.pluginSettings = {
    ...input.pluginSettings,
    // SSH Terminal's tunnel switched off, its hostname and token cleared.
    [SSH_TERMINAL.id]: {
      [SSH_TERMINAL_KEYS.enabled]: false,
      [SSH_TERMINAL_KEYS.hostname]: "",
      [SSH_TERMINAL_KEYS.clientId]: "",
      [SSH_TERMINAL_KEYS.clientSecret]: "",
    },
  };
  return { ok: true, input };
}
