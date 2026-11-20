import type {
  PluginContext,
  PluginHostAccess,
  PluginOperationOutcome,
  PluginSshExecResult,
} from "@termix-ssh/plugin-sdk/backend";
import {
  PLATFORM_PROBE_COMMAND,
  buildListUpgradableCommand,
  buildPackageActionCommand,
  parsePlatformProbe,
  parseUpgradable,
  type PackageManager,
} from "@termix-ssh/plugin-sdk/host-commands";
import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";
import { createCache } from "../cache.js";
import type { PatchItem, PatchStatus, ServerDto } from "../coolify/dto.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import type { Tables } from "../db.js";
import type { ServerStatuses } from "../ops/signals.js";
import type { Resources } from "../resources/service.js";
import { isHostKeyError, sshRunner, type SshRunner } from "../ssh.js";
import type { Sync } from "../sync/service.js";

/** Which path read or changed a server's packages. */
export type UpdatesVia = "package-manager" | "ssh";

/** GET …/updates: Coolify's last check and the plugin's own, side by side. */
export interface UpdatesView {
  server: { uuid: string; name: string };
  hostId: number | null;
  /** Coolify's record (patch_check_result), from its own schedule. */
  coolify: PatchStatus | null;
  /** The last check this plugin ran, or null. */
  fresh: PatchStatus | null;
  via: UpdatesVia | null;
}

export interface CheckResult {
  via: UpdatesVia;
  fresh: PatchStatus;
}

export interface InstallResult {
  via: UpdatesVia;
  summary: string;
  changed: boolean;
  /** Package Manager is waiting for an approval; nothing ran yet. */
  pending: boolean;
  /** The end of the upgrade's output. */
  output: string;
}

export interface RebootResult {
  via: "ssh";
  summary: string;
}

type Grant = Exclude<AccessLevel, "owner">;

export type UpdateErrorCode =
  | "not-linked"
  | "confirm-required"
  | "name-mismatch"
  | "host-forbidden"
  | "needs-sudo"
  | "unsupported-os"
  | "host-key"
  | "ssh-failed"
  | "companion-failed";

const UPDATE_STATUS: Record<UpdateErrorCode, 400 | 403 | 409 | 502> = {
  "not-linked": 409,
  "confirm-required": 400,
  "name-mismatch": 400,
  "host-forbidden": 403,
  "needs-sudo": 409,
  "unsupported-os": 409,
  "host-key": 409,
  "ssh-failed": 502,
  "companion-failed": 502,
};

/**
 * A refusal on the way to a server's packages, with its own statuses (409
 * for not-linked, as ContainerError has). Its message is fixed text.
 */
export class UpdateError extends Error {
  readonly code: UpdateErrorCode;
  readonly status: 400 | 403 | 409 | 502;

  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
    this.status = UPDATE_STATUS[code];
  }
}
type HostLevel = "connect" | "edit";

export const PACKAGE_MANAGER = "package-manager";
export const PM_LIST = "package-manager.list-updates";
export const PM_UPGRADE = "package-manager.upgrade-all";

const UUID = /^[A-Za-z0-9_-]{1,64}$/;
const GRANT_RANK: Record<AccessLevel, number> = {
  view: 1,
  operate: 2,
  configure: 3,
  owner: 4,
};
/** Share levels that may open an SSH session, and those that may change the host. */
const HOST_LEVELS: Record<HostLevel, ReadonlySet<string>> = {
  connect: new Set(["connect", "edit", "manage"]),
  edit: new Set(["edit", "manage"]),
};
const OUTPUT_TAIL = 4000;

// Packages whose update can interrupt the server, as Coolify's CheckUpdates
// labels them. docker restarts the Docker daemon and every container on it.
const RISKY: Record<
  "apt" | "dnf" | "pacman",
  Record<"docker" | "kernel" | "system", string[]>
> = {
  apt: {
    docker: [
      "docker-ce",
      "docker-ce-cli",
      "docker-ce-rootless-extras",
      "docker-buildx-plugin",
      "docker-compose-plugin",
      "containerd.io",
      "containerd",
      "runc",
      "docker.io",
    ],
    kernel: [
      "linux-image-*",
      "linux-modules-*",
      "linux-generic*",
      "linux-virtual*",
      "linux-aws*",
      "linux-azure*",
      "linux-gcp*",
      "linux-oracle*",
      "linux-kvm*",
      "linux-raspi*",
    ],
    system: [
      "libc6",
      "libc-bin",
      "systemd",
      "systemd-sysv",
      "libsystemd0",
      "udev",
      "dbus",
      "openssh-server",
      "openssh-sftp-server",
    ],
  },
  dnf: {
    docker: [
      "docker-ce",
      "docker-ce-cli",
      "docker-ce-rootless-extras",
      "docker-buildx-plugin",
      "docker-compose-plugin",
      "containerd.io",
      "containerd",
      "runc",
      "moby-engine",
      "docker",
    ],
    kernel: [
      "kernel",
      "kernel-core",
      "kernel-modules",
      "kernel-modules-core",
      "kernel-modules-extra",
      "kernel-uek",
      "kernel-uek-core",
      "kernel-uek-modules",
    ],
    system: [
      "glibc",
      "glibc-common",
      "glibc-langpack-*",
      "systemd",
      "systemd-libs",
      "systemd-udev",
      "dbus",
      "dbus-broker",
      "openssh-server",
    ],
  },
  pacman: {
    docker: ["docker", "containerd", "runc", "docker-compose", "docker-buildx"],
    kernel: ["linux", "linux-lts", "linux-zen", "linux-hardened"],
    system: ["glibc", "systemd", "systemd-libs", "dbus", "openssh"],
  },
};

function globMatch(pattern: string, name: string): boolean {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`).test(name);
}

/**
 * The risk of updating one package. With the package manager unknown (the
 * Package Manager plugin doesn't name it), every family's list is checked.
 */
export function riskFor(pkg: PackageManager, name: string): PatchItem["risk"] {
  const families =
    pkg === "apt" || pkg === "pacman"
      ? [RISKY[pkg]]
      : pkg === "dnf" || pkg === "yum"
        ? [RISKY.dnf]
        : [RISKY.apt, RISKY.dnf, RISKY.pacman];
  for (const risk of ["docker", "kernel", "system"] as const) {
    if (families.some((f) => f[risk].some((p) => globMatch(p, name)))) {
      return risk;
    }
  }
  return null;
}

// ---- Fixed shell commands. Nothing from a request, Coolify or the host's
// settings is ever put into them.

/** Runs a fixed command as root: directly when the login is root, else with passwordless sudo. */
function asRoot(command: string): string {
  return (
    'if [ "$(id -u)" = 0 ]; then set --; else set -- sudo -n; fi; ' +
    `"$@" sh -c ${shellQuote(command)}`
  );
}

const LIST_MARK = "__COOLIFY_LIST__";
const REBOOT_MARK = "__COOLIFY_REBOOT__";
const REFRESH: Partial<Record<NonNullable<PackageManager>, string>> = {
  apt: "apt-get update -qq",
  dnf: "dnf -q makecache",
  yum: "yum -q makecache",
};
// Coolify's own reboot check, cut to the parts that need no extra tools.
const REBOOT_CHECK =
  "if [ -f /var/run/reboot-required ]; then echo REBOOT=yes; " +
  "elif command -v needs-restarting >/dev/null 2>&1; then " +
  "needs-restarting -r >/dev/null 2>&1 && echo REBOOT=no || echo REBOOT=yes; " +
  "elif [ -d /var/lib/dpkg ]; then echo REBOOT=no; " +
  "else echo REBOOT=unknown; fi";
const REBOOT_COMMAND = asRoot(
  "nohup sh -c 'sleep 2; systemctl reboot || reboot' >/dev/null 2>&1 </dev/null &",
);

/** The check for one package manager: refresh the lists, list updates, read the reboot flag. */
export function checkCommand(pkg: NonNullable<PackageManager>): string {
  const refresh = REFRESH[pkg];
  return [
    refresh ? `${asRoot(refresh)} >/dev/null 2>&1` : "true",
    `echo ${LIST_MARK}`,
    `LANG=C ${buildListUpgradableCommand(pkg)}`,
    `echo ${REBOOT_MARK}`,
    REBOOT_CHECK,
  ].join("; ");
}

export function installCommand(pkg: NonNullable<PackageManager>): string {
  return asRoot(buildPackageActionCommand(pkg, "upgrade-all")!);
}

export function rebootCommand(): string {
  return REBOOT_COMMAND;
}

/** Package names apt lists from a "-security" suite. */
function aptSecurity(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    const m = line.trim().match(/^([^/\s]+)\/(\S+)\s/);
    if (m && m[2].split(",").some((suite) => suite.endsWith("-security"))) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Parses the output of checkCommand into a PatchStatus. */
export function parseCheck(
  pkg: NonNullable<PackageManager>,
  output: string,
  checkedAt: string,
): PatchStatus {
  const listStart = output.indexOf(LIST_MARK);
  const rebootStart = output.indexOf(REBOOT_MARK);
  const listing =
    listStart === -1
      ? ""
      : output.slice(
          listStart + LIST_MARK.length,
          rebootStart === -1 ? undefined : rebootStart,
        );
  const rebootText = rebootStart === -1 ? "" : output.slice(rebootStart);
  const security = pkg === "apt" ? aptSecurity(listing) : null;
  const items: PatchItem[] = parseUpgradable(pkg, listing).map((u) => ({
    package: u.name,
    newVersion: u.newVersion ?? "",
    currentVersion: u.currentVersion ?? "",
    security: security?.has(u.name) ?? false,
    risk: riskFor(pkg, u.name),
  }));
  return {
    updates: items.length,
    security: security ? items.filter((i) => i.security).length : null,
    rebootRequired: rebootText.includes("REBOOT=yes")
      ? true
      : rebootText.includes("REBOOT=no")
        ? false
        : null,
    checkedAt,
    error: null,
    items,
  };
}

/** Package Manager's list-updates rows as a PatchStatus. */
export function fromPackageManager(
  data: unknown,
  checkedAt: string,
): PatchStatus {
  const rows = Array.isArray((data as { rows?: unknown })?.rows)
    ? ((data as { rows: unknown[] }).rows as Record<string, unknown>[])
    : [];
  const items: PatchItem[] = rows
    .filter((r) => r && typeof r.name === "string")
    .map((r) => ({
      package: String(r.name),
      newVersion: typeof r.available === "string" ? r.available : "",
      currentVersion: typeof r.current === "string" ? r.current : "",
      security: r.state === "security",
      risk: riskFor(null, String(r.name)),
    }));
  return {
    updates: items.length,
    security: items.filter((i) => i.security).length,
    rebootRequired: null,
    checkedAt,
    error: null,
    items,
  };
}

function tail(text: unknown): string {
  const value = typeof text === "string" ? text : "";
  return value.length > OUTPUT_TAIL ? value.slice(-OUTPUT_TAIL) : value;
}

const SUDO_REFUSED = [
  "a password is required",
  "a terminal is required",
  "no tty present",
  "is not in the sudoers file",
  "not allowed to run sudo",
];

function sudoRefused(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return SUDO_REFUSED.some((phrase) => lower.includes(phrase));
}

function errorName(err: unknown): string {
  return (err as Error)?.name ?? "error";
}

const outcomeFailed = (o: PluginOperationOutcome) =>
  Boolean(o.error) ||
  ["failed", "error", "denied", "refused", "cancelled", "timeout"].includes(
    String(o.status).toLowerCase(),
  );

const outcomePending = (o: PluginOperationOutcome) =>
  Boolean(o.approvalId) ||
  /approval|pending|queued|waiting/i.test(String(o.status));

/**
 * Server updates for Linked hosts. Coolify has no API to check, install or
 * reboot, so these run through the Package Manager plugin's actions when it
 * runs, and otherwise over SSH on the Linked host with fixed commands.
 *
 * Who may act: the Termix permission (operate, or administer to reboot), the
 * connection (owner, or a grant at operate, configure to reboot), a server
 * uuid that the connection's own Coolify has, and host access on its Linked
 * host (connect to check, edit to install or reboot). Anything that can't be
 * read refuses. Each action reads the connection once (`snapshot`) and checks
 * its revision again right before every SSH command, Package Manager call
 * and kept check, so a target change ends it with target-changed.
 */
export function createUpdates(
  ctx: PluginContext,
  deps: {
    tables: Tables;
    connections: Connections;
    resources: Pick<Resources, "invalidate">;
    servers: Pick<ServerStatuses, "invalidate">;
    sync: Pick<Sync, "linkedHostFor">;
    /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
    run?: SshRunner;
  },
) {
  const { connections, resources, sync } = deps;
  const cache = createCache(ctx, deps.tables);
  const run = deps.run ?? sshRunner(ctx);

  type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

  /** The plugin's own last check, and the revision it was read under. */
  interface KeptCheck {
    revision: string;
    status: PatchStatus;
    via: UpdatesVia;
  }

  function serverUuid(raw: unknown): string {
    if (typeof raw !== "string" || !UUID.test(raw)) {
      throw new ConnectionError("not-found", "Coolify server not found");
    }
    return raw;
  }

  async function allowed(permission: string): Promise<void> {
    let held = false;
    try {
      held = await ctx.rbac.has(permission);
    } catch {
      held = false;
    }
    if (!held) {
      throw new ConnectionError(
        "forbidden",
        `This needs the coolify.${permission} permission`,
      );
    }
  }

  function grantAt(snap: Snapshot, need: Grant): void {
    if (GRANT_RANK[snap.view.access] < GRANT_RANK[need]) {
      throw new ConnectionError(
        "forbidden",
        "Your access to this connection doesn't allow this",
      );
    }
  }

  /** Fails closed unless the connection still points at the snapshot's target. */
  async function holds(connectionId: number, snap: Snapshot): Promise<void> {
    if ((await connections.revision(connectionId)) !== snap.view.revision) {
      throw new ConnectionError(
        "target-changed",
        "The connection's address, token or Access settings changed. Try again.",
      );
    }
  }

  async function linkedHost(id: number, uuid: string): Promise<number> {
    const hostId = await sync.linkedHostFor(id, uuid);
    if (!hostId) {
      throw new UpdateError(
        "not-linked",
        "This Coolify server has no Linked host. Sync it first.",
      );
    }
    return hostId;
  }

  async function hostAt(hostId: number, level: HostLevel): Promise<void> {
    let access: PluginHostAccess | null = null;
    try {
      access = await ctx.hosts.checkAccess(hostId, level);
    } catch {
      access = null;
    }
    const ok =
      access?.hasAccess === true &&
      (access.isOwner === true ||
        HOST_LEVELS[level].has(String(access.permissionLevel)));
    if (!ok) {
      throw new UpdateError(
        "host-forbidden",
        `You need ${level} access to this server's Linked host`,
      );
    }
  }

  async function packageManagerRuns(): Promise<boolean> {
    try {
      const plugins = await ctx.plugins.list();
      return plugins.some(
        (p) => p.id === PACKAGE_MANAGER && p.state === "active",
      );
    } catch {
      return false;
    }
  }

  /** One fixed command on the Linked host, after the snapshot is checked. */
  async function exec(
    target: Target,
    command: string,
    timeoutMs: number,
  ): Promise<PluginSshExecResult> {
    await holds(target.connectionId, target.snap);
    let result: PluginSshExecResult;
    try {
      result = await run(target.hostId, command, { timeoutMs });
    } catch (err) {
      ctx.log.warn(`coolify updates ssh failed: ${errorName(err)}`);
      // Only fixed messages: core's and the host's text could hold anything.
      if (isHostKeyError(err)) {
        throw new UpdateError(
          "host-key",
          "Open a server terminal once to trust this host's key.",
        );
      }
      throw new UpdateError("ssh-failed", "SSH to the Linked host failed");
    }
    if (result.timedOut) {
      throw new UpdateError(
        "ssh-failed",
        "The command on the Linked host ran out of time",
      );
    }
    return result;
  }

  async function platform(
    target: Target,
  ): Promise<NonNullable<PackageManager>> {
    const probe = await exec(target, PLATFORM_PROBE_COMMAND, 30_000);
    const pkg = parsePlatformProbe(probe.stdout).pkg;
    if (!pkg) {
      throw new UpdateError(
        "unsupported-os",
        "No apt, dnf, yum or pacman on this server",
      );
    }
    return pkg;
  }

  async function invoke(
    target: Target,
    actionId: string,
    failure: string,
  ): Promise<PluginOperationOutcome> {
    await holds(target.connectionId, target.snap);
    let outcome: PluginOperationOutcome;
    try {
      outcome = await ctx.operations.invoke(actionId, {
        hostId: target.hostId,
        confirmed: true,
      });
    } catch (err) {
      ctx.log.warn(`coolify package-manager call failed: ${errorName(err)}`);
      throw new UpdateError("companion-failed", failure);
    }
    if (outcomeFailed(outcome)) {
      throw new UpdateError(
        "companion-failed",
        outcome.error ? `${failure}: ${outcome.error}` : failure,
      );
    }
    return outcome;
  }

  const kindOf = (uuid: string) => `updates:${uuid}`;

  /** The kept check, only when it was read under the snapshot's revision. */
  async function readFresh(
    connectionId: number,
    uuid: string,
    snap: Snapshot,
  ): Promise<{ fresh: PatchStatus | null; via: UpdatesVia | null }> {
    const kept = (
      await cache.read<Partial<KeptCheck>>(connectionId, kindOf(uuid))
    )?.value;
    if (kept?.revision !== snap.view.revision || !kept.status) {
      return { fresh: null, via: null };
    }
    return { fresh: kept.status, via: kept.via ?? null };
  }

  /**
   * After an install or a reboot (or one that failed part way): the kept
   * check, the server statuses signals cache and the resource list no
   * longer match the server.
   */
  async function invalidate(connectionId: number, uuid: string) {
    await cache.drop(connectionId, kindOf(uuid));
    await deps.servers.invalidate(connectionId);
    await resources.invalidate(connectionId);
  }

  interface Target {
    connectionId: number;
    uuid: string;
    hostId: number;
    snap: Snapshot;
    server: ServerDto;
  }

  /** Everything an action needs, checked in order; the first refusal wins. */
  async function prepare(
    connectionId: number,
    rawUuid: unknown,
    rules: { permission: string; grant: Grant; host: HostLevel },
    precheck?: () => void,
  ): Promise<Target> {
    await allowed(rules.permission);
    const uuid = serverUuid(rawUuid);
    // Read once: every later step is checked against this target.
    const snap = await connections.snapshot(connectionId);
    grantAt(snap, rules.grant);
    precheck?.();
    // The connection's own Coolify, with its own token: a uuid it doesn't
    // have is a 404 from Coolify, whatever link row is left.
    const server = await snap.api.server(uuid);
    const hostId = await linkedHost(connectionId, uuid);
    await hostAt(hostId, rules.host);
    const target = { connectionId, uuid, hostId, snap, server };
    await holds(connectionId, snap);
    return target;
  }

  return {
    /** Coolify's last check and the plugin's own. Works without a Linked host. */
    async status(connectionId: number, rawUuid: unknown): Promise<UpdatesView> {
      await allowed("view");
      const uuid = serverUuid(rawUuid);
      const snap = await connections.snapshot(connectionId);
      const server = await snap.api.server(uuid);
      const hostId = await sync.linkedHostFor(connectionId, uuid);
      const { fresh, via } = await readFresh(connectionId, uuid, snap);
      return {
        server: { uuid, name: server.name },
        hostId,
        coolify: server.patch,
        fresh,
        via,
      };
    },

    /** Re-reads pending updates and keeps the result. */
    async check(connectionId: number, rawUuid: unknown): Promise<CheckResult> {
      const target = await prepare(connectionId, rawUuid, {
        permission: "operate",
        grant: "operate",
        host: "connect",
      });
      const checkedAt = new Date().toISOString();
      let result: CheckResult;
      if (await packageManagerRuns()) {
        const outcome = await invoke(
          target,
          PM_LIST,
          "Package Manager could not list updates",
        );
        result = {
          via: "package-manager",
          fresh: fromPackageManager(outcome.data, checkedAt),
        };
      } else {
        const pkg = await platform(target);
        const out = await exec(target, checkCommand(pkg), 180_000);
        result = { via: "ssh", fresh: parseCheck(pkg, out.stdout, checkedAt) };
      }
      // Kept under the revision it was read with, and only while it holds.
      await holds(connectionId, target.snap);
      const kept: KeptCheck = {
        revision: target.snap.view.revision,
        status: result.fresh,
        via: result.via,
      };
      await cache.write(connectionId, kindOf(target.uuid), kept, Date.now());
      return result;
    },

    /** Upgrades every package. Needs confirm === true. */
    async install(
      connectionId: number,
      rawUuid: unknown,
      body: { confirm?: unknown },
    ): Promise<InstallResult> {
      const target = await prepare(
        connectionId,
        rawUuid,
        { permission: "operate", grant: "operate", host: "edit" },
        () => {
          if (body.confirm !== true) {
            throw new UpdateError(
              "confirm-required",
              "Installing updates needs confirm: true",
            );
          }
        },
      );
      let result: InstallResult;
      let asked = false;
      try {
        if (await packageManagerRuns()) {
          asked = true;
          const outcome = await invoke(
            target,
            PM_UPGRADE,
            "Package Manager could not install updates",
          );
          const pending = outcomePending(outcome);
          result = {
            via: "package-manager",
            summary: outcome.summary ?? "Upgraded all packages",
            changed: !pending && outcome.changed !== false,
            pending,
            output: tail((outcome.data as { output?: unknown })?.output),
          };
        } else {
          const pkg = await platform(target);
          asked = true;
          const out = await exec(target, installCommand(pkg), 600_000);
          if (out.code !== 0 && sudoRefused(out.stderr)) {
            throw new UpdateError(
              "needs-sudo",
              "The SSH login is not root and sudo asks for a password. Use root or passwordless sudo, as Coolify does.",
            );
          }
          if (out.code !== 0) {
            throw new UpdateError(
              "ssh-failed",
              "The upgrade failed on the server",
            );
          }
          result = {
            via: "ssh",
            summary: "Upgraded all packages",
            changed: true,
            pending: false,
            output: tail(out.stdout),
          };
        }
      } finally {
        // A refused or timed out upgrade may still have changed packages, and
        // Docker updates restart every container.
        if (asked) await invalidate(connectionId, target.uuid);
      }
      ctx.log.info(`coolify updates installed via ${result.via}`);
      return result;
    },

    /** Reboots the server over SSH. confirmName must be the server's exact name. */
    async reboot(
      connectionId: number,
      rawUuid: unknown,
      body: { confirmName?: unknown },
    ): Promise<RebootResult> {
      const target = await prepare(connectionId, rawUuid, {
        permission: "administer",
        grant: "configure",
        host: "edit",
      });
      const { server, hostId, uuid } = target;
      if (
        typeof body.confirmName !== "string" ||
        !server.name ||
        body.confirmName !== server.name
      ) {
        throw new UpdateError(
          "name-mismatch",
          "Type the server's exact name to reboot it",
        );
      }
      let out: PluginSshExecResult;
      try {
        out = await exec(target, rebootCommand(), 30_000);
      } finally {
        await invalidate(connectionId, uuid);
      }
      if (out.code !== 0 && sudoRefused(out.stderr)) {
        throw new UpdateError(
          "needs-sudo",
          "The SSH login is not root and sudo asks for a password. Use root or passwordless sudo, as Coolify does.",
        );
      }
      if (out.code !== 0) {
        throw new UpdateError(
          "ssh-failed",
          "The reboot was refused on the server",
        );
      }
      await ctx.audit.record({
        action: "coolify_server_reboot",
        resourceType: "host",
        resourceId: String(hostId),
        resourceName: server.name,
        details: JSON.stringify({ connectionId, serverUuid: uuid }),
        success: true,
      });
      return { via: "ssh", summary: `Rebooting ${server.name}` };
    },
  };
}

export type Updates = ReturnType<typeof createUpdates>;
