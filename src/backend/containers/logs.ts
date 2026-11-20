import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import { CoolifyError } from "../coolify/http.js";
import type { ResourceDto } from "../coolify/dto.js";
import type { Connections } from "../connections/service.js";
import { maskCredentials } from "../redact.js";
import { sshRunner, type SshRunner } from "../ssh.js";
import { assertContainerName, CommandError, dockerPrefix } from "./commands.js";
import type { ContainerChoice } from "./resolver.js";
import {
  ContainerError,
  type ContainerPlace,
  type Containers,
} from "./service.js";

/** The most lines a snapshot reads, from Coolify or from docker. */
export const MAX_LINES = 10_000;
export const DEFAULT_LINES = 100;
/** docker logs output kept over SSH: 10,000 long lines fit. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const LOGS_TIMEOUT_MS = 30_000;

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `name=value`, `name: value` and `"name": "value"` where the name says it
 * holds a secret: env dumps, config echoes and JSON log lines.
 */
const SECRET_FIELD =
  /(\b[\w.-]{0,64}(?:password|passwd|pwd|secret|token|api_?key|private_?key|access_?key|credentials?)[\w.-]{0,64}["']?\s{0,8}[:=]\s{0,8}["']?)[^\s"',;&}]+/gi;
/** An Authorization header's credential. */
const AUTH_HEADER = /(\b(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=|-]{8,}/gi;

/**
 * Log text with its secrets masked before it leaves the backend: the
 * connection's own token and Access secret anywhere, then what redact.ts
 * masks in a string (a URL's password, credential query parameters), then
 * secret-named fields and Authorization credentials.
 */
export function redactLog(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED_VALUE);
  }
  return maskCredentials(out)
    .replace(SECRET_FIELD, `$1${REDACTED_VALUE}`)
    .replace(AUTH_HEADER, `$1${REDACTED_VALUE}`);
}

export interface LogsRequest {
  lines: number;
  timestamps: boolean;
  /** A Part of the resource, by uuid. */
  part?: string;
  /** A name from an earlier choices answer. */
  container?: string;
}

/** Where a snapshot came from, so the UI can say which rule applied. */
export type LogSource = "coolify" | "ssh";

export interface LogsAnswer {
  source: LogSource;
  text: string;
  /** The container read over SSH. */
  container?: string;
}

export interface LogsChoices {
  choices: ContainerChoice[];
}

function invalid(message: string): ContainerError {
  return new ContainerError("invalid-input", message);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function readLines(value: unknown): number {
  if (!present(value)) return DEFAULT_LINES;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,9}$/.test(text)) {
    throw invalid("lines must be a whole number");
  }
  const lines = Number(text);
  if (lines < 1) throw invalid("lines must be at least 1");
  return Math.min(lines, MAX_LINES);
}

function readFlag(value: unknown): boolean {
  if (!present(value)) return false;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw invalid("timestamps must be true or false");
}

/**
 * Checks a logs request (a route query or an operation input). The line count
 * is capped at MAX_LINES, never refused for being large.
 */
export function readLogsRequest(raw: unknown): LogsRequest {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: LogsRequest = {
    lines: readLines(input.lines),
    timestamps: readFlag(input.timestamps),
  };
  if (present(input.part)) {
    if (typeof input.part !== "string" || !UUID.test(input.part)) {
      throw invalid("part must be a Part's uuid");
    }
    out.part = input.part;
  }
  if (present(input.container)) {
    try {
      out.container = assertContainerName(input.container);
    } catch {
      throw invalid("container must be a container name");
    }
  }
  return out;
}

/** The last `max` lines of a log, keeping a final newline when it had one. */
export function lastLines(text: string, max: number): string {
  const trailing = text.endsWith("\n");
  const lines = (trailing ? text.slice(0, -1) : text).split("\n");
  if (lines.length <= max) return text;
  return lines.slice(-max).join("\n") + (trailing ? "\n" : "");
}

export interface LogsCommandOptions {
  sudo: boolean;
  /** Lines from the end; 0 with follow starts at now. */
  lines: number;
  timestamps: boolean;
  follow?: boolean;
}

/**
 * The `docker logs` line for the Linked host. The container name passes the
 * name check and is quoted, the line count is quoted, and stderr joins
 * stdout so both reach the reader in order.
 */
export function logsCommand(
  container: string,
  opts: LogsCommandOptions,
): string {
  const name = assertContainerName(container);
  const min = opts.follow ? 0 : 1;
  if (
    !Number.isSafeInteger(opts.lines) ||
    opts.lines < min ||
    opts.lines > MAX_LINES
  ) {
    throw new CommandError("Not a line count");
  }
  return [
    `${dockerPrefix(opts.sudo)} logs`,
    ...(opts.follow ? ["-f"] : []),
    `--tail ${shellQuote(String(opts.lines))}`,
    ...(opts.timestamps ? ["--timestamps"] : []),
    shellQuote(name),
    "2>&1",
  ].join(" ");
}

/** The part of an ssh2 exec channel the follow uses. */
interface ExecStream {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  signal?: (name: string) => unknown;
  close?: () => unknown;
}

interface ExecClient {
  exec(
    command: string,
    options: { pty: boolean },
    callback: (err: Error | undefined, stream: ExecStream) => void,
  ): unknown;
}

/** Receives a follow's output. `lines` never holds a partial line. */
export interface FollowSink {
  lines: (lines: string[]) => void;
  /** The process ended on its own (the container stopped or went away). */
  end: () => void;
}

export interface Following {
  kind: "following";
  container: string;
  where: ContainerPlace;
  /**
   * Throws unless the actor may still read this follow: lifecycle's
   * authorize (coolify.operate, an operate grant, the uuid in the
   * connection's own list), the snapshot's revision and host access.
   */
  recheck: () => Promise<void>;
  /** Kills the remote docker logs and ends the SSH connection. Idempotent. */
  stop: () => void;
}

/** A line longer than this is sent in pieces, so the carry can't grow. */
const MAX_LINE = 16 * 1024;

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

export interface LogsDeps {
  connections: Connections;
  containers: Containers;
  /** SSH on a Linked host; ctx.ssh.exec unless a test gives another. */
  run?: SshRunner;
}

type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

/**
 * Container logs. A snapshot comes from Coolify's API when the API rules
 * allow it (coolify.operate, checked by the route or the action, an owner or
 * operate or configure Grant, and a token with read:sensitive), else from
 * `docker logs` over SSH on the Linked host, which needs coolify.operate and
 * the actor's own connect access to that host. A follow is always SSH.
 * Both need lifecycle's authorize. Every read is about one snapshot of the
 * connection, checked again right before each fetch or SSH, and every line
 * goes through redactLog before it leaves.
 */

export function createLogs(ctx: PluginContext, deps: LogsDeps) {
  const run = deps.run ?? sshRunner(ctx);

  /** Logs through Coolify, or null when the API rules send this to SSH. */
  async function fromCoolify(
    snap: Snapshot,
    res: ResourceDto,
    request: LogsRequest,
  ): Promise<string | null> {
    // A container from an SSH choices answer is read over SSH; Coolify reads
    // a whole service only one sub-service at a time.
    if (request.container || res.kind === "service") return null;
    // The grant level was checked by authorize; the token needs read:sensitive.
    if (!snap.view.abilities.sensitive) return null;
    try {
      return await snap.api.logs(res.kind, res.uuid, {
        lines: request.lines,
        timestamps: request.timestamps,
        parentUuid: res.parentUuid ?? undefined,
        // Right before each fetch, after the budget's and retries' waits.
        beforeFetch: () =>
          deps.containers.assertSnapshotHolds(snap.view.id, snap),
      });
    } catch (err) {
      // The token lost read:sensitive since the last probe.
      if (err instanceof CoolifyError && err.cause === "forbidden-ability") {
        return null;
      }
      throw err;
    }
  }

  async function fromSsh(
    connectionId: number,
    snap: Snapshot,
    uuid: string,
    request: LogsRequest,
  ): Promise<LogsAnswer | LogsChoices> {
    const located = await deps.containers.locate(
      connectionId,
      snap,
      uuid,
      request,
    );
    if (located.kind === "choices") return { choices: located.choices };
    const { where, sudo, container } = located;
    let command: string;
    try {
      command = logsCommand(container.name, {
        sudo,
        lines: request.lines,
        timestamps: request.timestamps,
      });
    } catch {
      throw new ContainerError(
        "container-not-found",
        "That container can't be read.",
      );
    }
    await deps.containers.assertSnapshotHolds(connectionId, snap);
    const result = await deps.containers.guard(where, () =>
      run(where.hostId, command, {
        timeoutMs: LOGS_TIMEOUT_MS,
        maxOutputBytes: MAX_LOG_BYTES,
      }),
    );
    if (result.code !== 0) {
      // Only a fixed message: the output could hold anything.
      throw new ContainerError(
        "ssh-failed",
        "docker logs failed on the Linked host.",
      );
    }
    return {
      source: "ssh",
      text: redactLog(
        lastLines(result.stdout, request.lines),
        await snap.secrets(),
      ),
      container: container.name,
    };
  }

  return {
    /** A route query or an operation input in; a labelled snapshot out. */
    async snapshot(
      connectionId: number,
      uuid: string,
      raw: unknown,
    ): Promise<LogsAnswer | LogsChoices> {
      const request = readLogsRequest(raw);
      // Read once: every later step is checked against this target.
      const snap = await deps.connections.snapshot(connectionId);
      const { res } = await deps.containers.target(
        connectionId,
        uuid,
        request.part,
      );
      const text = await fromCoolify(snap, res, request);
      if (text !== null) {
        return {
          source: "coolify",
          text: redactLog(lastLines(text, request.lines), await snap.secrets()),
        };
      }
      return fromSsh(connectionId, snap, uuid, request);
    },

    /**
     * Streams new lines of a container's logs over SSH as the actor, with
     * the same checks as a snapshot over SSH. Starts at now.
     */
    async follow(
      connectionId: number,
      uuid: string,
      request: { part?: string; container?: string; timestamps: boolean },
      sink: FollowSink,
    ): Promise<Following | LogsChoices> {
      const snap = await deps.connections.snapshot(connectionId);
      const located = await deps.containers.locate(
        connectionId,
        snap,
        uuid,
        request,
      );
      if (located.kind === "choices") return { choices: located.choices };
      const { where, sudo, container } = located;
      const command = logsCommand(container.name, {
        sudo,
        lines: 0,
        timestamps: request.timestamps,
        follow: true,
      });
      const secrets = await snap.secrets();
      await deps.containers.assertSnapshotHolds(connectionId, snap);
      const connection = await deps.containers.guard(where, () =>
        ctx.ssh.connect(where.hostId, {
          purpose: "coolify",
          profile: "background",
        }),
      );
      const client = connection.client as ExecClient;
      let stream: ExecStream | null = null;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        // A pty ties docker logs to the channel: closing it hangs it up.
        try {
          stream?.signal?.("KILL");
        } catch {
          // The channel may already be gone.
        }
        try {
          stream?.close?.();
        } catch {
          // As above.
        }
        connection.dispose();
      };
      try {
        stream = await new Promise<ExecStream>((resolve, reject) => {
          client.exec(command, { pty: true }, (err, opened) =>
            err ? reject(err) : resolve(opened),
          );
        });
      } catch {
        stop();
        throw new ContainerError(
          "ssh-failed",
          "docker logs could not start on the Linked host.",
        );
      }
      let carry = "";
      const onData = (chunk: unknown) => {
        if (stopped) return;
        const parts = (carry + chunkText(chunk)).split(/\r?\n/);
        carry = parts.pop() ?? "";
        while (carry.length > MAX_LINE) {
          parts.push(carry.slice(0, MAX_LINE));
          carry = carry.slice(MAX_LINE);
        }
        if (parts.length) {
          sink.lines(parts.map((line) => redactLog(line, secrets)));
        }
      };
      stream.on("data", onData);
      stream.stderr?.on("data", onData);
      stream.on("close", () => {
        if (stopped) return;
        if (carry) sink.lines([redactLog(carry, secrets)]);
        carry = "";
        stop();
        sink.end();
      });
      const recheck = async () => {
        await deps.containers.target(connectionId, uuid, request.part);
        await deps.containers.assertSnapshotHolds(connectionId, snap);
        await deps.containers.assertHostAccess(where.hostId);
      };
      return {
        kind: "following",
        container: container.name,
        where,
        recheck,
        stop,
      };
    },
  };
}

export type Logs = ReturnType<typeof createLogs>;
