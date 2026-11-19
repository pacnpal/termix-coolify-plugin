import { and, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { dbClient, type Tables } from "./db.js";

/** One cached value and when it was fetched, in epoch milliseconds. */
export interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

interface CacheRow {
  json: unknown;
  fetchedAt: string | null;
}

function parse(json: unknown): unknown {
  if (typeof json !== "string") return json;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * The `cache` table: one row per connection and kind, holding stripped DTOs
 * only, never a raw Coolify payload. Writes are persisted lazily, since a lost
 * cache row only costs one more fetch.
 */
export function createCache(ctx: PluginContext, tables: Tables) {
  const t = tables.cache;

  async function read<T>(
    connectionId: number,
    kind: string,
  ): Promise<CacheEntry<T> | null> {
    const db = await dbClient(ctx);
    const [row] = (await db
      .select()
      .from(t)
      .where(and(eq(t.connectionId, connectionId), eq(t.kind, kind)))
      .limit(1)) as CacheRow[];
    if (!row) return null;
    const fetchedAt = Date.parse(String(row.fetchedAt ?? ""));
    const value = parse(row.json);
    if (!Number.isFinite(fetchedAt) || value === null) return null;
    return { value: value as T, fetchedAt };
  }

  return {
    read,

    /** Read, but only when younger than maxAgeMs at `now`. */
    async fresh<T>(
      connectionId: number,
      kind: string,
      maxAgeMs: number,
      now: number,
    ): Promise<CacheEntry<T> | null> {
      const entry = await read<T>(connectionId, kind);
      if (!entry) return null;
      const age = now - entry.fetchedAt;
      return age >= 0 && age < maxAgeMs ? entry : null;
    },

    async write<T>(
      connectionId: number,
      kind: string,
      value: T,
      fetchedAt: number,
    ): Promise<void> {
      const db = await dbClient(ctx);
      await ctx.db.batch([
        db
          .delete(t)
          .where(and(eq(t.connectionId, connectionId), eq(t.kind, kind))),
        db.insert(t).values({
          connectionId,
          kind,
          json: JSON.stringify(value),
          fetchedAt: new Date(fetchedAt).toISOString(),
        }),
      ]);
      await ctx.db.persist({ lazy: true });
    },

    /** Drops one kind, or every kind when none is given. */
    async drop(connectionId: number, kind?: string): Promise<void> {
      const db = await dbClient(ctx);
      await db
        .delete(t)
        .where(
          kind
            ? and(eq(t.connectionId, connectionId), eq(t.kind, kind))
            : eq(t.connectionId, connectionId),
        );
      await ctx.db.persist({ lazy: true });
    },
  };
}

export type Cache = ReturnType<typeof createCache>;
