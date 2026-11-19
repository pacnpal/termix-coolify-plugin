import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ContainerCompanions } from "../companions/container-service.js";
import { ConnectionError } from "../connections/service.js";
import { connectionIdInput } from "./connections.js";

type Params = Record<string, unknown>;

function paramsOf(input: Record<string, unknown>): Params {
  let raw = input.params;
  if (typeof raw === "string") {
    try {
      raw = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new ConnectionError("invalid-input", "params must be JSON");
    }
  }
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConnectionError("invalid-input", "params must be an object");
  }
  return raw as Params;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const optional = (value: unknown) => text(value) || undefined;

function choicesSummary(n: number): string {
  return `${n} containers match; pick one with container`;
}

/**
 * The container-level kinds of coolify.companion-read and coolify.companion:
 * one per container companion route, calling the same service, so access,
 * companion and Linked host checks are the same. Nothing returned carries a
 * token; the web UI's one-time URL goes only to an output declared
 * `sensitive`, never into a summary.
 */
export function registerContainerCompanionOperations(
  ctx: PluginContext,
  companions: ContainerCompanions,
): void {
  ctx.operations.register("coolify.companion-read", {
    run: async (input) => {
      const kind = text(input.kind);
      const params = paramsOf(input);
      switch (kind) {
        case "companions": {
          const map = await companions.map();
          const running = Object.values(map).filter(Boolean).length;
          return { summary: `${running} companions running`, data: map };
        }
        case "files-paths": {
          const data = await companions.paths(
            connectionIdInput(input),
            text(params.uuid),
            optional(params.part),
          );
          return {
            summary: `${data.dataDir} and ${data.volumes.length} storage paths on host ${data.hostId}`,
            data,
          };
        }
        default:
          throw new ConnectionError("invalid-input", "Unknown kind");
      }
    },
  });

  ctx.operations.register("coolify.companion", {
    run: async (input) => {
      const kind = text(input.kind);
      const params = paramsOf(input);
      const id = connectionIdInput(input);
      const uuid = text(params.uuid);
      switch (kind) {
        case "tunnel-open": {
          const data = await companions.tunnelOpen(id, uuid, {
            port: params.port,
            part: params.part,
            container: params.container,
          });
          if ("choices" in data) {
            return { summary: choicesSummary(data.choices.length), data };
          }
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
          if ("choices" in data) {
            return { summary: choicesSummary(data.choices.length), data };
          }
          return {
            summary: `Opened a one-time web UI link to port ${String(params.port)}`,
            changed: true,
            data: { url: data.url },
          };
        }
        default:
          throw new ConnectionError("invalid-input", "Unknown kind");
      }
    },
  });
}
