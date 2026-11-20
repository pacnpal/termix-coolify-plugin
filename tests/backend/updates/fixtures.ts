import { vi } from "vitest";
import type { PluginOperationOutcome } from "@termix-ssh/plugin-sdk/backend";
import { PLATFORM_PROBE_COMMAND } from "@termix-ssh/plugin-sdk/host-commands";
import type { PluginHarness } from "../helpers/plugin.js";
import {
  WEB1,
  server,
  startWithConnection,
  syncCoolify,
} from "../sync/fixtures.js";

/** web-1 as Coolify reports it, with its last patch check. */
export const WEB1_PATCHED = server(
  "srv-web1",
  "web-1",
  "203.0.113.11",
  {},
  {
    patch_check_result: {
      osId: "ubuntu",
      package_manager: "apt",
      total_updates: 3,
      security_updates: 1,
      reboot_required: true,
      updates: [
        {
          package: "docker-ce",
          new_version: "5:27.0.1",
          current_version: "5:26.1.0",
          security: false,
          risk: "docker",
        },
        {
          package: "openssl",
          new_version: "3.0.2-0ubuntu1.18",
          current_version: "3.0.2-0ubuntu1.17",
          security: true,
          risk: null,
        },
        {
          package: "linux-image-generic",
          new_version: "5.15.0.130",
          current_version: "5.15.0.125",
          security: false,
          risk: "kernel",
        },
      ],
    },
    patch_checked_at: "2026-11-18T10:00:00.000000Z",
    patch_check_error: null,
  },
);

/** What `apt list --upgradable` prints on web-1. */
export const APT_LIST = [
  "docker-ce/jammy 5:27.0.1-1~ubuntu.22.04~jammy amd64 [upgradable from: 5:26.1.0-1~ubuntu.22.04~jammy]",
  "containerd.io/jammy 1.7.20-1 amd64 [upgradable from: 1.7.19-1]",
  "openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.17]",
  "linux-image-generic/jammy-updates 5.15.0.130 amd64 [upgradable from: 5.15.0.125]",
  "curl/jammy-updates 7.81.0-1ubuntu1.20 amd64 [upgradable from: 7.81.0-1ubuntu1.19]",
].join("\n");

const PROBE_APT = [
  "systemd=1",
  "apt=1",
  "dnf=0",
  "yum=0",
  "pacman=0",
  "certbot=0",
  "acmesh=0",
  "docker=1",
  "os=Ubuntu 22.04.5 LTS",
].join("\n");

export interface SshCall {
  host: unknown;
  command: string;
  options: Record<string, unknown> | undefined;
}

function result(stdout: string, code = 0, stderr = "") {
  return { stdout, stderr, code, truncated: false, timedOut: false };
}

/**
 * Replaces ctx.ssh.exec with a fake Ubuntu server: it answers the platform
 * probe, the update check, the upgrade and the reboot, and records each
 * command it was sent.
 */
export function fakeSsh(
  h: PluginHarness,
  options: { sudoRefused?: boolean; probe?: string } = {},
) {
  const calls: SshCall[] = [];
  const exec = vi
    .spyOn(h.mock.ctx.ssh, "exec")
    .mockImplementation(async (host, command, execOptions) => {
      calls.push({
        host,
        command,
        options: execOptions as Record<string, unknown> | undefined,
      });
      if (command === PLATFORM_PROBE_COMMAND) {
        return result(options.probe ?? PROBE_APT);
      }
      if (options.sudoRefused) {
        return result("", 1, "sudo: a password is required");
      }
      if (command.includes("apt list --upgradable")) {
        return result(
          `__COOLIFY_LIST__\n${APT_LIST}\n__COOLIFY_REBOOT__\nREBOOT=yes\n`,
        );
      }
      if (command.includes("apt-get -y upgrade")) {
        return result("Setting up docker-ce (5:27.0.1) ...\n");
      }
      if (command.includes("systemctl reboot")) return result("");
      return result("", 127, "not found");
    });
  return { calls, exec };
}

/** Replaces ctx.operations.invoke with a fake Package Manager plugin. */
export function fakePackageManager(h: PluginHarness) {
  return vi
    .spyOn(h.mock.ctx.operations, "invoke")
    .mockImplementation(
      async (actionId, options): Promise<PluginOperationOutcome> => {
        if (actionId === "package-manager.list-updates") {
          return {
            runId: "run-list",
            status: "success",
            summary: "3 updates",
            data: {
              rows: [
                {
                  name: "docker-ce",
                  state: "update",
                  current: "5:26.1.0",
                  available: "5:27.0.1",
                  repo: "jammy",
                },
                {
                  name: "openssl",
                  state: "security",
                  current: "3.0.2-0ubuntu1.17",
                  available: "3.0.2-0ubuntu1.18",
                  repo: "jammy-security",
                },
                {
                  name: "curl",
                  state: "update",
                  current: "7.81.0-1ubuntu1.19",
                  available: "7.81.0-1ubuntu1.20",
                  repo: "jammy-updates",
                },
              ],
            },
          };
        }
        if (actionId === "package-manager.upgrade-all") {
          return {
            runId: "run-upgrade",
            status: "success",
            summary: "Upgraded all packages",
            changed: true,
            data: { output: `upgraded on host ${options?.hostId}` },
          };
        }
        throw new Error(`unexpected invoke ${actionId}`);
      },
    );
}

/**
 * The plugin with a connection named Prod whose server web-1 (srv-web1) has
 * a Linked host and web-2 (srv-web2) has none.
 */
export async function startLinked(
  options: { plugins?: string[]; permissions?: string[] } = {},
) {
  const fake = syncCoolify({
    "GET /servers/srv-web1": { json: WEB1_PATCHED },
    "GET /servers/srv-web2": {
      json: server("srv-web2", "web-2", "203.0.113.12"),
    },
  });
  const started = await startWithConnection({
    fake,
    permissions: options.permissions,
  });
  const h = started.harness;
  // Other plugins running besides this one, such as package-manager.
  if (options.plugins?.length) {
    const running = await h.mock.ctx.plugins.list();
    vi.spyOn(h.mock.ctx.plugins, "list").mockResolvedValue([
      ...running,
      ...options.plugins.map((id) => ({
        id,
        version: "1.0.0",
        source: "user" as const,
        state: "active",
      })),
    ]);
  }
  const synced = await h.request(
    "POST",
    `/connections/${started.connectionId}/sync`,
    {
      choices: [
        { uuid: WEB1.uuid, include: true },
        { uuid: "srv-web2", include: false },
      ],
    },
  );
  if (synced.status !== 200) throw new Error(`sync failed ${synced.status}`);
  const [host] = await h.mock.ctx.hosts.listOwned();
  // The mock answers host access only for hosts given to it up front, so
  // web-1's Linked host is opened with full access unless a test says less.
  const access = vi
    .spyOn(h.mock.ctx.hosts, "checkAccess")
    .mockImplementation(async (hostId) =>
      hostId === host.id
        ? {
            hasAccess: true,
            isOwner: true,
            isShared: false,
            permissionLevel: "manage" as const,
          }
        : { hasAccess: false, isOwner: false, isShared: false },
    );
  return { ...started, hostId: host.id, access };
}
