import type {
  PluginContext,
  PluginSshExecResult,
} from "@termix-ssh/plugin-sdk/backend";
import type { ResourceDto } from "../coolify/dto.js";
import type { Connections } from "../connections/service.js";
import { redactText } from "../redact.js";
import type { Resources } from "../resources/service.js";
import { isHostKeyError, sshRunner, type SshRunner } from "../ssh.js";
import type { Sync } from "../sync/service.js";
import {
  assertContainerName,
  CommandError,
  dockerPrefix,
  engineOf,
  shellCommand,
} from "./commands.js";
import { resolveContainers, type ContainerChoice } from "./resolver.js";

export type ContainerErrorCode =
  | "invalid-input"
  | "not-found"
  | "not-linked"
  | "no-host-access"
  | "not-running"
  | "container-not-found"
  | "host-key"
  | "ssh-failed"
  // coolify.exec: the admin setting or the owner's opt-in is off.
  | "exec-off"
  | "forbidden";

const STATUS: Record<ContainerErrorCode, 400 | 403 | 404 | 409 | 502> = {
  "exec-off": 403,
  forbidden: 403,
  "invalid-input": 400,
  "not-found": 404,
  "not-linked": 409,
  "no-host-access": 403,
  "not-running": 409,
  "container-not-found": 404,
  "host-key": 409,
  "ssh-failed": 502,
};

/** A refusal on the way to a container. `extra` holds no secret. */
export class ContainerError extends Error {
  readonly code: ContainerErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 502;
  readonly extra: Record<string, unknown>;

  constructor(
    code: ContainerErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ContainerError";
    this.code = code;
    this.status = STATUS[code];
    this.extra = extra;
  }
}

export interface ShellRequest {
  /** A Part of the resource in the path, by uuid. */
  part?: string;
  /** A name from an earlier choices answer. */
  container?: string;
  console?: "shell" | "db";
}

export interface ShellAnswer {
  hostId: number;
  title: string;
  container: string;
  command: string;
  /** Coolify's host key fingerprints for the server, when it has them. */
  fingerprints: string[];
  /** "no-console": a console was asked for an engine with none; it's a shell. */
  note?: "no-console";
}

export interface ShellChoices {
  choices: ContainerChoice[];
}

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message: string): ContainerError {
  return new ContainerError("invalid-input", message);
}

/** Checks a shell request body (a route body or an operation input). */
export function readShellRequest(body: unknown): ShellRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw invalid("A JSON object is required");
  }
  const raw = body as Record<string, unknown>;
  const out: ShellRequest = {};
  const part = raw.part;
  if (part !== undefined && part !== null && part !== "") {
    if (typeof part !== "string" || !UUID.test(part)) {
      throw invalid("part must be a Part's uuid");
    }
    out.part = part;
  }
  const container = raw.container;
  if (container !== undefined && container !== null && container !== "") {
    try {
      out.container = assertContainerName(container);
    } catch {
      throw invalid("container must be a container name");
    }
  }
  const mode = raw.console;
  if (mode !== undefined && mode !== null && mode !== "") {
    if (mode !== "shell" && mode !== "db") {
      throw invalid("console must be shell or db");
    }
    out.console = mode;
  }
  return out;
}

/** coolify.exec output, stdout and stderr together, is cut at this many bytes. */
export const EXEC_MAX_OUTPUT = 64 * 1024;
/**
 * Each stream is cut to this many bytes before it is redacted: 64 KB plus a
 * margin, so the redactor's input is always bounded.
 */
export const EXEC_RAW_CAP = 128 * 1024;
/** The longest coolify.exec may run, in seconds. */
export const EXEC_MAX_TIMEOUT_SEC = 120;
export const EXEC_DEFAULT_TIMEOUT_SEC = 30;
const EXEC_MAX_COMMAND = 16 * 1024;

export interface ExecRequest {
  part?: string;
  container?: string;
  command: string;
  /** Between 1 and EXEC_MAX_TIMEOUT_SEC. */
  timeoutSec: number;
}

/** What coolify.exec answers. The output is redacted and cut at 64 KB. */
export interface ExecAnswer {
  hostId: number;
  container: string;
  /** Null when the command was killed or ran out of time. */
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Checks an exec request (an operation input). The timeout is capped at
 * EXEC_MAX_TIMEOUT_SEC whatever was asked.
 */
export function readExecRequest(body: unknown): ExecRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("A JSON object is required");
  }
  const raw = body as Record<string, unknown>;
  const { part, container } = readShellRequest({
    part: raw.part,
    container: raw.container,
  });
  const command = raw.command;
  if (typeof command !== "string" || !command.trim()) {
    throw invalid("command is required");
  }
  if (command.length > EXEC_MAX_COMMAND) {
    throw invalid("command is too long");
  }
  const asked = raw.timeoutSec;
  let timeoutSec = EXEC_DEFAULT_TIMEOUT_SEC;
  if (asked !== undefined && asked !== null && asked !== "") {
    const n = typeof asked === "string" ? Number(asked) : asked;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw invalid("timeoutSec must be a number of seconds");
    }
    timeoutSec = Math.min(EXEC_MAX_TIMEOUT_SEC, Math.max(1, Math.floor(n)));
  }
  return {
    ...(part ? { part } : {}),
    ...(container ? { container } : {}),
    command,
    timeoutSec,
  };
}

/** The longest start of `text` that fits in `max` UTF-8 bytes, whole characters only. */
function cutBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export interface ContainersDeps {
  connections: Connections;
  resources: Resources;
  sync: Sync;
  /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
  run?: SshRunner;
}

/**
 * Container shells, database consoles and coolify.exec. Everything is
 * checked before any SSH: the connection (owner or any Grant: these need host
 * access, not a grant level), the resource in that connection's list, its
 * server's Linked host and the actor's own access to that host (`connect`
 * for a shell, `edit` to run a command).
 */
export function createContainers(ctx: PluginContext, deps: ContainersDeps) {
  const run = deps.run ?? sshRunner(ctx);

  async function fingerprints(
    connectionId: number,
    serverUuid: string,
  ): Promise<string[]> {
    try {
      const api = await deps.connections.api(connectionId);
      return (await api.server(serverUuid)).hostKeyFingerprints;
    } catch {
      return [];
    }
  }

  /** Runs one probe; core's host key refusal becomes a host-key answer. */
  async function probe<T>(
    target: { connectionId: number; serverUuid: string; hostId: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ContainerError) throw err;
      if (isHostKeyError(err)) {
        throw new ContainerError(
          "host-key",
          "Open a server terminal once to trust this host's key.",
          {
            hostId: target.hostId,
            fingerprints: await fingerprints(
              target.connectionId,
              target.serverUuid,
            ),
          },
        );
      }
      // Only a fixed message: SSH output could hold anything.
      throw new ContainerError(
        "ssh-failed",
        "The Linked host could not run docker over SSH.",
      );
    }
  }

  /** Whether docker needs sudo: not root and not in the docker group. */
  async function needsSudo(hostId: number): Promise<boolean> {
    const result = await run(hostId, "id -u; id -Gn");
    const [uid, groups] = result.stdout.split("\n").map((l) => l.trim());
    if (result.code !== 0 || !/^\d+$/.test(uid ?? "")) {
      throw new ContainerError(
        "ssh-failed",
        "The Linked host's user could not be read.",
      );
    }
    if (uid === "0") return false;
    return !(groups ?? "").split(/\s+/).includes("docker");
  }

  async function hasBash(
    hostId: number,
    container: string,
    sudo: boolean,
  ): Promise<boolean> {
    const name = assertContainerName(container);
    const result = await run(
      hostId,
      `${dockerPrefix(sudo)} exec ${name} sh -c 'command -v bash'`,
    );
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async function target(
    connectionId: number,
    uuid: string,
    part: string | undefined,
  ): Promise<{ res: ResourceDto; serverUuid: string | null }> {
    if (!UUID.test(uuid)) {
      throw new ContainerError("not-found", "Coolify resource not found");
    }
    // Checks the actor's access to the connection first: another user's
    // connection is a 404, and the uuid must be one of its resources.
    const rows = await deps.resources.list(connectionId);
    const res = rows.find((r) => r.uuid === uuid);
    if (!res)
      throw new ContainerError("not-found", "Coolify resource not found");
    if (!part) return { res, serverUuid: res.serverUuid };
    const found = rows.find((r) => r.uuid === part && r.parentUuid === uuid);
    if (!found) throw new ContainerError("not-found", "Coolify Part not found");
    return { res: found, serverUuid: found.serverUuid ?? res.serverUuid };
  }

  /**
   * The resource's running container on its Linked host, or the choices
   * when several match. Every refusal here comes before any SSH: the
   * resource in the connection's list, its Linked host and the actor's own
   * access to that host at `level`.
   */
  async function locate(
    connectionId: number,
    uuid: string,
    request: { part?: string; container?: string },
    level: "connect" | "edit",
  ): Promise<
    | {
        res: ResourceDto;
        serverUuid: string;
        hostId: number;
        sudo: boolean;
        chosen: ContainerChoice;
      }
    | ShellChoices
  > {
    const { res, serverUuid } = await target(connectionId, uuid, request.part);
    const hostId = serverUuid
      ? await deps.sync.linkedHostFor(connectionId, serverUuid)
      : null;
    if (!serverUuid || !hostId) {
      throw new ContainerError(
        "not-linked",
        "Link this server first: sync it from Coolify to make it a Linked host.",
      );
    }
    const access = await ctx.hosts.checkAccess(hostId, level);
    if (!access?.hasAccess) {
      throw new ContainerError(
        "no-host-access",
        level === "edit"
          ? "Running a command needs your own edit access to this server's Linked host."
          : "You can't open this server's Linked host.",
      );
    }
    const where = { connectionId, serverUuid, hostId };

    const sudo = await probe(where, () => needsSudo(hostId));
    const containers = await probe(where, () =>
      resolveContainers(run, hostId, res, { sudo }),
    );
    let chosen: ContainerChoice | undefined;
    if (request.container) {
      chosen = containers.find((c) => c.name === request.container);
      if (!chosen) {
        throw new ContainerError(
          "container-not-found",
          "That container doesn't belong to this resource.",
        );
      }
    } else if (containers.length > 1) {
      return { choices: containers };
    } else {
      chosen = containers[0];
    }
    if (!chosen) {
      throw new ContainerError(
        "container-not-found",
        "No container of this resource was found on its server.",
      );
    }
    if (!chosen.running) {
      throw new ContainerError("not-running", "The container isn't running.");
    }
    return { res, serverUuid, hostId, sudo, chosen };
  }

  async function audit(
    found: { hostId: number; container: string },
    details: Record<string, unknown>,
    success: boolean,
  ) {
    await ctx.audit.record({
      action: "coolify_container_exec",
      resourceType: "host",
      resourceId: String(found.hostId),
      resourceName: found.container,
      details: JSON.stringify(details),
      success,
      errorMessage: success ? undefined : "The command did not finish",
    });
  }

  return {
    async shell(
      connectionId: number,
      uuid: string,
      body: unknown,
    ): Promise<ShellAnswer | ShellChoices> {
      const request = readShellRequest(body);
      const found = await locate(connectionId, uuid, request, "connect");
      if ("choices" in found) return found;
      const { res, serverUuid, hostId, sudo, chosen } = found;
      const where = { connectionId, serverUuid, hostId };

      const engine = request.console === "db" ? engineOf(res.engine) : null;
      let command: string;
      try {
        if (engine) {
          command = shellCommand(chosen.name, {
            sudo,
            shell: "sh",
            mode: "db",
            engine,
          });
        } else {
          const bash = await probe(where, () =>
            hasBash(hostId, chosen.name, sudo),
          );
          command = shellCommand(chosen.name, {
            sudo,
            shell: bash ? "bash" : "sh",
            mode: "shell",
          });
        }
      } catch (err) {
        if (err instanceof CommandError) {
          throw new ContainerError("container-not-found", err.message);
        }
        throw err;
      }
      const answer: ShellAnswer = {
        hostId,
        title: res.name,
        container: chosen.name,
        command,
        fingerprints: await fingerprints(connectionId, serverUuid),
      };
      if (request.console === "db" && !engine) answer.note = "no-console";
      return answer;
    },

    /**
     * coolify.exec: runs one command in the resource's container and returns
     * its output, cut at 64 KB and redacted. Refused, before any SSH and
     * before Coolify is asked, unless the actor holds coolify.operate, the
     * admin setting allowExec is on and the connection's owner turned on
     * execEnabled; then it needs the actor's own edit access to the Linked
     * host. Anything that can't be read refuses. The command goes to `sh -s`
     * on standard input, never into the command line. Each run is audited
     * with the command's length, never its text.
     */
    async exec(
      connectionId: number,
      uuid: string,
      body: unknown,
    ): Promise<ExecAnswer | ShellChoices> {
      const request = readExecRequest(body);
      if ((await ctx.rbac.has("operate")) !== true) {
        throw new ContainerError(
          "forbidden",
          "Running a command needs Operate Coolify resources.",
        );
      }
      if ((await ctx.settings.get("allowExec")) !== true) {
        throw new ContainerError(
          "exec-off",
          "Running commands in containers is turned off by an admin.",
        );
      }
      const connection = await deps.connections.get(connectionId);
      if (!connection) {
        throw new ContainerError("not-found", "Coolify connection not found");
      }
      if (connection.execEnabled !== true) {
        throw new ContainerError(
          "exec-off",
          "The connection's owner hasn't allowed running commands in its containers.",
        );
      }
      const found = await locate(connectionId, uuid, request, "edit");
      if ("choices" in found) return found;
      const { serverUuid, hostId, sudo, chosen } = found;
      const container = assertContainerName(chosen.name);
      const details = {
        connectionId,
        uuid,
        part: request.part ?? null,
        container,
        commandLength: request.command.length,
        timeoutSec: request.timeoutSec,
      };
      let result: PluginSshExecResult;
      try {
        result = await probe({ connectionId, serverUuid, hostId }, () =>
          run(hostId, `${dockerPrefix(sudo)} exec -i ${container} sh -s`, {
            stdin: request.command,
            timeoutMs: request.timeoutSec * 1000,
            maxOutputBytes: EXEC_RAW_CAP,
          }),
        );
      } catch (err) {
        await audit({ hostId, container }, details, false);
        throw err;
      }
      // Bound each stream first, whatever SSH handed back, so the redactor
      // never sees more than EXEC_RAW_CAP. Then redact, then cut to 64 KB:
      // the margin keeps a secret near the 64 KB line whole for the redactor.
      const rawOut = result.stdout ?? "";
      const rawErr = result.stderr ?? "";
      const cappedOut = cutBytes(rawOut, EXEC_RAW_CAP);
      const cappedErr = cutBytes(rawErr, EXEC_RAW_CAP);
      const fullOut = redactText(cappedOut);
      const fullErr = redactText(cappedErr);
      const stdout = cutBytes(fullOut, EXEC_MAX_OUTPUT);
      const stderr = cutBytes(
        fullErr,
        EXEC_MAX_OUTPUT - Buffer.byteLength(stdout),
      );
      const truncated =
        result.truncated === true ||
        cappedOut.length < rawOut.length ||
        cappedErr.length < rawErr.length ||
        stdout.length < fullOut.length ||
        stderr.length < fullErr.length;
      await audit(
        { hostId, container },
        {
          ...details,
          exitCode: result.code,
          timedOut: result.timedOut,
          truncated,
        },
        result.code === 0 && !result.timedOut,
      );
      return {
        hostId,
        container,
        exitCode: result.code,
        timedOut: result.timedOut === true,
        truncated,
        stdout,
        stderr,
      };
    },
  };
}

export type Containers = ReturnType<typeof createContainers>;
