import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  cache,
  connections,
  dnsRecords,
  events,
  grants,
  onboardings,
  recent,
  servers,
  statusPages,
  webhooks,
} from "./tables.js";

// The table object ctx.db.define hands back. Drizzle's own types are per
// dialect and core builds the object at runtime, so services treat it loosely.
export type Table = any;

export interface Tables {
  connections: Table;
  grants: Table;
  webhooks: Table;
  servers: Table;
  cache: Table;
  events: Table;
  onboardings: Table;
  statusPages: Table;
  dnsRecords: Table;
  recent: Table;
}

/** Defines every plugin table once, in activate. */
export async function defineTables(ctx: PluginContext): Promise<Tables> {
  return {
    connections: await ctx.db.define(connections),
    grants: await ctx.db.define(grants),
    webhooks: await ctx.db.define(webhooks),
    servers: await ctx.db.define(servers),
    cache: await ctx.db.define(cache),
    events: await ctx.db.define(events),
    onboardings: await ctx.db.define(onboardings),
    statusPages: await ctx.db.define(statusPages),
    dnsRecords: await ctx.db.define(dnsRecords),
    recent: await ctx.db.define(recent),
  };
}

/** The Drizzle handle. Every dialect takes the same query builder calls. */
export function dbClient(ctx: PluginContext) {
  return ctx.db.client<BetterSQLite3Database>();
}
