import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Companions } from "../companions/service.js";
import type { ContainerCompanions } from "../companions/container-service.js";
import { ConnectionError } from "../connections/service.js";
import { connectionIdInput } from "./connections.js";
import {
  containerCompanionChange,
  containerCompanionRead,
} from "./container-companions.js";

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

function recordIdOf(params: Record<string, unknown>): number {
  const raw = params.recordId;
  if (typeof raw === "number") return raw;
  return typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * coolify.companion-read, coolify.companion and coolify.companion-dns-remove:
 * one kind (or, for the destructive DNS removal, one action) per companion route,
 * calling the same service the routes use, so access, companion and Linked
 * host checks are the same. Nothing returned carries a token or password.
 */
export function registerCompanionOperations(
  ctx: PluginContext,
  companions: Companions,
  containerCompanions: ContainerCompanions,
): void {
  ctx.operations.register("coolify.companion-read", {
    run: async (input) => {
      const kind = text(input.kind);
      const params = paramsOf(input);
      if (kind === "companions") {
        const map = await companions.map();
        const running = Object.values(map).filter(Boolean).length;
        return { summary: `${count(running, "companion")} running`, data: map };
      }
      const id = connectionIdInput(input);
      const uuid = text(params.uuid);
      const server = text(params.serverUuid);
      switch (kind) {
        case "uptime": {
          const data = await companions.uptime(id, uuid);
          return { summary: count(data.monitors.length, "monitor"), data };
        }
        case "log-search": {
          const data = await companions.logSearch(id, uuid);
          return {
            summary: `${count(data.results.length, "line")} from Docker logs`,
            data,
          };
        }
        case "security": {
          const data = await companions.security(id, server);
          return {
            summary: `Score ${data.score ?? "unknown"}, ${
              data.critical === null
                ? "critical count unknown"
                : count(data.critical, "critical finding")
            }`,
            data,
          };
        }
        case "db-login": {
          const data = await companions.dbLogin(id, uuid);
          return {
            summary: data.saved ? "A login is saved" : "No saved login",
            data,
          };
        }
        case "db-logins": {
          const data = await companions.dbLogins(id, server);
          const saved = data.databases.filter((d) => d.saved).length;
          return {
            summary: `${saved} of ${count(data.databases.length, "database")} with a saved login`,
            data,
          };
        }
        case "backups-failed": {
          const data = await companions.backupsFailed(id, server);
          return { summary: count(data.jobs.length, "failed backup"), data };
        }
        case "host-metrics": {
          const data = await companions.hostMetrics(id, server);
          return {
            summary: `${count(data.applications, "application")}, ${count(data.services, "service")}, ${count(data.databases, "database")}`,
            data,
          };
        }
        case "dns-list": {
          const rows = await companions.dnsList(id, uuid);
          return { summary: count(rows.length, "DNS record"), data: { rows } };
        }
        case "files-paths":
          return containerCompanionRead(containerCompanions, id, params);
        default:
          throw new ConnectionError("invalid-input", "Unknown kind");
      }
    },
  });

  ctx.operations.register("coolify.companion", {
    run: async (input, { runId }) => {
      const kind = text(input.kind);
      const params = paramsOf(input);
      const id = connectionIdInput(input);
      const uuid = text(params.uuid);
      switch (kind) {
        case "dns": {
          const data = await companions.dnsCreate(id, uuid, {
            fqdn: params.fqdn,
            type: params.type,
            content: params.content,
          });
          return {
            summary: `Created ${data.type} record ${data.fqdn}`,
            changed: true,
            data,
          };
        }
        case "uptime-pause":
        case "uptime-resume": {
          const paused = kind === "uptime-pause";
          const data = await companions.setMonitorsPaused(id, uuid, paused);
          return {
            summary: `${paused ? "Paused" : "Resumed"} ${count(data.monitors.length, "monitor")}`,
            changed: data.monitors.length > 0,
            data,
          };
        }
        case "tunnel-open":
        case "tunnel-close":
        case "web-ui":
          return containerCompanionChange(
            ctx,
            containerCompanions,
            kind,
            id,
            params,
            runId,
          );
        default:
          throw new ConnectionError("invalid-input", "Unknown kind");
      }
    },
  });

  // Destructive, so core asks a person to confirm before this runs. Only after
  // that does the delete reach dns.delete-record, itself destructive, with
  // `confirmed`. The same service as DELETE …/dns/:recordId.
  ctx.operations.register("coolify.companion-dns-remove", {
    run: async (input) => {
      const data = await companions.dnsRemove(
        connectionIdInput(input),
        text(input.uuid),
        recordIdOf(input),
      );
      return {
        summary: `Removed DNS record ${data.id}`,
        changed: true,
        data,
      };
    },
  });
}
