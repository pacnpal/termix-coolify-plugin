import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { MCP_SERVER_NAME, handleMcpBody } from "./server.js";

/** Shown in client config examples instead of a key; never a real one. */
export const MCP_KEY_PLACEHOLDER = "<your Termix API key>";

/**
 * The plugin's own MCP endpoint. Core lets Termix API keys with
 * operations:read or operations:run reach /plugin-api/<id>/mcp; every tool
 * call still runs through ctx.operations.run with its own permission.
 */
export function registerMcpRoutes(router: Router, ctx: PluginContext): void {
  const mcp = ctx.rbac.require("mcp") as never;

  /**
   * @openapi
   * /plugin-api/coolify/mcp:
   *   post:
   *     summary: The Coolify MCP endpoint (JSON-RPC 2.0)
   *     description: >-
   *       Stateless MCP over HTTP with initialize, ping, tools/list and
   *       tools/call. Takes one message or a batch array. Each tool runs a
   *       Coolify action through Termix's operations, so the action's own
   *       permission, approvals and history apply. Changes need the admin
   *       setting "Allow changes over MCP". Works with a Termix API key
   *       scoped to operations:read or operations:run.
   *     tags:
   *       - Coolify
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             oneOf:
   *               - type: object
   *               - type: array
   *                 items:
   *                   type: object
   *     responses:
   *       200:
   *         description: The JSON-RPC answer, or an array of answers for a batch
   *       202:
   *         description: Only notifications were sent, so there is no answer
   *       403:
   *         description: Missing coolify.mcp
   */
  router.post("/mcp", mcp, async (req, res) => {
    try {
      const reply = await handleMcpBody(ctx, req.body);
      if (reply === null) return res.status(202).end();
      return res.json(reply);
    } catch {
      ctx.log.warn("coolify mcp request failed");
      return res.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" },
      });
    }
  });

  /**
   * @openapi
   * /plugin-api/coolify/mcp:
   *   get:
   *     summary: How to connect an MCP client to the Coolify MCP endpoint
   *     description: >-
   *       The endpoint address and a client config example. The example has a
   *       placeholder where the Termix API key goes, never a real key.
   *     tags:
   *       - Coolify
   *     responses:
   *       200:
   *         description: "{ endpoint, example: { mcpServers } }"
   *       403:
   *         description: Missing coolify.mcp
   */
  router.get("/mcp", mcp, (req, res) => {
    const endpoint = `${ctx.http.baseUrl(req).replace(/\/+$/, "")}/plugin-api/${ctx.pluginId}/mcp`;
    res.json({
      endpoint,
      example: {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            url: endpoint,
            headers: { Authorization: `Bearer ${MCP_KEY_PLACEHOLDER}` },
          },
        },
      },
    });
  });
}
