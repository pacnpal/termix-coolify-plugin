import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ContainerCompanions } from "../companions/container-service.js";
import { handoffIdFor } from "../status/service.js";
import { holdHandoff, takeLogText } from "./containers.js";

type Params = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const optional = (value: unknown) => text(value) || undefined;

function webUiHandoff(handoffId: string): string {
  return `web-ui:${handoffId}`;
}

/** The one-time URL of one web-ui run, once, to the user who ran it. */
export function takeWebUiUrl(
  userId: string,
  handoffId: unknown,
): string | null {
  if (typeof handoffId !== "string") return null;
  return takeLogText(userId, webUiHandoff(handoffId));
}

function choices(data: { choices: unknown[] }) {
  return {
    summary: `${data.choices.length} containers match; pick one with container`,
    data,
  };
}

/** coolify.companion-read's files-paths kind. */
export async function containerCompanionRead(
  companions: ContainerCompanions,
  id: number,
  params: Params,
) {
  const data = await companions.paths(
    id,
    text(params.uuid),
    optional(params.part),
  );
  return {
    summary: `${data.dataDir} and ${data.volumes.length} storage paths on host ${data.hostId}`,
    data,
  };
}

/**
 * coolify.companion's tunnel-open, tunnel-close and web-ui kinds, calling the
 * routes' service, so the checks are the same. The web UI's one-time URL is
 * a sensitive output: core drops it from run history, and the MCP answer
 * takes it once through the logs handoff store (`takeWebUiUrl`).
 */
export async function containerCompanionChange(
  ctx: PluginContext,
  companions: ContainerCompanions,
  kind: "tunnel-open" | "tunnel-close" | "web-ui",
  id: number,
  params: Params,
  runId: string | null,
  signal?: AbortSignal,
) {
  const uuid = text(params.uuid);
  switch (kind) {
    case "tunnel-open": {
      const data = await companions.tunnelOpen(
        id,
        uuid,
        {
          port: params.port,
          part: params.part,
          container: params.container,
        },
        signal,
      );
      if ("choices" in data) return choices(data);
      return {
        summary: `Forwarding ${data.bindHost}:${data.bindPort} on the Termix server to port ${data.targetPort} as ${data.name}`,
        changed: true,
        data,
      };
    }
    case "tunnel-close": {
      const data = await companions.tunnelClose(
        id,
        uuid,
        typeof params.port === "number" ? String(params.port) : params.port,
        optional(params.part),
      );
      return { summary: `Closed ${data.name}`, changed: true, data };
    }
    case "web-ui": {
      const data = await companions.webUi(id, uuid, {
        port: params.port,
        scheme: params.scheme,
        part: params.part,
        container: params.container,
      });
      if ("choices" in data) return choices(data);
      const handoffId = handoffIdFor(runId);
      const userId = ctx.currentActor() ?? "";
      if (userId) holdHandoff(userId, webUiHandoff(handoffId), data.url);
      return {
        summary: "Opened a one-time web UI link",
        changed: true,
        // url is a sensitive output, so core drops it before a run is
        // stored; handoffId lets the MCP answer carry it, once.
        data: { url: data.url, handoffId },
      };
    }
  }
}
