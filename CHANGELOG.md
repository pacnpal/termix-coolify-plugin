# Changelog

## 1.1.0

### Added

- A Deployments tab on an application: its deployment history, a page at a time, with status, commit,
  pull request and times
- A deployment's build log, live while the deployment runs: refreshed every 2 seconds while it is shown,
  stopping once the deployment ends. Lines Coolify hides by default stay hidden until you turn them on.
  Secrets are masked in every line, as in container logs
- Cancel a queued or running deployment, after a confirm
- Actions `coolify.deployment-list`, `coolify.deployment-get` and `coolify.deployment-cancel`, so the
  history, build logs (redacted, needing `confirm: true`) and cancel work from Operations Center,
  Automations, the CLI, the Termix API and MCP
- Roll an application back to an earlier image from its Deployments tab: the images Coolify keeps are
  listed with the one running now, and the rollback runs after a confirm that names the image tag
- Actions `coolify.rollback` and `coolify.resource-rollback`, with the image picked from
  `coolify.rollback-images` or `coolify.resource-rollback-images`, so rollback works from Operations
  Center, Automations, the CLI, the Termix API and MCP (with `confirmed: true`)
- Undo for a deploy: deploying an application records the image it ran before, and undoing the run rolls
  back to it

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
  `operations:run`: one tool per action plus `list_connections`, `list_hosts`, `list_resources` and
  `take_status_page_url`, run
  through Termix's operations with approvals and history. Changes over MCP stay off until an admin turns on
  "Allow changes over MCP"
- MCP output masks tokens, passwords, keys, env values and compose files at any depth, and cuts long output
  at 8,000 characters
- "Use with an MCP client" in the Connections view, with the endpoint and a client config to copy
- An API and MCP reference (`docs/api.md`) with every action's route, run path, key scope, MCP tool and a
  `curl` example, and a route map naming the action behind every plugin route and socket
- The `coolify.client` service for other Termix plugins: list connections and resources, deploy, start,
  stop and restart, read the Coolify API and tail logs, each run as the calling user through Termix's
  operations, so permissions, confirms, approvals and run history apply. It never hands out a token
- The MCP tool `list_hosts` lists the Linked hosts of a connection's Coolify servers
- Docs pages for Cloudflare tunnels, permissions, companion plugins and troubleshooting
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
  while it runs, it stops before its next save, key copy or host change and says so, so no host gets
  settings from two targets
- Re-syncing clears tunnel settings that no longer apply: a removed Access token is cleared from tunnelled
  hosts, and a server that is no longer behind a tunnel has SSH Terminal's tunnel turned off. That needs
  SSH Terminal on; until then the server says so and its host is left as it is. Hosts that were never
  tunnelled don't need SSH Terminal. Hosts linked before this release's database migration count as
  possibly tunnelled, so they may need SSH Terminal on for one sync
- Linked hosts are read only while Coolify manages them, with a Coolify badge, a status dot, a Coolify card
  on the host page, and Resources, Sync and Unlink in their menu. Unlink makes a host ordinary again;
  deleting a Linked host keeps its address and credential choice for the next sync
- Changing a connection's address, token or TLS settings reloads the Servers preview and the Linked host
  card's server status, so neither shows the old target's servers
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
- The security updates tile shows the newer of Coolify's own update check and the host card's last
  **Check now**, and says which; reading it never connects over SSH
- Every action stops before it reaches Coolify when its run is cancelled
- "Coolify: Open shell in…", "Coolify: Logs of…" and "Coolify: Sync servers" in the command palette
- Open shell and Open database console in a resource's or part's Shell view: a Coolify shell tab with SSH
  Terminal's terminal on the Linked host, in the container found by Coolify's labels (uuid first, then the
  labels from before Coolify 4.4, and for parts their own uuid, then their compose service name). `bash` or
  `sh`, and `sudo` when the SSH user needs it. A picker when several containers match, and Change container
  after a failed pick (a stopped one, say) to pick another
- Database consoles with psql, mysql or mariadb, mongosh, redis-cli, keydb-cli, clickhouse-client and
  sqlite3. Credentials are read inside the container from its own environment; no password is in the
  command, the browser, a log or the client's process arguments
- Clear answers when the server isn't linked, the container isn't running, or Termix hasn't trusted the
  host's key yet (with Coolify's fingerprint and a button to open a server terminal). Without SSH Terminal,
  the command to copy
- The action `coolify.shell-command`, offered to the assistant and MCP, answers the exact `docker exec`
  command. Shells need Operate Coolify resources, the owner or an operate grant on the connection, and your
  own connect access to the Linked host. A connection whose target changes while a shell opens answers
  nothing from the old target
- Server updates on the Linked host's Coolify card: pending and security updates, reboot required and when
  Coolify last checked, with updates that restart Docker called out. **Check now**, **Install updates** (a
  confirm lists every package and highlights Docker restarts) and **Reboot** (type the server's name) run
  through the Package Manager plugin when it runs, otherwise over SSH with fixed commands, and say which
  path ran. Actions `coolify.server-updates`, `coolify.server-updates-check`,
  `coolify.server-updates-install` and `coolify.server-reboot`
- Other Termix plugins, when installed: Create DNS record for a resource's domain (records made here are
  remembered and can be removed), Uptime monitor status with a link to Uptime, Search logs across servers
  through Log Search, and, on Linked hosts, the Security Center score, a Host Metrics card with Coolify's
  resource counts, failed backups and whether Databases has a saved login. Each hides while its plugin is
  missing or Termix's plugin list can't be read, and stops with `target-changed` when the connection's
  target changes while it runs. Create DNS record and Uptime also appear on a resource's Overview, and a
  click on Create DNS record made as the view first appears is kept
- Actions `coolify.companion-read` (offered to the assistant and MCP) and `coolify.companion` for the
  same features, including pausing and resuming a resource's Uptime monitors, and the destructive
  `coolify.companion-dns-remove`, which asks for a confirm before it deletes a DNS record made here
- Companion plugins on a resource's container, each shown only while its plugin runs: Browse files and
  Edit compose file in File Manager (the resource's `/data/coolify/...` folder, its compose file and its
  storages on the server), Reach from here through Tunnels (a forward named `web:<hostId>:coolify-<uuid>`,
  listening on the Termix server, with Stop), and Open web UI through Reverse Proxy (a one-time signed-in
  link, or what the admin must set up first). Browse files needs View Coolify; Reach from here and Open
  web UI need Operate Coolify resources and your own connect access to the Linked host. No Coolify or
  Termix token is ever passed to another plugin
- Only a private container address is forwarded or opened, only forwards you opened here can be stopped
  from here, and each person may have 5 open at once
- A Coolify view in the Tunnels tab, listing the host's Coolify resources with a port to forward and stop
- The kinds `files-paths` of `coolify.companion-read` and `tunnel-open`, `tunnel-close` and `web-ui` of
  `coolify.companion`; over MCP, tunnel-open and web-ui need Allow changes and `confirmed`, and the web UI
  link is a sensitive output, handed to the MCP caller once and never kept in run history
- Public, read-only status pages: in Connections, publish a page for the resources you pick. It shows each
  one's name, status and last deploy, never uuids, servers,
  domains, logs or secrets. The link is shown once and only its hash is stored; give a page a new link or
  revoke it at any time. Pages are served from the plugin's cache with a strict Content-Security-Policy and
  no scripts, refresh every 30 seconds, and say "Status may be out of date" when the status is over 5
  minutes old. While a page is published the plugin checks Coolify every minute, backing off after errors
- Turning off "Allow public status pages" refuses new pages, and existing pages answer "not found"
- A page answers "not found" once its connection is gone or its owner loses View Coolify, and the
  background check stops for it. After a connection's address or token changes, a page shows nothing from
  the old target, and only its chosen resources from the new one
- Actions to list, publish, rotate and revoke status pages (`coolify.status-page-list`,
  `coolify.status-page-create`, `coolify.status-page-rotate`, `coolify.status-page-revoke`). Run history
  never holds a page's link: create and rotate answer a handoff id, and the link is taken once over MCP,
  with the MCP tool `take_status_page_url`, or with `POST /plugin-api/coolify/status-pages/handoff/:id`

- The full Coolify API through Termix: `coolify.api-read` runs any Coolify read and `coolify.api-call` any
  operation after a confirm, each checked against the permission, connection access and token that
  operation needs (deletes and instance settings need **Administer Coolify**, logs need **Operate Coolify resources**).
  Request parameters and bodies never enter run history, and answers are masked. Coolify's "turn the API
  off" is never run, and operations newer than the connection's Coolify are hidden
- Deletes and operations that read or write secrets (envs, keys, tokens, logs, notification, S3, registry
  and Git app settings) run only through `coolify.api-call` or after a confirm in the console, never through
  `coolify.api-read`, so over MCP they need **Allow changes over MCP** and a confirm. Calls through the full
  API check that the connection still points at the same Coolify before they run, send only the body fields
  the operation declares, mask the connection's own token wherever an answer repeats it, and refresh the
  resource list and status tiles after a change
- Answers through the full API, the console and MCP mask passwords inside URLs (a database's connection
  URLs keep their shape with the password masked), credential query parameters, and every field a Coolify
  spec describes as a password or secret. `version` and `healthcheck` answer their text, and array query
  parameters such as `check-server-import`'s app lists are sent
- Raw config, Compose files, scripts and env text in answers are masked whole, and reads whose answer
  is logs or command output (deployments, executions, imports) need Operate Coolify resources and ask
  first, while log fields in other answers (a server's validation logs) come back masked unless an
  operator confirms, both found from Coolify's own API description. The API console keeps only the newest answer
  when you switch connections or reveal twice, keeps a Reveal clicked as an answer first appears, retries
  loading connections on Refresh, and can send null to clear a nullable field
- Request bodies through the full API offer the fields of every variant Coolify accepts (such as a
  database import from an upload or from S3)
- The API console in the Coolify tab: a form for every Coolify operation. Plain reads run at once, reads of
  secrets or logs and changes ask
  first and a delete asks you to type the operation id. Masked values can be revealed one at a time with
  **Configure Coolify** and a token with `read:sensitive`; each reveal is audited
- A Logs view on each resource and part: 100 to 10,000 recent lines, timestamps, search and download. Each
  read says where it came from: "from Coolify" (a token with `read:sensitive`) or "from the server over
  SSH" (`docker logs` on the Linked host, which needs your own connect access to it). Logs need Operate
  Coolify resources and the owner or an operate grant on the connection, as lifecycle actions do. A picker
  when several containers match, and "Link this server first" when the server has no Linked host
- Logs never show the connection's own token or Cloudflare Access secret, passwords in URLs, credential
  query parameters, secret-named fields or `Authorization` credentials, and a read whose connection changes
  target meanwhile stops with `target-changed`
- Follow: new log lines live over SSH while the view is shown. It stops, and stops `docker logs` on the
  server, when you turn it off, switch views or resources, hide the tab or close it, and it checks your
  session, permission, grant, the connection's target and your host access on every message and every 15
  seconds
- The action `coolify.logs-tail`, offered to the assistant and MCP, answers the same logs with
  `confirm: true`; run history never keeps their text, and over MCP the answer carries the masked text
- Logs mask a quoted secret through its closing quote, YAML secrets to the end of the line and env values
  to the end of the token, also when a long line is split; multibyte characters split across SSH chunks
  stay whole, a follow sends its last lines before it ends, and a follow that finds several containers
  shows the picker
- The action `coolify.exec` runs one command in a resource's container over SSH on its Linked host and
  returns the output, masked like logs (private key blocks too) and cut at 64 KB, within at most 120
  seconds. It stays off until an admin turns on "Allow running commands in containers through the API and
  MCP" and the connection's owner turns it on for that connection. Each run needs Operate Coolify
  resources, the owner or an operate or configure Grant, your own edit access to the Linked host and a
  confirm, and over MCP also "Allow changes over MCP" and `confirmed: true`. One run per resource at a
  time, three at once and twenty a minute per user; the timeout or a cancel stops the command (and, where the container has `setsid`, what it started) and closes
  the SSH connection, and a connection whose target changes while a run starts sends nothing. Runs are
  audited with lengths and the exit code only; run history keeps neither the command nor its output
- The owner's "Allow running commands in containers through the API and MCP" switch in the connection
  editor, with a warning, and the action `coolify.connection-set-exec`; it needs Configure Coolify and a
  grantee can't change it
- Logs and command output mask every private key block, also several on one line (a JSON array of
  keys) and a block that never ends; a rejected connection edit no longer turns on running commands
- A Stats tab on resources: the container's CPU and memory history from Coolify's Sentinel (up to 30 days)
  and a live `docker stats` readout every 3 seconds while the tab is open, at most 3 at once per person
- A Traffic tab on applications with Coolify's traffic analytics on: requests over time, top paths, and
  breakdowns by status code, country, browser and bot. Client IPs show only when Coolify's traffic IP mode
  is `full` and you may configure the connection
- Server metrics on a Linked host's Coolify card, from Coolify's MCP when it's on, else from Sentinel over
  SSH
- "Turn on metrics" when metrics are off for a server, for someone who may configure the connection; it
  asks first and changes the server's Sentinel settings in Coolify
- Actions `coolify.resource-metrics`, `coolify.resource-traffic` and `coolify.server-metrics`, offered to the
  assistant and MCP, and `coolify.enable-metrics`, which over MCP needs changes allowed and `confirmed`
- Following logs says why it stopped when your access or the connection changed, reconnects a lost follow up
  to 3 times, and offers Reconnect
