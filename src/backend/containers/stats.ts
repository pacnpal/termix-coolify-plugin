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

export const STATS_SOCKET_PATH = "/stats";

/** The ws socket, as far as this module uses it. */
interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (data: unknown) => void): void;
  on(event: "close" | "error", fn: () => void): void;
}

type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

interface Subscription {
  connectionId: number;
  uuid: string;
  part?: string;
  snap: Snapshot;
  hostId: number;
  container: string;
  sudo: boolean;
}

export interface StatsSocketDeps {
  connections: Pick<Connections, "snapshot">;
  containers: Pick<
    Containers,
    "locate" | "target" | "assertHostAccess" | "assertSnapshotHolds"
  >;
  run?: SshRunner;
}

/** Streams one person may run at once, over all their sockets. */
export const MAX_STREAMS_PER_USER = 3;
/** The shortest gap between two subscribes on one socket. */
export const SUBSCRIBE_GAP_MS = 1_000;
/** docker stats prints one short line; anything longer is not a reading. */
const MAX_STATS_BYTES = 4_096;
/** Policy violation: the close code for a refusal. */
const REFUSED = 1008;

/** Causes that end the socket: the caller may not have these stats. */
const REFUSALS: ReadonlySet<string> = new Set([
  "locked",
  "forbidden",
  "not-found",
  "no-host-access",
  "target-changed",
]);

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
 * or closing stops it. One stream per socket (a new subscribe replaces it),
 * at most one subscribe a second, and MAX_STREAMS_PER_USER per person.
 *
 * Every subscribe and every tick runs as the socket's own user (core runs a
 * socket's events and timers as the user who opened it; anything else is
 * refused) and checks: the session is unlocked, lifecycle's authorize for
 * the resource, the actor's connect access to the Linked host, and that the
 * connection still points at the subscribe's snapshot. A refusal closes the
 * socket with 1008. Nothing here throws: errors count against the plugin.
 */
export function registerStatsSocket(
  ctx: PluginContext,
  deps: StatsSocketDeps,
): void {
  const run = deps.run ?? sshRunner(ctx);
  const streams = new Map<string, number>();

  ctx.ws.route(STATS_SOCKET_PATH, (conn: PluginWebSocketConnection) => {
    const socket = conn.socket as WsLike;
    const userId = conn.userId;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let holding = false;
    let lastSubscribe = -Infinity;
    let closed = false;

    function send(message: Record<string, unknown>) {
      if (closed) return;
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // The socket is going away; close will stop the timer.
      }
    }

    function release() {
      if (!holding || !userId) return;
      holding = false;
      const left = (streams.get(userId) ?? 1) - 1;
      if (left > 0) streams.set(userId, left);
      else streams.delete(userId);
    }

    function stop() {
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      release();
    }

    function refuse(refusal: Refusal) {
      stop();
      send({
        type: "error",
        error: refusal.error,
        cause: refusal.cause,
        ...(refusal.extra ?? {}),
      });
      if (REFUSALS.has(refusal.cause)) {
        closed = true;
        try {
          socket.close(REFUSED, refusal.cause);
        } catch {
          // Already closing.
        }
      }
    }

    /** The session-level checks every message and tick makes, or a refusal. */
    function sessionRefusal(): Refusal | null {
      if (!conn.isDataUnlocked()) {
        return { error: "The session is locked.", cause: "locked" };
      }
      // Fail closed: the work must run as the socket's own user.
      if (!userId || ctx.currentActor() !== userId) {
        return { error: "Not allowed.", cause: "forbidden" };
      }
      return null;
    }

    /** Everything a subscribe checked, again, as the socket's user. */
    async function recheck(sub: Subscription): Promise<void> {
      await deps.containers.assertSnapshotHolds(sub.connectionId, sub.snap);
      await deps.containers.target(sub.connectionId, sub.uuid, sub.part);
      await deps.containers.assertHostAccess(sub.hostId);
      // Again last: the checks above can wait (a fetch, the request budget),
      // and docker stats must run against the target that was checked.
      await deps.containers.assertSnapshotHolds(sub.connectionId, sub.snap);
    }

    async function tick(sub: Subscription, gen: number): Promise<void> {
      try {
        const refusal = sessionRefusal();
        if (refusal) {
          refuse(refusal);
          return;
        }
        await recheck(sub);
        if (gen !== generation) return;
        const result = await run(
          sub.hostId,
          statsCommand(sub.container, sub.sudo),
          { timeoutMs: 15_000, maxOutputBytes: MAX_STATS_BYTES },
        );
        if (gen !== generation) return;
        // The answer belongs to the target that was checked: a change while
        // docker stats ran withholds it.
        await deps.containers.assertSnapshotHolds(sub.connectionId, sub.snap);
        if (gen !== generation) return;
        const sample =
          result.code === 0 && !result.truncated
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
        // Core runs a socket's events, and the timers they start, as the
        // user who opened it; sessionRefusal fails closed if it ever doesn't.
        timer = setTimeout(() => void tick(sub, gen), STATS_INTERVAL_MS);
      } catch (err) {
        if (gen === generation) refuse(refusalOf(err));
      }
    }

    /**
     * Each subscribe has its own generation. A newer one (or unsubscribe or
     * close) bumps it, so an older lookup's answer or failure is dropped and
     * can never stop the stream that replaced it.
     */
    async function subscribe(body: Record<string, unknown>): Promise<void> {
      stop();
      const gen = generation;
      try {
        await subscribeAs(body, gen);
      } catch (err) {
        if (gen === generation) refuse(refusalOf(err));
      }
    }

    async function subscribeAs(
      body: Record<string, unknown>,
      gen: number,
    ): Promise<void> {
      const refusal = sessionRefusal();
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
      const request = readShellRequest({
        part: body.part,
        container: body.container,
      });
      const snap = await deps.connections.snapshot(connectionId);
      const found = await deps.containers.locate(
        connectionId,
        snap,
        uuid,
        request,
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
      const held = streams.get(userId) ?? 0;
      if (held >= MAX_STREAMS_PER_USER) {
        refuse({
          error: `At most ${MAX_STREAMS_PER_USER} live stats at once.`,
          cause: "too-many-streams",
        });
        return;
      }
      streams.set(userId, held + 1);
      holding = true;
      await tick(
        {
          connectionId,
          uuid,
          part: request.part,
          snap,
          hostId: found.where.hostId,
          container: found.container.name,
          sudo: found.sudo,
        },
        gen,
      );
    }

    async function onMessage(data: unknown): Promise<void> {
      if (closed) return;
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
        const at = Date.now();
        if (at - lastSubscribe < SUBSCRIBE_GAP_MS) {
          send({
            type: "error",
            error: "One subscribe a second.",
            cause: "rate-limited",
          });
          return;
        }
        lastSubscribe = at;
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
    const end = () => {
      closed = true;
      stop();
    };
    socket.on("close", end);
    socket.on("error", end);
  });
}
