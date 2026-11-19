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
- Sync servers: each Coolify server becomes a Linked host in a "Coolify" folder (or "Coolify / <connection>"
  with several connections), tagged `coolify`, with a note linking back to Coolify. A preview shows every
  server first; re-sync updates hosts in place, and servers gone from Coolify are flagged, never deleted
- Each Coolify SSH key is copied once into a Termix credential named "Coolify: <connection> / <key>", reused
  until the key's fingerprint changes. Every copy is audited. When the token can't read keys, or an admin
  turned key copying off, you pick a Termix credential instead
- The server Coolify runs on (`host.docker.internal`, `localhost` or `127.*`) waits for the address Termix
  should use, while the other servers sync. Servers behind a Cloudflare tunnel are shown but not synced yet
- Linked hosts are read only while Coolify manages them, with a Coolify badge, a status dot, a Coolify card
  on the host page, and Resources, Sync and Unlink in their menu. Unlink makes a host ordinary again;
  deleting a Linked host keeps its address and credential choice for the next sync
- "Import from Coolify" in the hosts import menu, and a Sync servers button on each connection
- Actions `coolify.sync-preview`, `coolify.sync-apply` and `coolify.unlink`; only the preview is offered to
  the assistant and MCP
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
- Open shell and Open database console on a resource or part: a Coolify shell tab with SSH Terminal's
  terminal on the Linked host, in the container found by Coolify's labels (uuid first, then the labels from
  before Coolify 4.4, and for parts their own uuid, then their compose service name). `bash` or `sh`, and
  `sudo` when the SSH user needs it. A picker when several containers match
- Database consoles with psql, mysql or mariadb, mongosh, redis-cli, keydb-cli, clickhouse-client and
  sqlite3. Credentials are read inside the container from its own environment; no password is in the
  command, the browser or a log
- Clear answers when the server isn't linked, the container isn't running, or Termix hasn't trusted the
  host's key yet (with Coolify's fingerprint and a button to open a server terminal). Without SSH Terminal,
  the command to copy
- The action `coolify.shell-command`, offered to the assistant and MCP, answers the exact `docker exec`
  command. Shells need Operate Coolify resources and your own connect access to the Linked host
