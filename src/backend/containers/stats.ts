import type {
  PluginContext,
  PluginWebSocketConnection,
} from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError, type Connections } from "../connections/service.js";
import { CoolifyError, toRouteError } from "../coolify/http.js";
import { sshRunner, type SshRunner } from "../ssh.js";
import { assertContainerName, dockerPrefix } from "./commands.js";
import {
  ContainerError,
  readShellRequest,
  type Containers,
} from "./service.js";

/** How often the live readout runs docker stats. */
export const STATS_INTERVAL_MS = 3_000;
const MAX_MESSAGE = 4_096;

/** One docker stats reading. Bytes are bytes; percentages are 0 to 100. */
export interface StatsSample {
  cpu: number;
  memPct: number;
  memBytes: number;
  netRx: number;
  netTx: number;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

function size(text: string | undefined): number | null {
  const match = /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(text ?? "");
  if (!match) return null;
  const unit = UNITS[match[2].toLowerCase()];
  const value = Number(match[1]);
  return unit && Number.isFinite(value) ? Math.round(value * unit) : null;
}

function percent(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const value = Number(text.trim().replace(/%$/, ""));
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
}

/** One line of `docker stats --format '{{json .}}'`, or null. */
export function parseDockerStats(line: string): StatsSample | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const cpu = percent(raw.CPUPerc);
  const memPct = percent(raw.MemPerc);
  const [used] = String(raw.MemUsage ?? "").split("/");
  const [rx, tx] = String(raw.NetIO ?? "").split("/");
  const memBytes = size(used);
  const netRx = size(rx);
  const netTx = size(tx);
  if (
    cpu === null ||
    memPct === null ||
    memBytes === null ||
    netRx === null ||
    netTx === null
  ) {
    return null;
  }
  return { cpu, memPct, memBytes, netRx, netTx };
}

/** One docker stats reading of one container, the format quoted for the shell. */
export function statsCommand(container: string, sudo: boolean): string {
  const name = assertContainerName(container);
  return `${dockerPrefix(sudo)} stats --no-stream --format '{{json .}}' ${name}`;
}

/** The ws socket, as far as this module uses it. */
interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (data: unknown) => void): void;
  on(event: "close", fn: () => void): void;
}

interface Subscription {
  connectionId: number;
  hostId: number;
  container: string;
  sudo: boolean;
}

export interface StatsSocketDeps {
  connections: Connections;
  containers: Containers;
  run?: SshRunner;
}

type Refusal = {
  error: string;
  cause: string;
  extra?: Record<string, unknown>;
};

function refusalOf(err: unknown): Refusal {
  if (err instanceof ContainerError) {
    return { error: err.message, cause: err.code, extra: err.extra };
  }
  if (err instanceof ConnectionError) {
    return { error: err.message, cause: err.code };
  }
  if (err instanceof CoolifyError) return toRouteError(err).body;
  return { error: "The live stats could not be read.", cause: "failed" };
}

/**
 * WS /stats: send `{ connectionId, uuid, part?, container? }` and the socket
 * answers `{ type: "stats", ... }` every 3 seconds while it is open, or
 * `{ type: "choices" }` or `{ type: "error", cause }`. `{ type: "unsubscribe" }`
 * or closing stops it. Every message and every tick checks the session is
 * unlocked, the socket's user is the acting user, coolify.operate, access to
 * the connection and connect access to the Linked host. Nothing here throws:
 * errors count against the plugin's budget.
 */
export const STATS_SOCKET_PATH = "/stats";

export function registerStatsSocket(
  ctx: PluginContext,
  deps: StatsSocketDeps,
): void {
  const run = deps.run ?? sshRunner(ctx);

  ctx.ws.route(STATS_SOCKET_PATH, (conn: PluginWebSocketConnection) => {
    const socket = conn.socket as WsLike;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function send(message: Record<string, unknown>) {
      if (closed) return;
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // The socket is going away; close will stop the timer.
      }
    }

    function stop() {
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function refuse(refusal: Refusal) {
      stop();
      send({
        type: "error",
        error: refusal.error,
        cause: refusal.cause,
        ...(refusal.extra ?? {}),
      });
      if (refusal.cause === "locked") {
        try {
          socket.close(1008, "locked");
        } catch {
          // Already closing.
        }
      }
    }

    /** The session-level checks every message and tick makes, or a refusal. */
    async function sessionRefusal(): Promise<Refusal | null> {
      if (!conn.isDataUnlocked()) {
        return { error: "The session is locked.", cause: "locked" };
      }
      // Fail closed: the work must run as the socket's own user.
      if (!conn.userId || ctx.currentActor() !== conn.userId) {
        return { error: "Not allowed.", cause: "forbidden" };
      }
      if (!(await ctx.rbac.has("operate"))) {
        return {
          error: "Live stats need coolify.operate.",
          cause: "forbidden",
        };
      }
      return null;
    }

    async function tick(sub: Subscription, gen: number): Promise<void> {
      try {
        const refusal =
          (await sessionRefusal()) ??
          ((await deps.connections.access(sub.connectionId))
            ? null
            : { error: "Coolify connection not found", cause: "not-found" }) ??
          ((await ctx.hosts.checkAccess(sub.hostId, "connect"))?.hasAccess
            ? null
            : {
                error: "You can't open this server's Linked host.",
                cause: "no-host-access",
              });
        if (gen !== generation) return;
        if (refusal) {
          refuse(refusal);
          return;
        }
        const result = await run(
          sub.hostId,
          statsCommand(sub.container, sub.sudo),
          { timeoutMs: 15_000 },
        );
        if (gen !== generation) return;
        const sample =
          result.code === 0
            ? parseDockerStats(result.stdout.trim().split("\n")[0] ?? "")
            : null;
        if (!sample) {
          refuse({
            error: "docker stats gave no reading; is the container running?",
            cause: "no-stats",
          });
          return;
        }
        send({
          type: "stats",
          container: sub.container,
          ...sample,
          at: Date.now(),
        });
        timer = setTimeout(() => void tick(sub, gen), STATS_INTERVAL_MS);
      } catch (err) {
        if (gen === generation) refuse(refusalOf(err));
      }
    }

    async function subscribe(body: Record<string, unknown>): Promise<void> {
      stop();
      const gen = generation;
      const refusal = await sessionRefusal();
      if (refusal) {
        refuse(refusal);
        return;
      }
      const raw = body.connectionId;
      const connectionId =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^\d{1,15}$/.test(raw)
            ? Number(raw)
            : NaN;
      if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
        refuse({ error: "Coolify connection not found", cause: "not-found" });
        return;
      }
      const uuid = typeof body.uuid === "string" ? body.uuid : "";
      const snap = await deps.connections.snapshot(connectionId);
      const found = await deps.containers.locate(
        connectionId,
        snap,
        uuid,
        readShellRequest({ part: body.part, container: body.container }),
      );
      if (gen !== generation) return;
      if (found.kind === "choices") {
        send({ type: "choices", choices: found.choices });
        return;
      }
      if (!found.container.running) {
        refuse({ error: "The container isn't running.", cause: "not-running" });
        return;
      }
      await tick(
        {
          connectionId,
          hostId: found.where.hostId,
          container: found.container.name,
          sudo: found.sudo,
        },
        gen,
      );
    }

    async function onMessage(data: unknown): Promise<void> {
      try {
        const text = String(data ?? "");
        if (text.length > MAX_MESSAGE) throw new SyntaxError("too long");
        const body = JSON.parse(text) as unknown;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new SyntaxError("not an object");
        }
        const message = body as Record<string, unknown>;
        if (message.type === "unsubscribe") {
          stop();
          return;
        }
        await subscribe(message);
      } catch (err) {
        if (err instanceof SyntaxError) {
          refuse({
            error: "Send { connectionId, uuid } as JSON.",
            cause: "invalid-input",
          });
          return;
        }
        refuse(refusalOf(err));
      }
    }

    socket.on("message", (data) => void onMessage(data));
    socket.on("close", () => {
      closed = true;
      stop();
    });
  });
}
