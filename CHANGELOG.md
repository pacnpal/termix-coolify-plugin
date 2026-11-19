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
- The Coolify tab's Overview, Resources and Connections sections. Overview counts running, degraded, stopped
  and deploying resources; a tile opens the Resources list filtered to it
- The Resources list: every application, service and database of a connection, with each service's parts
  under it, its status, Coolify server, project and environment, domains and last deploy. Search and filter
  by type and status. A resource opens its Overview in place
- Resources come from Coolify's per-type lists without environment values, keys, tokens or compose files,
  and statuses are cached for 20 seconds; Refresh fetches them again
- Actions to list a connection's resources and read one (`coolify.list-resources-all`,
  `coolify.resource-get`), offered to the assistant and MCP
- The Coolify tab in the Termix phone app, with a phone layout for the Resources list
- An MCP endpoint at `/plugin-api/coolify/mcp` for Termix API keys scoped to `operations:read` or
  `operations:run`: one tool per action plus `list_connections`, `list_hosts` and `list_resources`, run
  through Termix's operations with approvals and history. Changes over MCP stay off until an admin turns on
  "Allow changes over MCP"
- MCP output masks tokens, passwords, keys, env values and compose files at any depth, and cuts long output
  at 8,000 characters
- "Use with an MCP client" in the Connections view, with the endpoint and a client config to copy
- An API and MCP reference (`docs/api.md`) with every action's route, run path, key scope, MCP tool and a
  `curl` example
- Public, read-only status pages: in Connections, publish a page for the resources you pick. It shows each
  one's name, status and last deploy (and uptime when the Uptime plugin is installed), never uuids, servers,
  domains, logs or secrets. The link is shown once and only its hash is stored; give a page a new link or
  revoke it at any time. Pages are served from the plugin's cache with a strict Content-Security-Policy and
  no scripts, refresh every 30 seconds, and say "Status may be out of date" when the status is over 5
  minutes old. While a page is published the plugin checks Coolify every minute, backing off after errors
- Turning off "Allow public status pages" refuses new pages, and existing pages answer "not found"
- Actions to list, publish, rotate and revoke status pages (`coolify.status-page-list`,
  `coolify.status-page-create`, `coolify.status-page-rotate`, `coolify.status-page-revoke`). Run history
  never holds a page's link: create and rotate answer a handoff id, and the link is taken once over MCP,
  with the MCP tool `take_status_page_url`, or with `POST /plugin-api/coolify/status-pages/handoff/:id`
