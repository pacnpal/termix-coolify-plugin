import type { PluginHostCreateInput } from "@termix-ssh/plugin-sdk/backend";
import type { ServerDto } from "../coolify/dto.js";
import { ConnectionError } from "../connections/service.js";

/** The tag every Linked host carries. */
export const LINKED_TAG = "coolify";

/**
 * Why a tunnelled server is refused for now. Ticket #9 replaces planTunnel
 * below with SSH Terminal's tunnel settings, and this cause with its own.
 */
export const TUNNEL_CAUSE = "needs-tunnel-support";

export type PlanCause = "needs-address" | typeof TUNNEL_CAUSE;

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

/**
 * The tunnel step. For now a tunnelled server is refused: ticket #9 replaces
 * this with SSH Terminal's tunnel settings on `input`.
 */
export function planTunnel(
  _server: ServerDto,
  _input: PluginHostCreateInput,
  _ctx: PlanContext,
): HostPlan {
  return { ok: false, cause: TUNNEL_CAUSE };
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
  return server.isTunnel ? planTunnel(server, input, ctx) : { ok: true, input };
}
