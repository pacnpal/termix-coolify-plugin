import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import type { Connections } from "../connections/service.js";
import type { ServerStatuses } from "../ops/signals.js";
import type { Resources } from "../resources/service.js";
import type { Sync } from "../sync/service.js";
import { assertContainerName, CommandError, dockerPrefix } from "./commands.js";
import { lineSplitter } from "./logs.js";
import {
  ContainerError,
  readShellRequest,
  type Containers,
  type ShellChoices,
} from "./service.js";

/** coolify.exec output, stdout and stderr together, is cut at this many bytes. */
export const EXEC_MAX_OUTPUT = 64 * 1024;
/**
 * Raw bytes read from each stream before the command is killed: the
 * redactor never works on more than this per stream.
 */
export const EXEC_RAW_CAP = 128 * 1024;
/** The longest coolify.exec may run, in seconds. */
export const EXEC_MAX_TIMEOUT_SEC = 120;
export const EXEC_DEFAULT_TIMEOUT_SEC = 30;
/** Runs one actor may have going at once, over every resource. */
export const EXEC_MAX_PER_ACTOR = 3;
/** Runs one actor may start in a minute. */
export const EXEC_RATE_PER_MINUTE = 20;
const EXEC_MAX_COMMAND = 16 * 1024;
/** Each chunk is fed to the splitter in slices this long, so its carry stays bounded. */
const FEED_SLICE = 16 * 1024;
const MINUTE_MS = 60_000;

export type ExecErrorCode = "forbidden" | "exec-off" | "busy" | "rate-limited";

/** A refusal of coolify.exec itself. Every one comes before any SSH. */
export class ExecError extends Error {
  readonly code: ExecErrorCode;
  constructor(code: ExecErrorCode, message: string) {
    super(message);
    this.name = "ExecError";
    this.code = code;
  }
}

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

function invalid(message: string): ContainerError {
  return new ContainerError("invalid-input", message);
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

const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{0,40})PRIVATE KEY-----/;

/**
 * Masks private key blocks in lines that redactLog already went through: a
 * block's body, up to its END line (or the output's end), becomes one
 * REDACTED_VALUE line.
 */
function keyBlockFilter(push: (line: string) => void) {
  let open: string | null = null;
  return (line: string) => {
    if (open !== null) {
      const at = line.indexOf(open);
      if (at >= 0) {
        push(line.slice(at));
        open = null;
      }
      return;
    }
    const begin = PEM_BEGIN.exec(line);
    if (!begin) {
      push(line);
      return;
    }
    const head = begin.index + begin[0].length;
    const end = `-----END ${begin[1]}PRIVATE KEY-----`;
    push(line.slice(0, head));
    push(REDACTED_VALUE);
    const at = line.indexOf(end, head);
    if (at >= 0) push(line.slice(at));
    else open = end;
  };
}

/** The part of an ssh2 exec channel coolify.exec uses. */
interface ExecStream {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "exit", listener: (code: unknown) => void): unknown;
  on(event: "close", listener: (code?: unknown) => void): unknown;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  end(data: string): unknown;
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

function byteLength(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  return chunk instanceof Uint8Array ? chunk.length : 0;
}

/** A chunk in slices of at most FEED_SLICE bytes (strings by characters). */
function slices(chunk: unknown): unknown[] {
  if (byteLength(chunk) <= FEED_SLICE) return [chunk];
  const out: unknown[] = [];
  const length = (chunk as string | Uint8Array).length;
  for (let i = 0; i < length; i += FEED_SLICE) {
    out.push((chunk as string | Uint8Array).slice(i, i + FEED_SLICE));
  }
  return out;
}

export interface ExecDeps {
  connections: Connections;
  containers: Containers;
  sync: Pick<Sync, "linkedHostFor">;
  resources: Pick<Resources, "invalidate">;
  servers: Pick<ServerStatuses, "invalidate">;
}

/**
 * coolify.exec: runs one command in a resource's container and returns its
 * output, redacted and cut at 64 KB.
 *
 * Every refusal comes before any SSH: coolify.operate, the admin setting
 * allowExec, the owner's execEnabled (read from one snapshot of the
 * connection), lifecycle's authorize (the uuid in that connection's own
 * list), the Linked host and the actor's own edit access to it, one run per
 * actor and resource (EXEC_MAX_PER_ACTOR in all) and EXEC_RATE_PER_MINUTE.
 * The snapshot's revision is checked again right before ctx.ssh.connect and
 * right before the exec is written; a change ends with target-changed and
 * sends nothing. The container name comes only from the resolved resource
 * and passes assertContainerName; the command goes to `sh -s` on standard
 * input only. stdout and stderr each go through logs' lineSplitter (so
 * redactLog with the snapshot's secrets, and long lines cut the same way)
 * and then a private key block mask. The timeout, an abort or the output cap
 * kills the remote process (KILL), closes the channel and ends the SSH
 * connection. The audit holds only lengths and the exit code.
 */
export function createExec(ctx: PluginContext, deps: ExecDeps) {
  const running = new Map<string, number>();
  const started = new Map<string, number[]>();

  function claim(actor: string, key: string): () => void {
    const now = Date.now();
    const recent = (started.get(actor) ?? []).filter(
      (at) => now - at < MINUTE_MS,
    );
    started.set(actor, recent);
    if (running.has(key)) {
      throw new ExecError(
        "busy",
        "A command is already running in this resource for you. Wait for it to finish.",
      );
    }
    let mine = 0;
    for (const k of running.keys()) if (k.startsWith(`${actor}\u0000`)) mine++;
    if (mine >= EXEC_MAX_PER_ACTOR) {
      throw new ExecError(
        "busy",
        `You already have ${EXEC_MAX_PER_ACTOR} commands running. Wait for one to finish.`,
      );
    }
    if (recent.length >= EXEC_RATE_PER_MINUTE) {
      throw new ExecError(
        "rate-limited",
        "Too many commands in the last minute. Try again shortly.",
      );
    }
    recent.push(now);
    running.set(key, now);
    return () => running.delete(key);
  }

  async function audit(
    found: { hostId: number; container: string },
    details: {
      commandLength: number;
      stdoutLength: number;
      stderrLength: number;
      exitCode: number | null;
    },
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

  async function assertEdit(hostId: number): Promise<void> {
    const access = await ctx.hosts.checkAccess(hostId, "edit");
    if (!access?.hasAccess) {
      throw new ContainerError(
        "no-host-access",
        "Running a command needs your own edit access to this server's Linked host.",
      );
    }
  }

  return {
    async exec(
      connectionId: number,
      uuid: string,
      body: unknown,
      signal?: AbortSignal,
    ): Promise<ExecAnswer | ShellChoices> {
      const request = readExecRequest(body);
      if ((await ctx.rbac.has("operate")) !== true) {
        throw new ExecError(
          "forbidden",
          "Running a command needs Operate Coolify resources.",
        );
      }
      if ((await ctx.settings.get("allowExec")) !== true) {
        throw new ExecError(
          "exec-off",
          "Running commands in containers is turned off by an admin.",
        );
      }
      // Read once: every later step is checked against this target.
      const snap = await deps.connections.snapshot(connectionId);
      if (snap.view.execEnabled !== true) {
        throw new ExecError(
          "exec-off",
          "The connection's owner hasn't allowed running commands in its containers.",
        );
      }
      // Edit access before locate, whose docker probes are already SSH.
      const { serverUuid } = await deps.containers.target(
        connectionId,
        uuid,
        request.part,
      );
      const linked = serverUuid
        ? await deps.sync.linkedHostFor(connectionId, serverUuid)
        : null;
      if (!linked) {
        throw new ContainerError(
          "not-linked",
          "Link this server first: sync it from Coolify to make it a Linked host.",
        );
      }
      await assertEdit(linked);

      const actor = ctx.currentActor() ?? "";
      const release = claim(
        actor,
        `${actor}\u0000${connectionId}\u0000${uuid}\u0000${request.part ?? ""}`,
      );
      let reached = false;
      try {
        const located = await deps.containers.locate(
          connectionId,
          snap,
          uuid,
          request,
        );
        if (located.kind === "choices") return { choices: located.choices };
        const { where, sudo, container: chosen } = located;
        const { hostId } = where;
        if (hostId !== linked) await assertEdit(hostId);
        if (!chosen.running) {
          throw new ContainerError(
            "not-running",
            "The container isn't running.",
          );
        }
        let container: string;
        try {
          container = assertContainerName(chosen.name);
        } catch (err) {
          if (err instanceof CommandError) {
            throw new ContainerError("container-not-found", err.message);
          }
          throw err;
        }
        const command = `${dockerPrefix(sudo)} exec -i ${container} sh -s`;
        const secrets = await snap.secrets();
        if (signal?.aborted) throw cancelled();

        await deps.containers.assertSnapshotHolds(connectionId, snap);
        reached = true;
        const connection = await deps.containers.guard(where, () =>
          ctx.ssh.connect(hostId, {
            purpose: "coolify",
            profile: "background",
          }),
        );
        let stream: ExecStream | null = null;
        let stopped = false;
        const kill = () => {
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
        };
        const stop = () => {
          if (stopped) return;
          stopped = true;
          kill();
          connection.dispose();
        };

        const out: string[] = [];
        const err: string[] = [];
        let used = 0;
        let truncated = false;
        let timedOut = false;
        let exitCode: number | null = null;
        let finish: (() => void) | null = null;
        let fail: ((e: Error) => void) | null = null;
        const keep = (into: string[]) => (line: string) => {
          if (truncated) return;
          const text = `${line}\n`;
          const size = Buffer.byteLength(text);
          if (used + size > EXEC_MAX_OUTPUT) {
            into.push(cutBytes(text, EXEC_MAX_OUTPUT - used));
            used = EXEC_MAX_OUTPUT;
            truncated = true;
            stop();
            finish?.();
            return;
          }
          into.push(text);
          used += size;
        };
        const outLines = keyBlockFilter(keep(out));
        const errLines = keyBlockFilter(keep(err));
        const outSplit = lineSplitter(secrets, (lines) =>
          lines.forEach(outLines),
        );
        const errSplit = lineSplitter(secrets, (lines) =>
          lines.forEach(errLines),
        );
        const reader = (split: typeof outSplit) => {
          let raw = 0;
          return (chunk: unknown) => {
            for (const piece of slices(chunk)) {
              if (stopped || truncated) return;
              // Nothing past the raw cap reaches the redactor.
              if (raw + byteLength(piece) > EXEC_RAW_CAP) {
                truncated = true;
                stop();
                finish?.();
                return;
              }
              raw += byteLength(piece);
              split.data(piece);
            }
          };
        };

        const onAbort = () => {
          // Settle first: closing the channel ends it with a close event.
          fail?.(cancelled());
          stop();
        };
        const done = new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        // Awaited below; this only keeps an early abort from going unhandled.
        done.catch(() => {});
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
          finish?.();
        }, request.timeoutSec * 1000);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          // Right before the exec is written: a changed target gets nothing.
          await deps.containers.assertSnapshotHolds(connectionId, snap);
          if (signal?.aborted) throw cancelled();
          stream = await new Promise<ExecStream>((resolve, reject) => {
            (connection.client as ExecClient).exec(
              command,
              { pty: false },
              (e, opened) => (e ? reject(e) : resolve(opened)),
            );
          }).catch(() => {
            throw new ContainerError(
              "ssh-failed",
              "The command could not start on the Linked host.",
            );
          });
          if (stopped) {
            // Aborted or timed out while the channel opened.
            kill();
            await done;
          } else {
            stream.on("data", reader(outSplit));
            stream.stderr?.on("data", reader(errSplit));
            stream.on("exit", (code) => {
              if (typeof code === "number") exitCode = code;
            });
            stream.on("close", (code) => {
              if (exitCode === null && typeof code === "number") {
                exitCode = code;
              }
              if (!stopped) {
                outSplit.end();
                errSplit.end();
              }
              finish?.();
            });
            stream.end(request.command);
            await done;
          }
        } catch (e) {
          stop();
          await audit(
            { hostId, container },
            {
              commandLength: request.command.length,
              stdoutLength: 0,
              stderrLength: 0,
              exitCode: null,
            },
            false,
          );
          throw e;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
        stop();
        if (timedOut || truncated) exitCode = null;
        const stdout = out.join("");
        const stderr = err.join("");
        await audit(
          { hostId, container },
          {
            commandLength: request.command.length,
            stdoutLength: Buffer.byteLength(stdout),
            stderrLength: Buffer.byteLength(stderr),
            exitCode,
          },
          exitCode === 0,
        );
        return {
          hostId,
          container,
          exitCode,
          timedOut,
          truncated,
          stdout,
          stderr,
        };
      } finally {
        release();
        if (reached) {
          // The command may have changed anything the caches hold.
          await Promise.all([
            deps.resources.invalidate(connectionId),
            deps.servers.invalidate(connectionId),
          ]);
        }
      }
    },
  };
}

function cancelled(): Error {
  const err = new Error("The command was cancelled.");
  err.name = "ExecCancelled";
  return err;
}

export type Exec = ReturnType<typeof createExec>;
