# Changelog

## 1.0.0

### Added

- The Coolify tab, opened from the sidebar
- Five permissions: view, operate, configure, administer and MCP
- Admin settings for polling, SSH key copying, sharing, cloud provisioning, status pages, changes over MCP
  and running commands in containers
- Coolify's API descriptions for v4.7.5, `main` and `next`, a list of every Coolify API operation with the
  oldest Coolify version that has it, and a coverage page naming how the plugin uses each one
- The plugin's tables (connections, grants, webhooks, servers, cache, events, onboardings, status pages, DNS
  records and recent items) with migrations for SQLite, PostgreSQL and MySQL
- Connect Coolify instances: name, URL and API token, with an optional Cloudflare Access service token,
  local network address and CA certificate. The token is stored encrypted and never shown again
- A check of each connection: Coolify 4.4 or newer, the team, scoped tokens, and whether the token can read
  keys, logs and instance settings, with a plain cause and fix when something fails
- The Connections view and a "Connect Coolify" setup step
- Actions to list, check, add, change and remove connections; token fields never appear in run history
- An MCP endpoint at `/plugin-api/coolify/mcp` for Termix API keys scoped to `operations:read` or
  `operations:run`: one tool per action plus `list_connections`, `list_hosts` and `list_resources`, run
  through Termix's operations with approvals and history. Changes over MCP stay off until an admin turns on
  "Allow changes over MCP"
- MCP output masks tokens, passwords, keys, env values and compose files at any depth, and cuts long output
  at 8,000 characters
- "Use with an MCP client" in the Connections view, with the endpoint and a client config to copy
- An API and MCP reference (`docs/api.md`) with every action's route, run path, key scope, MCP tool and a
  `curl` example
- The full Coolify API through Termix: `coolify.api-read` runs any Coolify read and `coolify.api-call` any
  operation after a confirm, each checked against the permission, connection access and token that
  operation needs (deletes and instance settings need **Administer Coolify**, logs need **Operate Coolify resources**).
  Request parameters and bodies never enter run history, and answers are masked. Coolify's "turn the API
  off" is never run, and operations newer than the connection's Coolify are hidden
- The API console in the Coolify tab: a form for every Coolify operation. Reads run at once, changes ask
  first and a delete asks you to type the operation id. Masked values can be revealed one at a time with
  **Configure Coolify** and a token with `read:sensitive`; each reveal is audited
