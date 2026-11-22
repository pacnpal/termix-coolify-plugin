import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../connections/service.js";
import { readTagDeploy } from "../deployments/by-tag.js";
import { queueBody, refreshFlag } from "../deployments/queue.js";
import { readPaging, type Deployments } from "../deployments/service.js";
import { handoffIdFor } from "../status/service.js";
import { connectionIdInput } from "./connections.js";
import { holdHandoff, takeLogText } from "./containers.js";
import { isFailedDeployment } from "../../shared/deployment-status.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildLogHandoff(handoffId: string): string {
  return `build-log:${handoffId}`;
}

/**
 * The redacted build log text of one coolify.deployment-get run, once, to the
 * user who ran it. Run history never holds it (a sensitive output).
 */
export function takeBuildLogText(
  userId: string,
  handoffId: unknown,
): string | null {
  return typeof handoffId === "string"
    ? takeLogText(userId, buildLogHandoff(handoffId))
    : null;
}

/**
 * coolify.deployment-list: an application's deployment history, a page at a
 * time. coolify.deployment-get: one deployment and its build log, redacted;
 * the log is a sensitive output and needs confirm: true, as container logs
 * do. coolify.deployment-cancel: destructive, so core confirms first.
 * `uuid` (the application) is optional for get and cancel: without it the
 * deployment must belong to one of the connection's own applications.
 */
export function registerDeploymentOperations(
  ctx: PluginContext,
  deployments: Deployments,
): void {
  ctx.operations.register("coolify.deployment-list", {
    run: async (input, { signal }) => {
      const page = await deployments.list(
        connectionIdInput(input),
        text(input.uuid),
        readPaging(input),
        signal,
      );
      const total = page.count ?? page.skip + page.rows.length;
      return {
        summary: `${page.rows.length} of ${total} deployment${total === 1 ? "" : "s"}, from ${page.skip + 1}`,
        data: {
          ...page,
          options: page.rows.map((r) => ({
            value: r.uuid,
            label: `${r.createdAt} ${r.status}`,
          })),
        },
      };
    },
  });

  ctx.operations.register("coolify.deployment-get", {
    run: async (input, { runId, signal }) => {
      // Build logs carry secrets: an ops run or MCP call reads them only when
      // the caller asked for exactly that.
      if (input.confirm !== true) {
        throw new ConnectionError(
          "invalid-input",
          "Reading a build log needs confirm: true",
        );
      }
      const detail = await deployments.get(
        connectionIdInput(input),
        text(input.deploymentUuid),
        { resourceUuid: text(input.uuid) || undefined, signal },
      );
      const all = detail.log?.lines ?? [];
      const shown =
        input.showHidden === true ? all : all.filter((l) => !l.hidden);
      const logText = shown.map((l) => l.output).join("\n");
      const handoffId = handoffIdFor(runId);
      const userId = ctx.currentActor() ?? "";
      if (userId) holdHandoff(userId, buildLogHandoff(handoffId), logText);
      const { deployment } = detail;
      return {
        summary: detail.log
          ? `Deployment ${deployment.uuid}: ${deployment.status}, ${shown.length} log lines`
          : `Deployment ${deployment.uuid}: ${deployment.status}; the token can't read build logs (read:sensitive)`,
        // text is already redacted and is a sensitive output, so core drops
        // it before a run is stored; handoffId lets the MCP answer carry it.
        data: {
          deployment,
          final: detail.final,
          cancellable: detail.cancellable,
          logAvailable: detail.log !== null,
          lineCount: shown.length,
          hiddenCount: all.filter((l) => l.hidden).length,
          truncated: detail.log?.truncated ?? false,
          text: logText,
          handoffId,
        },
      };
    },
  });

  ctx.operations.register("coolify.deployment-queue", {
    run: async (input, { signal }) => {
      const queue = await deployments.queue(connectionIdInput(input), {
        refresh: refreshFlag(input.refresh),
        signal,
      });
      const failed = queue.recent.filter((r) =>
        isFailedDeployment(r.status),
      ).length;
      return {
        summary: `${queue.running.length} queued or running, ${queue.recent.length} recent (${failed} failed)`,
        data: queueBody(queue),
      };
    },
  });

  ctx.operations.register("coolify.deploy-by-tag", {
    describe: (input) =>
      deployments.describeTagDeploy(connectionIdInput(input), input),
    run: async (input, { signal }) => {
      signal.throwIfAborted();
      const result = await deployments.deployByTag(
        connectionIdInput(input),
        readTagDeploy(input),
        signal,
      );
      const queued = result.deployments.filter((d) => d.deploymentUuid);
      return {
        summary: `Deployed ${result.targets.length} resource${result.targets.length === 1 ? "" : "s"} tagged ${result.tag}; ${queued.length} deployment${queued.length === 1 ? "" : "s"} queued`,
        changed: true,
        data: result,
      };
    },
  });

  ctx.operations.register("coolify.deployment-cancel", {
    run: async (input, { signal }) => {
      const answer = await deployments.cancel(
        connectionIdInput(input),
        text(input.deploymentUuid),
        { resourceUuid: text(input.uuid) || undefined, signal },
      );
      return {
        summary: `Cancelled deployment ${answer.deploymentUuid}: ${answer.status}`,
        changed: true,
        data: answer,
      };
    },
  });
}
