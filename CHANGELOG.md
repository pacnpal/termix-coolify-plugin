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
  should use, while the other servers sync
- Servers behind a Cloudflare tunnel become Linked hosts reached through SSH Terminal's own tunnel: the host
  address is the tunnel hostname, and SSH Terminal's tunnel settings are set (port 443, plus the connection's
  Cloudflare Access service token when one is set). This needs SSH Terminal 1.2.0 or newer to be on; until
  then those servers say "Turn on the SSH Terminal plugin" or "Update SSH Terminal to 1.2.0 or newer", with
  a button to Termix's Plugins tab. Connection setup shows the same check once when Coolify has tunnelled
  servers, and a tunnelled Linked host shows "Tunnel: through SSH Terminal (Cloudflare)" with "Open tunnel
  settings". The service token is never shown in previews, results, run history, logs or the audit log
- Linked hosts are read only while Coolify manages them, with a Coolify badge, a status dot, a Coolify card
  on the host page, and Resources, Sync and Unlink in their menu. Unlink makes a host ordinary again;
  deleting a Linked host keeps its address and credential choice for the next sync
- "Import from Coolify" in the hosts import menu, and a Sync servers button on each connection
- Actions `coolify.sync-preview`, `coolify.sync-apply` and `coolify.unlink`; only the preview is offered to
  the assistant and MCP
