import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { defineTables } from "./db.js";
import { createConnections } from "./connections/service.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { registerOperations } from "./operations.js";

export async function activate(ctx: PluginContext): Promise<void> {
  const tables = await defineTables(ctx);
  const connections = createConnections(ctx, tables);
  const router = ctx.http.router<Router>();
  registerConnectionRoutes(router, ctx, connections);
  registerMcpRoutes(router, ctx);
  registerOperations(ctx, { connections });
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
