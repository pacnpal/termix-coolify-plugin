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
  local network address and CA certificate. The token is stored encrypted and never shown again. The
  address must use https, except plain http to localhost, or to a private IP address with "On my local
  network" on (the token then travels in the clear on that network)
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
- The Coolify tab's Overview, Resources and Connections sections. Overview counts running, degraded, stopped
  and deploying resources; a tile opens the Resources list filtered to it
- A resource Coolify reports as exited counts as stopped, not degraded, since that is how Coolify reports
  one you stopped yourself
- The Resources list: every application, service and database of a connection, with each service's parts
  under it, its status, Coolify server, project and environment, domains and last deploy. Search and filter
  by type and status. A resource opens its Overview in place
- Resources come from Coolify's per-type lists without environment values, keys, tokens or compose files,
  and statuses are cached for 20 seconds; Refresh fetches them again
- Actions to list a connection's resources and read one (`coolify.list-resources-all`,
  `coolify.resource-get`), offered to the assistant and MCP; the MCP tool `list_resources` runs the first
- The Coolify tab in the Termix phone app, with a phone layout for the Resources list
- Sync servers, in the Coolify tab's Servers section: each Coolify server becomes a Linked host in a "Coolify" folder (or "Coolify / <connection>"
  with several connections), tagged `coolify`, with a note linking back to Coolify. A preview shows every
  server first; re-sync updates hosts in place, and servers gone from Coolify are flagged, never deleted
- Each Coolify SSH key is copied once into a Termix credential named "Coolify: <connection> / <key>", reused
  until the key's fingerprint changes or you delete that credential. Every copy is audited. When the token
  can't read keys, an admin turned key copying off, or a key copy fails, you pick a Termix credential
  instead
- The server Coolify runs on (`host.docker.internal`, `localhost` or `127.*`) waits for the address Termix
  should use, while the other servers sync. Any other server can be given its own address too
- Servers behind a Cloudflare tunnel become Linked hosts reached through SSH Terminal's own tunnel: the host
  address is the tunnel hostname, and SSH Terminal's tunnel settings are set (port 443, plus the connection's
  Cloudflare Access service token when one is set). This needs SSH Terminal 1.2.0 or newer to be on; until
  then those servers say "Turn on the SSH Terminal plugin" or "Update SSH Terminal to 1.2.0 or newer", with
  a button to Termix's Plugins tab. Connection setup shows the same check once when Coolify has tunnelled
  servers, and a tunnelled Linked host shows "Tunnel: through SSH Terminal (Cloudflare)" with "Open tunnel
  settings". The service token is never shown in previews, results, run history, logs or the audit log
- A picked credential that was deleted, or couldn't be checked, shows the credential picker again
- Syncs, unlinks and connection removals of one connection run one at a time, so overlapping syncs never
  make two hosts for one server, a sync waiting behind a removal creates nothing, and a host whose link
  can't be saved is removed instead of left locked
- A sync uses one snapshot of its connection. If the connection's address, token or Access token changes
  while it runs, it stops before changing any host and says so, so no host gets settings from two targets
- Re-syncing clears tunnel settings that no longer apply: a removed Access token is cleared from tunnelled
  hosts, and a server that is no longer behind a tunnel has SSH Terminal's tunnel turned off
- Linked hosts are read only while Coolify manages them, with a Coolify badge, a status dot, a Coolify card
  on the host page, and Resources, Sync and Unlink in their menu. Unlink makes a host ordinary again;
  deleting a Linked host keeps its address and credential choice for the next sync
- "Import from Coolify" in the hosts import menu, and a Sync servers button on each connection, both
  opening the Servers section, also when the tab is already open on another section
- Actions `coolify.sync-preview`, `coolify.sync-apply` and `coolify.unlink`; only the preview is offered to
  the assistant and MCP
- Deploy, Force rebuild, Restart, and Start or Stop in a resource's header, with a Restart for each part of
  a service. Stop and Force rebuild ask first, naming the resource. "Coolify: Deploy…" in the command palette
- Lifecycle works with or without a Linked host: on a Linked host's resource through `coolify.deploy`,
  `coolify.start`, `coolify.restart` and `coolify.stop` (in the host's history), otherwise through
  `coolify.resource-deploy`, `coolify.resource-restart` and `coolify.resource-action`. Each needs the Operate
  permission and the owner or an operate grant, and accepts only that connection's own resources
- Deploy can wait for the deployment and sends a deployment finished or failed event. Over MCP, deploy and
  restart work without "Allow changes over MCP"; start and stop still need it
- Coolify resources on Linked hosts (`coolify.resource`, `coolify.list-resources`), `coolify.sync-host`,
  status tiles for degraded resources, server reachability, security updates and deployments running, and
  the declared events deployment finished, deployment failed, container restarted and server unreachable
