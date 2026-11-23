import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  ConnectionError,
  type ConnectionInput,
  type ConnectionPatch,
  type Connections,
} from "../connections/service.js";

const PATCH_KEYS = [
  "name",
  "baseUrl",
  "token",
  "cfAccessId",
  "cfAccessSecret",
  "allowPrivate",
  "caCert",
  "autoSync",
] as const;

/** The connectionId input: a choice from coolify.list-connections, as a string. */
export function connectionIdInput(input: Record<string, unknown>): number {
  const raw = input.connectionId;
  const id =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d{1,15}$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ConnectionError("not-found", "Coolify connection not found");
  }
  return id;
}

function pick(input: Record<string, unknown>): ConnectionPatch {
  const out: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out as ConnectionPatch;
}

/**
 * The connection actions. Each returns the connection without any secret:
 * token and Cloudflare Access inputs are declared `secret`, so core never
 * stores or shows them, and the handlers never put them in a summary or data.
 */
export function registerConnectionOperations(
  ctx: PluginContext,
  connections: Connections,
): void {
  ctx.operations.register("coolify.list-connections", {
    run: async () => {
      const rows = await connections.list();
      return {
        summary: `${rows.length} Coolify connection${rows.length === 1 ? "" : "s"}`,
        data: {
          options: rows.map((c) => ({ value: String(c.id), label: c.name })),
          rows,
        },
      };
    },
  });

  ctx.operations.register("coolify.connection-probe", {
    run: async (input) => {
      const result = await connections.probe(connectionIdInput(input));
      const { connection, probe } = result;
      return {
        summary: probe.ok
          ? `${connection.name}: Coolify ${probe.version ?? ""} answered`.trim()
          : `${connection.name}: probe failed (${connection.lastError ?? "upstream"})`,
        data: result,
      };
    },
  });

  ctx.operations.register("coolify.connection-create", {
    run: async (input) => {
      const created = await connections.create(pick(input) as ConnectionInput);
      return {
        summary: created.lastError
          ? `Saved ${created.name}; Coolify did not answer (${created.lastError})`
          : `Connected ${created.name} (Coolify ${created.version ?? "unknown"})`,
        changed: true,
        data: created,
      };
    },
  });

  ctx.operations.register("coolify.connection-update", {
    run: async (input) => {
      const updated = await connections.update(
        connectionIdInput(input),
        pick(input),
      );
      return {
        summary: `Updated ${updated.name}`,
        changed: true,
        data: updated,
      };
    },
  });

  ctx.operations.register("coolify.connection-set-exec", {
    run: async (input) => {
      const updated = await connections.setExec(
        connectionIdInput(input),
        input.execEnabled as boolean,
      );
      return {
        summary: `${updated.execEnabled ? "Allowed" : "Stopped"} running commands in ${updated.name}'s containers`,
        changed: true,
        data: updated,
      };
    },
  });

  ctx.operations.register("coolify.connection-set-poll", {
    run: async (input) => {
      const updated = await connections.setPoll(
        connectionIdInput(input),
        input.pollEnabled as boolean,
      );
      return {
        summary: updated.pollEnabled
          ? `${updated.name} keeps polling Coolify after a webhook arrives`
          : `${updated.name} stops polling Coolify once a webhook arrives`,
        changed: true,
        data: updated,
      };
    },
  });

  ctx.operations.register("coolify.connection-delete", {
    run: async (input) => {
      const removed = await connections.remove(connectionIdInput(input), {
        removeHosts: input.removeHosts === true,
      });
      return {
        summary: `Removed ${removed.name}`,
        changed: true,
        data: { id: removed.id, name: removed.name },
      };
    },
  });
}
