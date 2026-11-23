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

function errorName(err: unknown): string {
  return (err as Error)?.name ?? "error";
}

/**
 * The write queues of one `cache` table, shared by every createCache made for
 * it (resources, server statuses and updates each make their own). `keys`
 * holds the tail of each `connectionId:kind`, `wide` the tail of each
 * connection's drop of every kind.
 */
interface Queues {
  keys: Map<string, Promise<void>>;
  wide: Map<number, Promise<void>>;
}

const queuesByTable = new WeakMap<object, Queues>();

function queuesFor(table: object): Queues {
  let queues = queuesByTable.get(table);
  if (!queues) {
    queues = { keys: new Map(), wide: new Map() };
    queuesByTable.set(table, queues);
  }
  return queues;
}

/** Makes `run` the key's tail, removed once it settles if still the last. */
function enqueue<K>(
  map: Map<K, Promise<void>>,
  key: K,
  run: Promise<unknown>,
): void {
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  map.set(key, tail);
  void tail.then(() => {
    if (map.get(key) === tail) map.delete(key);
  });
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
 *
 * A write replaces the row with a delete and an insert, and the table has a
 * unique index on (connectionId, kind). On Postgres or MySQL two such batches
 * of one key can both delete nothing and both insert, so the writes and drops
 * of one `connectionId:kind` run one at a time, in the order they were
 * called, through an in-process queue entered before any await (the plugin
 * backend is one Node process per Termix server). A drop of every kind waits
 * for every queued write and drop of its connection, and any called after it
 * waits for it. A write that fails anyway is logged by its error's name and
 * resolves, so the read that produced the value still answers.
 */
export function createCache(ctx: PluginContext, tables: Tables) {
  const t = tables.cache;
  const queues = queuesFor(t);

  /** Runs `work` after every earlier write or drop of the same key. */
  function serialized(
    connectionId: number,
    kind: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const key = `${connectionId}:${kind}`;
    const before = Promise.all([
      queues.keys.get(key),
      queues.wide.get(connectionId),
    ]);
    const run = before.then(work);
    enqueue(queues.keys, key, run);
    return run;
  }

  /** Runs `work` after every earlier write or drop of the connection. */
  function serializedWide(
    connectionId: number,
    work: () => Promise<void>,
  ): Promise<void> {
    const prefix = `${connectionId}:`;
    const pending = [...queues.keys]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, tail]) => tail);
    const before = Promise.all([...pending, queues.wide.get(connectionId)]);
    const run = before.then(work);
    enqueue(queues.wide, connectionId, run);
    return run;
  }

  async function replace(
    connectionId: number,
    kind: string,
    value: unknown,
    fetchedAt: number,
  ): Promise<void> {
    try {
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
    } catch (err) {
      // The name only: a database error's message can quote the row.
      ctx.log.warn(`coolify cache write failed: ${errorName(err)}`);
    }
  }

  async function remove(connectionId: number, kind?: string): Promise<void> {
    const db = await dbClient(ctx);
    await db
      .delete(t)
      .where(
        kind
          ? and(eq(t.connectionId, connectionId), eq(t.kind, kind))
          : eq(t.connectionId, connectionId),
      );
    await ctx.db.persist({ lazy: true });
  }

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

    /**
     * Replaces the key's row after every earlier write or drop of it. Never
     * rejects: a failure is logged by its error's name only.
     */
    write<T>(
      connectionId: number,
      kind: string,
      value: T,
      fetchedAt: number,
    ): Promise<void> {
      return serialized(connectionId, kind, () =>
        replace(connectionId, kind, value, fetchedAt),
      );
    },

    /**
     * Drops one kind, or every kind when none is given, after every earlier
     * write or drop it covers.
     */
    drop(connectionId: number, kind?: string): Promise<void> {
      const work = () => remove(connectionId, kind);
      return kind === undefined
        ? serializedWide(connectionId, work)
        : serialized(connectionId, kind, work);
    },
  };
}

export type Cache = ReturnType<typeof createCache>;
