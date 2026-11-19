import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

const NOTE =
  "Managed by Coolify for Termix. Sync it from Coolify, or unlink it to edit it here.";

/**
 * The Linked hosts this plugin keeps read only. Core reads locks
 * synchronously, so the ids live in memory: loaded from the servers table on
 * activate, and changed as hosts are linked and unlinked.
 */
export function createLocks(ctx: PluginContext, initial: Iterable<number>) {
  const locked = new Set<number>(initial);
  ctx.hosts.locks.provide({
    isLocked: (hostId) => locked.has(hostId),
    note: (hostId) => (locked.has(hostId) ? NOTE : null),
    // People may still add their own hosts by hand.
    allowManualCreate: () => true,
    lockedHosts: () => [...locked],
  });
  return {
    add(hostId: number) {
      locked.add(hostId);
    },
    remove(hostId: number) {
      locked.delete(hostId);
    },
    has(hostId: number): boolean {
      return locked.has(hostId);
    },
  };
}

export type Locks = ReturnType<typeof createLocks>;
