import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConnectionError } from "../connections/service.js";
import { readChoices, type Sync } from "../sync/service.js";
import { connectionIdInput } from "./connections.js";

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

function serverUuidInput(input: Record<string, unknown>): string {
  const raw = input.serverUuid;
  if (typeof raw !== "string" || !UUID.test(raw)) {
    throw new ConnectionError(
      "not-linked",
      "This Coolify server has no Linked host",
    );
  }
  return raw;
}

/**
 * Host sync actions. They call the same sync service the routes use. Nothing
 * they return carries key material: rows and results hold ids, names,
 * addresses and causes only.
 */
export function registerSyncOperations(ctx: PluginContext, sync: Sync): void {
  ctx.operations.register("coolify.sync-preview", {
    run: async (input) => {
      const rows = await sync.preview(connectionIdInput(input));
      const blocked = rows.filter((r) => r.status === "blocked").length;
      return {
        summary: `${rows.length} Coolify server${rows.length === 1 ? "" : "s"}, ${blocked} blocked`,
        data: { rows },
      };
    },
  });

  ctx.operations.register("coolify.sync-apply", {
    run: async (input) => {
      const id = connectionIdInput(input);
      await sync.assertOwner(id);
      const choices =
        input.choices === undefined || input.choices === null
          ? null
          : readChoices(input.choices);
      const results = await sync.apply(id, choices);
      const count = (status: string) =>
        results.filter((r) => r.status === status).length;
      const created = count("created");
      const updated = count("updated");
      return {
        summary:
          `${created} created, ${updated} updated, ${count("blocked")} blocked, ` +
          `${count("failed")} failed, ${count("gone")} gone from Coolify`,
        changed: created + updated > 0,
        data: { results },
      };
    },
  });

  ctx.operations.register("coolify.sync-host", {
    run: async (_input, { hostId }) => {
      const link = hostId ? await sync.linkOfHost(hostId) : null;
      if (!link) {
        throw new ConnectionError(
          "not-linked",
          "This host is not linked to a Coolify server",
        );
      }
      await sync.assertOwner(link.connectionId);
      // Only this host's server is included; the others are left as they are.
      const results = await sync.apply(link.connectionId, [
        { uuid: link.serverUuid, include: true },
      ]);
      const mine = results.find((r) => r.uuid === link.serverUuid) ?? null;
      const status = mine?.status ?? "gone";
      return {
        summary: mine
          ? `${mine.name}: ${status}${mine.cause ? ` (${mine.cause})` : ""}`
          : "This server is gone from Coolify",
        changed: status === "created" || status === "updated",
        data: { result: mine },
      };
    },
  });

  ctx.operations.register("coolify.unlink", {
    run: async (input) => {
      const id = connectionIdInput(input);
      await sync.assertOwner(id);
      const result = await sync.unlink(id, serverUuidInput(input), {
        removeHost: false,
      });
      return {
        summary: `Unlinked host ${result.hostId}; it is now an ordinary host`,
        changed: true,
        data: result,
      };
    },
  });
}
