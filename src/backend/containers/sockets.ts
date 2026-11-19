import type {
  PluginContext,
  PluginWebSocketConnection,
} from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError, type Connections } from "../connections/service.js";
import { CoolifyError, toRouteError } from "../coolify/http.js";
import { assertContainerName } from "./commands.js";
import type { Following, Logs } from "./logs.js";
import { ContainerError, type Containers } from "./service.js";

/** Served at /plugin-ws/coolify/logs. */
export const LOG_SOCKET_PATH = "/logs";

/** The part of a ws WebSocket this route uses. */
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

const OPEN = 1;
/** Policy violation: the close code for a refusal. */
const REFUSED = 1008;
const FLUSH_MS = 250;
/** At most 2,000 lines a second reach the browser; older ones are dropped. */
const MAX_PER_FLUSH = 500;
const MAX_BUFFER = 2_000;
const MAX_MESSAGE = 4 * 1024;

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/** Causes that end the socket: the caller may not have these logs. */
const REFUSALS: ReadonlySet<string> = new Set([
  "locked",
  "forbidden",
  "not-found",
  "no-host-access",
]);

interface Subscribe {
  connectionId: number;
  uuid: string;
  part?: string;
  container?: string;
  timestamps: boolean;
}

interface Failure {
  cause: string;
  error: string;
  extra?: Record<string, unknown>;
}

function textOf(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  return null;
}

function parse(data: unknown): Record<string, unknown> | null {
  const text = textOf(data);
  if (text === null || text.length > MAX_MESSAGE) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function invalid(message: string): ContainerError {
  return new ContainerError("invalid-input", message);
}

/** Checks a subscribe message; every value is checked as a route would. */
function readSubscribe(message: Record<string, unknown>): Subscribe {
  const rawId = message.connectionId;
  const id =
    typeof rawId === "number"
      ? rawId
      : typeof rawId === "string" && /^\d{1,15}$/.test(rawId)
        ? Number(rawId)
        : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ConnectionError("not-found", "Coolify connection not found");
  }
  if (typeof message.uuid !== "string" || !UUID.test(message.uuid)) {
    throw new ContainerError("not-found", "Coolify resource not found");
  }
  const out: Subscribe = {
    connectionId: id,
    uuid: message.uuid,
    timestamps: message.timestamps === true,
  };
  const { part, container } = message;
  if (part !== undefined && part !== null && part !== "") {
    if (typeof part !== "string" || !UUID.test(part)) {
      throw invalid("part must be a Part's uuid");
    }
    out.part = part;
  }
  if (container !== undefined && container !== null && container !== "") {
    try {
      out.container = assertContainerName(container);
    } catch {
      throw invalid("container must be a container name");
    }
  }
  return out;
}

/** A fixed message per cause; nothing from SSH output or Coolify's answer. */
function failureOf(err: unknown): Failure {
  if (err instanceof ContainerError) {
    return { cause: err.code, error: err.message, extra: err.extra };
  }
  if (err instanceof ConnectionError) {
    return { cause: err.code, error: err.message };
  }
  if (err instanceof CoolifyError) {
    const { body } = toRouteError(err);
    return { cause: body.cause, error: body.error };
  }
  return { cause: "failed", error: "The logs could not be followed." };
}

/**
 * WS /logs: follows a container's logs over SSH on its Linked host.
 *
 * Client messages: `{ type: "subscribe", connectionId, uuid, part?,
 * container?, timestamps? }`, `{ type: "unsubscribe" }`, and anything else
 * (a ping) to keep it checked. Answers: `started { source: "ssh", container }`,
 * `lines { lines, dropped? }`, `choices`, `stopped`, `ended` and
 * `error { cause, error }`.
 *
 * Every message is checked first: the session's data must be unlocked, and
 * the actor must hold coolify.operate, still reach the connection and still
 * have connect access to the Linked host. A refusal ends the follow, kills
 * the remote docker logs and closes the socket with 1008. Closing the socket
 * or unsubscribing kills it too.
 */
export function registerLogSocket(
  ctx: PluginContext,
  deps: { logs: Logs; connections: Connections; containers: Containers },
): void {
  ctx.ws.route(LOG_SOCKET_PATH, (conn: PluginWebSocketConnection) => {
    const socket = conn.socket as WsLike;
    const userId = conn.userId;
    let active: Following | null = null;
    let buffer: string[] = [];
    let dropped = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    let queue: Promise<void> = Promise.resolve();

    function send(message: Record<string, unknown>): void {
      if (socket.readyState !== OPEN) return;
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // The socket is closing; its close handler stops the follow.
      }
    }

    function stopFollow(): void {
      if (timer) clearInterval(timer);
      timer = null;
      active?.stop();
      active = null;
      buffer = [];
      dropped = 0;
    }

    function refuse(failure: Failure): void {
      send({ type: "error", cause: failure.cause, error: failure.error });
      stopFollow();
      done = true;
      try {
        socket.close(REFUSED, failure.cause);
      } catch {
        // Already closed.
      }
    }

    function fail(err: unknown): void {
      const failure = failureOf(err);
      if (REFUSALS.has(failure.cause)) {
        refuse(failure);
        return;
      }
      stopFollow();
      send({
        type: "error",
        cause: failure.cause,
        error: failure.error,
        ...(failure.extra ?? {}),
      });
    }

    const locked: Failure = {
      cause: "locked",
      error: "Your session is locked. Sign in again to follow logs.",
    };
    const forbidden: Failure = {
      cause: "forbidden",
      error: "Following logs needs the coolify.operate permission.",
    };

    function flush(): void {
      if (!buffer.length && !dropped) return;
      if (!conn.isDataUnlocked()) {
        refuse(locked);
        return;
      }
      const lines = buffer.splice(0, MAX_PER_FLUSH);
      send({ type: "lines", lines, ...(dropped ? { dropped } : {}) });
      dropped = 0;
    }

    const sink = {
      lines(lines: string[]) {
        if (done) return;
        buffer.push(...lines);
        const over = buffer.length - MAX_BUFFER;
        if (over > 0) {
          buffer.splice(0, over);
          dropped += over;
        }
      },
      end() {
        if (done) return;
        flush();
        stopFollow();
        send({ type: "ended" });
      },
    };

    /** Null while the actor still may read this follow; else why not. */
    async function recheck(following: Following): Promise<unknown> {
      const { connectionId, hostId } = following.where;
      if (!(await deps.connections.access(connectionId))) {
        return new ConnectionError("not-found", "Coolify connection not found");
      }
      try {
        await deps.containers.assertHostAccess(hostId);
        return null;
      } catch (err) {
        return err;
      }
    }

    async function handle(data: unknown): Promise<void> {
      if (done) return;
      if (!conn.isDataUnlocked()) {
        refuse(locked);
        return;
      }
      const message = parse(data);
      if (!message) {
        send({
          type: "error",
          cause: "invalid-input",
          error: "A JSON object is required",
        });
        return;
      }
      // Core runs a socket's events as the user who opened it. Anything else
      // (no actor at all) is refused rather than run as nobody in particular.
      if (!userId || ctx.currentActor() !== userId) {
        refuse(forbidden);
        return;
      }
      if (!(await ctx.rbac.has("operate"))) {
        refuse(forbidden);
        return;
      }
      if (active) {
        const lost = await recheck(active);
        if (lost) {
          fail(lost);
          return;
        }
      }
      if (message.type === "subscribe") {
        stopFollow();
        const request = readSubscribe(message);
        const result = await deps.logs.follow(
          request.connectionId,
          request.uuid,
          request,
          sink,
        );
        if ("choices" in result) {
          send({ type: "choices", choices: result.choices });
          return;
        }
        if (done) {
          result.stop();
          return;
        }
        active = result;
        timer = setInterval(flush, FLUSH_MS);
        send({ type: "started", source: "ssh", container: result.container });
        return;
      }
      if (message.type === "unsubscribe") {
        stopFollow();
        send({ type: "stopped" });
        return;
      }
      send({ type: "pong" });
    }

    socket.on("message", (data) => {
      queue = queue.then(() => handle(data)).catch((err) => fail(err));
    });
    socket.on("close", () => {
      done = true;
      stopFollow();
    });
    socket.on("error", () => {
      done = true;
      stopFollow();
    });
  });
}
