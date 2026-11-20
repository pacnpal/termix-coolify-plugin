import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ContainerError, type Containers } from "../containers/service.js";
import type { Exec } from "../containers/exec.js";
import type { Logs } from "../containers/logs.js";
import { handoffIdFor } from "../status/service.js";
import { connectionIdInput } from "./connections.js";

/** How long a logs-tail text waits for its MCP answer, in this process only. */
const LOG_HANDOFF_TTL_MS = 60_000;
/** The most log text held for handoffs at once; the oldest go first. */
const LOG_HANDOFF_MAX_CHARS = 16 * 1024 * 1024;
const logHandoffs = new Map<string, { text: string; expiresAt: number }>();

function logKey(userId: string, handoffId: string): string {
  return `${userId}\u0000${handoffId}`;
}

function sweepLogs(now: number): void {
  let total = 0;
  for (const [key, entry] of logHandoffs) {
    if (entry.expiresAt <= now) logHandoffs.delete(key);
    else total += entry.text.length;
  }
  for (const [key, entry] of logHandoffs) {
    if (total <= LOG_HANDOFF_MAX_CHARS) break;
    logHandoffs.delete(key);
    total -= entry.text.length;
  }
}

/**
 * The redacted text of one logs-tail run, once, to the user who ran it.
 * Run history never holds it (the output is sensitive), so the MCP answer
 * takes it from here; another user, a second take or an expired entry gets
 * null.
 */
export function takeLogText(userId: string, handoffId: unknown): string | null {
  if (!userId || typeof handoffId !== "string") return null;
  sweepLogs(Date.now());
  const key = logKey(userId, handoffId);
  const entry = logHandoffs.get(key);
  if (!entry) return null;
  logHandoffs.delete(key);
  return entry.text;
}

/** Keeps a sensitive answer for its one MCP take (exec, web UI). */
export function holdHandoff(
  userId: string,
  handoffId: string,
  text: string,
): void {
  sweepLogs(Date.now());
  logHandoffs.set(logKey(userId, handoffId), {
    text,
    expiresAt: Date.now() + LOG_HANDOFF_TTL_MS,
  });
}

function execHandoff(handoffId: string): string {
  return `exec:${handoffId}`;
}

/** The redacted output of one coolify.exec run, once, to the user who ran it. */
export function takeExecOutput(
  userId: string,
  handoffId: unknown,
): { stdout: string; stderr: string } | null {
  if (typeof handoffId !== "string") return null;
  const kept = takeLogText(userId, execHandoff(handoffId));
  return kept === null ? null : JSON.parse(kept);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * coolify.shell-command: the exact docker exec line, for an API or MCP client
 * with its own SSH. It goes through the same checks as the shell route,
 * including the actor's connect access to the Linked host.
 *
 * coolify.logs-tail: the same snapshot as the logs route, labelled with its
 * source. The text is a sensitive output, so run history never keeps it,
 * and it needs confirm: true.
 */
export function registerContainerOperations(
  ctx: PluginContext,
  containers: Containers,
  logs: Logs,
  exec: Exec,
): void {
  ctx.operations.register("coolify.shell-command", {
    run: async (input) => {
      const id = connectionIdInput(input);
      const answer = await containers.shell(id, text(input.uuid), {
        part: text(input.part) || undefined,
        container: text(input.container) || undefined,
        console: text(input.console) || undefined,
      });
      if ("choices" in answer) {
        return {
          summary: `${answer.choices.length} containers match; pick one with container`,
          data: { choices: answer.choices },
        };
      }
      return {
        summary: `docker exec into ${answer.container} on host ${answer.hostId}`,
        data: {
          hostId: answer.hostId,
          container: answer.container,
          command: answer.command,
        },
      };
    },
  });

  ctx.operations.register("coolify.logs-tail", {
    run: async (input, { runId, signal }) => {
      // Logs carry secrets: an ops run or MCP call reads them only when the
      // caller asked for exactly that.
      if (input.confirm !== true) {
        throw new ContainerError(
          "invalid-input",
          "Reading logs needs confirm: true",
        );
      }
      const id = connectionIdInput(input);
      const answer = await logs.snapshot(
        id,
        text(input.uuid),
        {
          part: text(input.part) || undefined,
          container: text(input.container) || undefined,
          lines: input.lines,
          timestamps: input.timestamps,
        },
        signal,
      );
      if ("choices" in answer) {
        return {
          summary: `${answer.choices.length} containers match; pick one with container`,
          data: { choices: answer.choices },
        };
      }
      const count = answer.text
        ? answer.text.replace(/\n$/, "").split("\n").length
        : 0;
      const handoffId = handoffIdFor(runId);
      const userId = ctx.currentActor() ?? "";
      if (userId) {
        sweepLogs(Date.now());
        logHandoffs.set(logKey(userId, handoffId), {
          text: answer.text,
          expiresAt: Date.now() + LOG_HANDOFF_TTL_MS,
        });
      }
      return {
        summary: `${count} log lines from ${answer.source === "coolify" ? "Coolify" : "the server over SSH"}`,
        // text is already redacted (redactLog) and is a sensitive output, so
        // core drops it before a run is stored; handoffId lets the MCP answer
        // carry it.
        data: { ...answer, handoffId },
      };
    },
  });

  // coolify.exec: destructive, so core asks for a confirm first. The service
  // refuses before any SSH unless allowExec, the connection's execEnabled,
  // coolify.operate and edit access to the Linked host all hold. The summary
  // never repeats the command.
  ctx.operations.register("coolify.exec", {
    run: async (input, { runId, signal }) => {
      const id = connectionIdInput(input);
      const answer = await exec.exec(
        id,
        text(input.uuid),
        {
          part: text(input.part) || undefined,
          container: text(input.container) || undefined,
          command: input.command,
          timeoutSec: input.timeoutSec,
        },
        signal,
      );
      if ("choices" in answer) {
        return {
          summary: `${answer.choices.length} containers match; pick one with container`,
          data: { choices: answer.choices },
        };
      }
      const status = answer.timedOut
        ? "timed out"
        : `exit code ${answer.exitCode ?? "none"}`;
      const handoffId = handoffIdFor(runId);
      const userId = ctx.currentActor() ?? "";
      if (userId) {
        holdHandoff(
          userId,
          execHandoff(handoffId),
          JSON.stringify({ stdout: answer.stdout, stderr: answer.stderr }),
        );
      }
      return {
        summary: `Ran a command in ${answer.container} on host ${answer.hostId}: ${status}${answer.truncated ? ", output cut at 64 KB" : ""}`,
        changed: true,
        // stdout and stderr are already redacted and are sensitive outputs,
        // so core drops them before a run is stored; handoffId lets the MCP
        // answer carry them, once.
        data: { ...answer, handoffId },
      };
    },
  });
}
