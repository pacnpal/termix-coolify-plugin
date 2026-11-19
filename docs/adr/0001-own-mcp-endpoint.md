# The plugin serves its own MCP endpoint

The owner requires everything the plugin does to work through Termix's MCP. Termix's main MCP server (the
Operations Center plugin) builds its tools from operations with the `mcp` surface. Core's catalog always
leaves community plugins out of that surface (`operations/catalog.ts` in core f1c2964), and this build has no
admin switch for it. So the plugin serves its own MCP endpoint at `/plugin-api/coolify/mcp`. Core already
accepts Termix API keys with `operations:read` or `operations:run` there. Every tool call runs through
`ctx.operations.run`, so the gate, approvals and history still apply.

## Consequences

- MCP clients point at the plugin's endpoint, not at Operations Center's.
- Operations still set `surfaces.mcp`, so the safe ones also appear on Termix's main MCP server if the plugin
  is ever signed official or core adds the switch.
- That alone is not enough to retire this endpoint. It serves every operation, including the destructive ones
  that keep `surfaces.mcp` off, while the main server offers only `surfaces.mcp` operations. Retire it only
  when Termix's main MCP server can offer every operation this endpoint does, destructive ones included, with
  the same gates.
