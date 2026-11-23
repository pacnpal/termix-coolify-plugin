import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

type Batch = PluginContext["db"]["batch"];

/**
 * Makes every batch that touches the `cache` table fail, as a database that
 * refuses the write (a lost unique-index race, a dropped connection) would.
 * Other batches run as before. Answers how many cache writes were refused.
 */
export function failCacheWrites(ctx: PluginContext): () => number {
  const batch = ctx.db.batch.bind(ctx.db);
  let refused = 0;
  ctx.db.batch = (async (queries: Parameters<Batch>[0]) => {
    if (queries.some((q) => q.toSQL().sql.includes("p_coolify_cache"))) {
      refused += 1;
      throw new Error("fake cache write refused");
    }
    return batch(queries);
  }) as Batch;
  return () => refused;
}
