import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../connections/service.js";
import type { Previews } from "../previews/service.js";
import { handoffIdFor } from "../status/service.js";
import { connectionIdInput } from "./connections.js";
import { holdHandoff, takeLogText } from "./containers.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function previewLogHandoff(handoffId: string): string {
  return `preview-log:${handoffId}`;
}

/**
 * The redacted log text of one coolify.preview-logs run, once, to the user
 * who ran it. Run history never holds it (a sensitive output).
 */
export function takePreviewLogText(
  userId: string,
  handoffId: unknown,
): string | null {
  return typeof handoffId === "string"
    ? takeLogText(userId, previewLogHandoff(handoffId))
    : null;
}

/**
 * coolify.preview-list (read), coolify.preview-create and
 * coolify.preview-domains (changes; MCP asks for confirmed: true),
 * coolify.preview-delete (destructive, so core confirms first) and
 * coolify.preview-logs (a sensitive output that needs confirm: true, as
 * container logs do). Each takes the application's uuid.
 */
export function registerPreviewOperations(
  ctx: PluginContext,
  previews: Previews,
): void {
  ctx.operations.register("coolify.preview-list", {
    run: async (input, { signal }) => {
      const { rows } = await previews.list(
        connectionIdInput(input),
        text(input.uuid),
        signal,
      );
      return {
        summary: `${rows.length} preview${rows.length === 1 ? "" : "s"}`,
        data: {
          rows,
          options: rows.map((r) => ({
            value: String(r.pullRequestId),
            label: `#${r.pullRequestId} ${r.status}`,
          })),
        },
      };
    },
  });

  ctx.operations.register("coolify.preview-create", {
    run: async (input, { signal }) => {
      const answer = await previews.create(
        connectionIdInput(input),
        text(input.uuid),
        input,
        signal,
      );
      return {
        summary: answer.deploymentUuid
          ? `Deploying the preview of pull request #${answer.pullRequestId}: ${answer.deploymentUuid}`
          : `Opened the preview of pull request #${answer.pullRequestId}`,
        changed: true,
        data: answer,
      };
    },
  });

  ctx.operations.register("coolify.preview-domains", {
    run: async (input, { signal }) => {
      const answer = await previews.setDomains(
        connectionIdInput(input),
        text(input.uuid),
        input.pullRequestId,
        input,
        signal,
      );
      return {
        summary: `Changed the domains of the preview of pull request #${answer.pullRequestId}`,
        changed: true,
        data: answer,
      };
    },
  });

  ctx.operations.register("coolify.preview-delete", {
    run: async (input, { signal }) => {
      const answer = await previews.remove(
        connectionIdInput(input),
        text(input.uuid),
        input.pullRequestId,
        signal,
      );
      return {
        summary: `Deleting the preview of pull request #${answer.pullRequestId}`,
        changed: true,
        data: answer,
      };
    },
  });

  ctx.operations.register("coolify.preview-logs", {
    run: async (input, { runId, signal }) => {
      // Logs carry secrets: an ops run or MCP call reads them only when the
      // caller asked for exactly that.
      if (input.confirm !== true) {
        throw new ConnectionError(
          "invalid-input",
          "Reading a preview's logs needs confirm: true",
        );
      }
      const answer = await previews.logs(
        connectionIdInput(input),
        text(input.uuid),
        input.pullRequestId,
        { lines: input.lines, timestamps: input.timestamps },
        signal,
      );
      const handoffId = handoffIdFor(runId);
      const userId = ctx.currentActor() ?? "";
      if (userId)
        holdHandoff(userId, previewLogHandoff(handoffId), answer.text);
      const lineCount = answer.text ? answer.text.split("\n").length : 0;
      return {
        summary: `Preview of pull request #${answer.pullRequestId}: ${lineCount} log lines`,
        // text is already redacted and is a sensitive output, so core drops
        // it before a run is stored; handoffId lets the MCP answer carry it.
        data: {
          pullRequestId: answer.pullRequestId,
          lineCount,
          text: answer.text,
          handoffId,
        },
      };
    },
  });
}
