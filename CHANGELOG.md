# Changelog

## 1.0.6

### Fixed

- The connection editor shows the webhook, polling and exec settings as soon as a new connection is
  saved, instead of only after closing and reopening it, and reads the webhook's status again after a
  save changes the connection's address
- The event log saves the cleanup of rows an interrupted event left behind, as every other database
  write does

## 1.0.5

### Changed

- Rolling back an application and replacing or turning off the team webhook are no longer offered to
  Termix's assistant or Termix's MCP, like every other destructive action. The plugin's own MCP endpoint
  still offers them, and still refuses them without `confirmed: true`

## 1.0.4

### Changed

- The plugin no longer asks for the `users:read` capability, which nothing used, and no longer subscribes
  to `host.updated`, which nothing handled
- Permissions: a new Capabilities section says what each capability the plugin asks for is used for

## 1.0.3

### Changed

- The deployment queue asks Coolify for an application's recent deployments only when one of its
  deployments just left the queue, or every 3 minutes, instead of on every read. With polling on, a
  connection now makes about a fifth of the requests it did, and Termix's audit log, which records every
  request a plugin makes, fills far more slowly. A deployment that starts and ends between two polls is
  reported within about 4 minutes instead of 1

## 1.0.2

### Added

- Servers: **Reach through a Cloudflare tunnel** for a server Coolify reaches directly, such as the server
  Coolify runs on, which Coolify never tunnels. Enter the SSH hostname you published on a Cloudflare tunnel,
  and its Linked host connects through SSH Terminal with the connection's Cloudflare Access token, like a
  server Coolify tunnels. Coolify keeps its own address. Turning it off clears the tunnel from the host

## 1.0.1

### Fixed

- Sync servers copies each server's SSH key from Coolify again. Coolify's server list doesn't say which
  key a server uses, so every server asked for a Termix credential, and a key the server doesn't accept
  failed with "All configured authentication methods failed". Sync now reads each server for its key. A
  Linked host that was given a picked credential switches to the Coolify key on its next sync, once the key
  copies; a credential picked in that sync is still used as picked

## 1.0.0

The first release of Coolify for Termix. It brings Coolify servers and resources into Termix: connections,
resources and lifecycle, Linked hosts, shells, logs, metrics, server updates, deployments, events and
alerts, dashboard cards, companion plugins, status pages, the full Coolify API, an MCP endpoint and a
service for other plugins.

### Added

<!-- Basics -->

- The Coolify tab, opened from the sidebar, with Overview, Resources, Deployments, Events, Servers,
  Connections and API console sections. It also works in the Termix phone app, with a phone layout for
  the Resources list
- Five permissions: view, operate, configure, administer and MCP
- Admin settings for polling, SSH key copying, sharing, cloud provisioning, status pages, changes over MCP
  and running commands in containers
- The plugin's tables (connections, grants, webhooks, servers, cache, events, onboardings, status pages, DNS
  records and recent items) with migrations for SQLite, PostgreSQL and MySQL
- A cancelled run stops before it asks Coolify for anything. A deploy that waits for its result stops
  waiting when cancelled, but Coolify has already accepted that deploy
- A confirm answered after its view moved to another resource, connection or host, or closed, does
  nothing

<!-- Connections -->

- Connect Coolify instances: name, URL and API token, with an optional Cloudflare Access service token,
  local network address and CA certificate. The token is stored encrypted and never shown again. The
  address must use https, except plain http to localhost, or to a private IP address with "On my local
  network" on (the token then travels in the clear on that network)
- A check of each connection: Coolify 4.4 or newer, the team, scoped tokens, and whether the token can read
  keys, logs and instance settings, with a plain cause and fix when something fails
- The Connections view and a "Connect Coolify" setup step
- Actions to list, check, add, change and remove connections; token fields never appear in run history
- A connection is reached only by the person who added it. Every check already knows shared access
  (grants), but nothing creates a grant yet
- A read that finishes after its connection's address, token or Access settings changed never answers the
  old target's data. It ends with `target-changed` (409), or reads as unknown, and you can try again

<!-- Resources and lifecycle -->

- The Overview counts running, degraded, stopped and deploying resources; a tile opens the Resources list
  filtered to it. A resource Coolify reports as exited counts as stopped, not degraded, since that is how
  Coolify reports one you stopped yourself
- The Resources list: every application, service and database of a connection, with each service's parts
  under it, its status, Coolify server, project and environment, domains and last deploy. Search and filter
  by type and status. A resource opens its Overview in place
- Resources come from Coolify's per-type lists without environment values, keys, tokens or compose files,
  and statuses are cached for 20 seconds; Refresh fetches them again
- Actions to list a connection's resources and read one (`coolify.list-resources-all`,
  `coolify.resource-get`), offered to the assistant and MCP
- Deploy, Force rebuild, Restart, and Start or Stop in a resource's header, with a Restart for each part of
  a service. Stop and Force rebuild ask first, naming the resource
- Lifecycle works with or without a Linked host: on a Linked host's resource through `coolify.deploy`,
  `coolify.start`, `coolify.restart` and `coolify.stop` (in the host's history), otherwise through
  `coolify.resource-deploy`, `coolify.resource-restart` and `coolify.resource-action`. Each needs the Operate
  permission and the owner or an operate grant, and accepts only that connection's own resources
- Deploy can wait for the deployment. The wait ends as soon as the deployment reaches a final status and
  sends a deployment finished or failed event through the event pipeline, so it is in the event log. A
  deployment Coolify skipped fails the run with the cause `skipped`. A deployment still running after 30
  minutes fails the run with the cause `wait-timeout` (504 on the deploy route) and a link to follow it,
  and sends no event, since it hasn't ended
- Over MCP, deploy and restart work without "Allow changes over MCP"; start and stop still need it
- Coolify resources on Linked hosts (`coolify.resource`, `coolify.list-resources`), `coolify.sync-host`,
  status tiles for degraded resources, server reachability, security updates and deployments running
- The security updates tile shows the newer of Coolify's own update check and the host card's last
  **Check now**, and says which; reading it never connects over SSH
- "Coolify: Deploy…", "Coolify: Open shell in…", "Coolify: Logs of…" and "Coolify: Sync servers" in the
  command palette

<!-- Host sync and Linked hosts -->

- Sync servers, in the Coolify tab's Servers section: each Coolify server becomes a Linked host in a
  "Coolify" folder (or "Coolify / <connection>" with several connections), tagged `coolify`, with a note
  linking back to Coolify. A preview shows every server first; re-sync updates hosts in place, and servers
  gone from Coolify are flagged, never deleted
- Each Coolify SSH key is copied once into a Termix credential named "Coolify: <connection> / <key>", reused
  until the key's fingerprint changes or you delete that credential. Every copy is audited. When the token
  can't read keys, an admin turned key copying off, or a key copy fails, you pick a Termix credential
  instead. A picked credential that was deleted, or couldn't be checked, shows the picker again
- The server Coolify runs on (`host.docker.internal`, `localhost` or `127.*`) waits for the address Termix
  should use, while the other servers sync. Any other server can be given its own address too
- Servers behind a Cloudflare tunnel become Linked hosts reached through SSH Terminal's own tunnel: the host
  address is the tunnel hostname, and SSH Terminal's tunnel settings are set (port 443, plus the connection's
  Cloudflare Access service token when one is set). This needs SSH Terminal 1.2.0 or newer to be on; until
  then those servers say "Turn on the SSH Terminal plugin" or "Update SSH Terminal to 1.2.0 or newer", with
  a button to Termix's Plugins tab. Connection setup shows the same check once when Coolify has tunnelled
  servers, and a tunnelled Linked host shows "Tunnel: through SSH Terminal (Cloudflare)" with "Open tunnel
  settings". The service token is never shown in previews, results, run history, logs or the audit log
- Re-syncing clears tunnel settings that no longer apply: a removed Access token is cleared from tunnelled
  hosts, and a server that is no longer behind a tunnel has SSH Terminal's tunnel turned off. That needs
  SSH Terminal on; until then the server says so and its host is left as it is. Hosts that were never
  tunnelled don't need SSH Terminal
- Syncs, unlinks and connection removals of one connection run one at a time, so overlapping syncs never
  make two hosts for one server, a sync waiting behind a removal creates nothing, and a host whose link
  can't be saved is removed instead of left locked
- A sync uses one snapshot of its connection. If the connection's address, token or Access token changes
  while it runs, it stops before its next save, key copy or host change and says so, so no host gets
  settings from two targets
- Linked hosts are read only while Coolify manages them, with a Coolify badge, a status dot, a Coolify card
  on the host page, and Resources, Sync and Unlink in their menu. Unlink makes a host ordinary again and
  checks the host again after its confirm; deleting a Linked host keeps its address and credential choice
  for the next sync
- A Linked host's status dot warns when its server is unreachable or a resource on it is degraded. Every
  Linked host of a connection shares one status read (a minute in the browser, answered from the plugin's
  own caches), so host rows don't ask Coolify for its server list each time
- A **Coolify** button on Linked hosts, and **Coolify resources** in their menu, open the Resources list
  filtered to that host's server; the filter shows the server's name and clears with one click
- Changing a connection's address, token or TLS settings reloads the Servers preview and the Linked host
  card's server status, so neither shows the old target's servers
- "Import from Coolify" in the hosts import menu, and a Sync servers button on each connection, both
  opening the Servers section, also when the tab is already open on another section
- Actions `coolify.sync-preview`, `coolify.sync-apply` and `coolify.unlink`; only the preview is offered to
  the assistant and MCP. The MCP tool `list_hosts` lists the Linked hosts of a connection's Coolify servers
- `GET /plugin-api/coolify/connections/:id/server-health`: each server's reachability, degraded count,
  resource counts and deployments, served from the plugin's shared server and resource caches

<!-- Shells and database consoles -->

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
- A Coolify shell tab's terminal toolbar shows the container's name and status (Running, Degraded, Stopped
  or Deploying), from the plugin's cached resource list, and **Gone** once the resource is no longer in
  Coolify. The name is the container the shell connected to, and follows a change of container

<!-- Logs and exec -->

- A Logs view on each resource and part: 100 to 10,000 recent lines, timestamps, search and download. Each
  read says where it came from: "from Coolify" (a token with `read:sensitive`) or "from the server over
  SSH" (`docker logs` on the Linked host, which needs your own connect access to it). Logs need Operate
  Coolify resources and the owner or an operate grant on the connection, as lifecycle actions do. A picker
  when several containers match, and "Link this server first" when the server has no Linked host
- Logs never show the connection's own token or Cloudflare Access secret, passwords in URLs, credential
  query parameters, secret-named fields, `Authorization` credentials or private key blocks (several on one
  line, a block that never ends, and a key cut off by the start of the log), and a read whose connection
  changes target meanwhile stops with `target-changed`
- Logs mask a quoted secret through its closing quote, YAML secrets to the end of the line and env values
  to the end of the token, also when a long line is split; multibyte characters split across SSH chunks
  stay whole
- Follow: new log lines live over SSH while the view is shown. It stops, and stops `docker logs` on the
  server, when you turn it off, switch views or resources, hide the tab or close it, and it checks your
  session, permission, grant, the connection's target and your host access on every message and every 15
  seconds. A follow sends its last lines before it ends, shows the picker when it finds several
  containers, says why it stopped when your access or the connection changed, reconnects a lost follow up
  to 3 times, and offers Reconnect
- The action `coolify.logs-tail`, offered to the assistant and MCP, answers the same logs with
  `confirm: true`; run history never keeps their text, and over MCP the answer carries the masked text
- The action `coolify.exec` runs one command in a resource's container over SSH on its Linked host and
  returns the output, masked like logs and cut at 64 KB, within at most 120 seconds. It stays off until an
  admin turns on "Allow running commands in containers through the API and MCP" and the connection's owner
  turns it on for that connection. Each run needs Operate Coolify resources, the owner or an operate or
  configure grant, your own edit access to the Linked host and a confirm, and over MCP also "Allow changes
  over MCP" and `confirmed: true`. One run per resource at a time, three at once and twenty a minute per
  user; the timeout or a cancel stops the command (and, where the container has `setsid`, what it
  started) and closes the SSH connection, and a connection whose target changes while a run starts sends
  nothing. Runs are audited with lengths and the exit code only; run history keeps neither the command nor
  its output
- The owner's "Allow running commands in containers through the API and MCP" switch in the connection
  editor, with a warning, and the action `coolify.connection-set-exec`; it needs Configure Coolify and a
  grantee can't change it. It is applied only when the rest of the connection edit succeeds

<!-- Metrics -->

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

<!-- Server updates -->

- Server updates on the Linked host's Coolify card: pending and security updates, reboot required and when
  Coolify last checked, with updates that restart Docker called out. **Check now**, **Install updates** (a
  confirm lists every package and highlights Docker restarts) and **Reboot** (type the server's name) run
  through the Package Manager plugin when it runs, otherwise over SSH with fixed commands, and say which
  path ran. The output an install shows is masked like logs and cut to its last 4,000 characters. Actions
  `coolify.server-updates`, `coolify.server-updates-check`, `coolify.server-updates-install` and
  `coolify.server-reboot`

<!-- Deployments, previews and rollback -->

- A Deployments tab on an application: its deployment history, a page at a time, with status, commit,
  pull request and times
- A deployment's build log, live while the deployment runs: refreshed every 2 seconds while it is shown,
  stopping once the deployment ends. Lines Coolify hides by default stay hidden until you turn them on.
  Secrets are masked in every line, as in container logs
- Cancel a queued or running deployment, after a confirm
- Actions `coolify.deployment-list`, `coolify.deployment-get` and `coolify.deployment-cancel`, so the
  history, build logs (redacted, needing `confirm: true`) and cancel work from Operations Center,
  Automations, the CLI, the Termix API and MCP
- A Deployments section in the Coolify tab: the connection's queued and running deployments and its recent
  ones, each opening its live build log with cancel. Only the connection's own applications are shown, and
  the list refreshes only while it is shown. Coolify's older `error` status counts as failed
- Deployments in progress on the Overview, from the same read as the Deployments section
- Deploy by tag, with force rebuild, a pull request and a Docker tag: it lists the resources it will deploy
  and asks first, and deploys only those
- Actions `coolify.deployment-queue` and `coolify.deploy-by-tag` (a dry run lists the resources; over MCP it
  needs `confirmed: true`)
- Roll an application back to an earlier image from its Deployments tab: the images Coolify keeps are
  listed with the one running now, and the rollback runs after a confirm that names the image tag
- Actions `coolify.rollback` and `coolify.resource-rollback`, with the image picked from
  `coolify.rollback-images` or `coolify.resource-rollback-images`, so rollback works from Operations
  Center, Automations, the CLI, the Termix API and MCP (with `confirmed: true`)
- Undo for a deploy: deploying an application records the image it ran before, and undoing the run rolls
  back to it
- A Previews tab on an application: its pull request previews with their status, domains and newest
  build. Deploy a preview for a pull request, change a preview's domains (checked before they are sent)
  and delete one, each after a confirm; open a preview's build log and its container logs (redacted)
- A new preview needs the commit of a Bitbucket pull request and the image tag of a Docker image
  application (a redeploy needs neither); the domain editor keeps Coolify's port overrides; a Docker
  Compose preview's domains are edited per service. A port given with a domain is kept, `:80` and `:443`
  included
- Actions `coolify.preview-list`, `coolify.preview-create`, `coolify.preview-domains`,
  `coolify.preview-delete` and `coolify.preview-logs`, so previews work from Operations Center,
  Automations, the CLI, the Termix API and MCP. Over MCP, deploying a preview and changing its domains need
  `confirmed: true`
- A Coolify older than 4.7.5 that has no preview API gets a message to update Coolify

<!-- Activity and terminal surfaces -->

- Termix's recent activity shows "Opened shell in <app>" when a container shell or database console opens
  on a Linked host, and "Deployed <app>" when Coolify starts a deploy: deploy, deploy by tag (one entry per
  resource), rollback, and pull request previews ("Deployed <app> (pull request #<n>)"). A deploy is
  recorded once Coolify accepts it, whether it later finishes or fails. It works from the UI, the
  operations API, the CLI, Automations and MCP alike. Only a Linked host you can connect to gets an entry;
  a failure to record one never fails the shell or deploy. An entry opens the Coolify tab
- A Coolify panel beside terminals on Linked hosts: the resources on that host's Coolify server, each with
  **Shell** (a new Coolify shell tab), **Logs**, **Restart** and **Deploy**. Restart and Deploy ask first.
  The actions need **Operate Coolify resources** and the connection's owner or an operate or configure
  grant. Other hosts get no panel and no request to Coolify. **Refresh resources** reads the list again,
  and so does showing the panel again
- A Coolify activity panel in the sidebar: deployments in progress, recent failed deployments, degraded
  resources and unreachable servers across every connection you can view. Each row opens its place in the
  Coolify tab, and the panel refreshes only while it is shown
- A badge on the Coolify rail item counting running deployments and recent failures, hidden at zero and
  without the View Coolify permission
- Action `coolify.attention`, the same list for Operations Center, Automations, the CLI, the Termix API and
  MCP. The panel, the badge and the action share the tab's cached reads, so they add no Coolify requests

<!-- Events, polling, webhook and alerts -->

- An event log for every connection, read with the `coolify.events-list` action (Operations Center,
  Automations, the CLI, the operations API and the MCP tool `coolify__events_list`) or
  `GET /plugin-api/coolify/connections/{id}/events`. It lists the connection's events newest first, a page
  at a time, filtered by kind or by resource or server. It keeps the newest 1,000 events per connection,
  and removing a connection removes its events. Needs **View Coolify**; another user's connection is
  never shown. Someone a connection is granted to sees only rows about what that connection's Coolify
  has now (its resources and servers) plus team-wide ones; if Coolify can't be read to check, the read
  fails rather than show a partial log. The owner sees every row
- An **Events** section in the Coolify tab shows that log: newest first, filtered by event kind or
  resource, with older pages on request. A row opens its deployment's build log, its resource or its
  server's resources. It refreshes every minute while shown and starts again when the connection or its
  target changes
- Operations events for Automations: `coolify.deployment-finished`, `coolify.deployment-failed`,
  `coolify.container-restarted`, `coolify.server-unreachable`, `coolify.status-changed`,
  `coolify.restart-limit`, `coolify.backup-succeeded`, `coolify.backup-failed`, `coolify.task-succeeded`,
  `coolify.task-failed`, `coolify.high-disk`, `coolify.certificate-problem` and `coolify.token-expiring`.
  Each event is sent once per dedupe key: once per deployment, and otherwise once per kind, resource (or
  server) and minute, so the same thing seen in different minutes can be separate events. Scheduled task
  events are also told apart by their task. An event carries the host only when its server is Linked.
  Events hold no secrets, tokens, credentials inside URLs or log text
- Polling: every connection checks Coolify with its own token every minute (or the admin's **Minimum poll
  interval**), and its backups and scheduled tasks every five minutes, and sends what changed as events:
  a deployment that finished or failed, a resource that went between running, degraded and stopped or
  started restarting, a server that became unreachable, and a backup or scheduled task run that succeeded
  or failed. A poll that sees a deployment a waited deploy already reported sends no second event. The
  first poll after Termix starts, or after the connection's address or token changes, only notes what is
  there, so nothing that already happened is sent. A connection polls until its team's Coolify webhook has
  delivered once, and after that only with **Keep polling after a webhook arrives** on, in the connection
  editor or with the `coolify.connection-set-poll` action (MCP tool `coolify__connection_set_poll`, or
  `pollEnabled` on `PATCH /plugin-api/coolify/connections/{id}`). After failures it waits 1, 2, 5, then 15
  minutes, and the connection shows why its last poll failed. The admin setting **Allow polling** turns it
  off
- Coolify's team webhook: `POST /plugin-api/coolify/webhook/{token}` takes Coolify's own notifications
  (deployments, restart limits, backups, scheduled tasks, high disk usage, unreachable servers) and turns
  them into events at once. One webhook serves every connection to the same Coolify team, and each event
  reaches only the connections whose own token can read what it is about, checked live with one request per
  event and connection that counts against that connection's request budget; any refusal or error drops it
  there. The token is 32 random bytes, stored only as a hash. Bodies over 64 KB, of any shape but Coolify's,
  or with an unknown token get the same refusal, and the plugin's answers never echo what was sent. A
  body that isn't JSON at all is refused by Termix's own body parser before it reaches the plugin. A
  Coolify "resource stopped" notification becomes a `coolify.status-changed` event for a standalone
  application or database (not for a preview or a service's part, which the poller doesn't count either).
  While the plugin is still checking 32 deliveries of one team it answers `503`, which Coolify retries,
  and doesn't count the delivery, so a busy answer never stops polling. Once a delivery is counted, a
  connection whose own check refuses or fails gets nothing for that event, and with polling off nothing
  catches it later: turn on **Keep polling after a webhook arrives** for a connection that must not miss
  one
- One-click Coolify webhook setup: **Set up webhook** in a connection's settings, the actions
  `coolify.webhook-status`, `coolify.webhook-setup`, `coolify.webhook-replace` and
  `coolify.webhook-disable` (Operations Center, Automations, the CLI, the Termix API and MCP), and
  `GET`, `POST` and `DELETE /plugin-api/coolify/connections/{id}/webhook` with
  `POST .../webhook/replace`. It reads the team's webhook first: none set, or already this Termix, and it
  writes this Termix's address and ticks the notifications the plugin turns into events; set to somewhere
  else, and it shows only that address's host and asks before replacing it (declining changes nothing and
  leaves polling on). Turning it off removes only this Termix's own address. The address is the one Termix
  was opened at, never guessed, and the settings warn when it is private, which Coolify refuses. The
  webhook token is only ever sent to Coolify, never shown, kept in run history or logged. Needs
  **Configure Coolify** and owner or configure access to the connection; replacing and turning off ask
  for a confirm, and over MCP need `confirmed: true`
- Alerts: every stored event reaches the Termix Alerts inbox (and the delivery channels set up there) of
  the connection's owner and of each person it is shared with, for the kinds each of them picked. Until
  someone picks, they get deploy failed, restart limit, server unreachable, backup failed, task failed,
  high disk, certificate problems and API token expiring. Each alert names the resource and what happened,
  carries no secrets, has the category `coolify.<kind>` for routing, is sent once per event, and opens the
  resource, server or connection in the Coolify tab. Losing **View Coolify** or access to the connection
  stops a person's alerts at once
- Alert preferences per person and per connection: the **Alerts** action on each connection (also for
  connections shared with you) picks the kinds and links to the Alerts delivery channels. Also as the
  `coolify.alert-prefs` and `coolify.alert-prefs-set` actions (MCP tools `coolify__alert_prefs` and
  `coolify__alert_prefs_set`) and `GET`/`PUT /plugin-api/coolify/connections/{id}/alert-prefs`. Each
  person reads and changes only their own; unknown kinds are refused

<!-- Dashboard and homepage -->

- Coolify on Termix's dashboard and homepage: four cards, each with its own connection (and resource) in
  its settings. **Coolify overview** counts the connection's resources by status and its unreachable
  servers, **Coolify resource** shows one resource's status with Deploy (for operators only, with a
  confirm that does nothing once the card has moved to another target), **Coolify deployments** lists
  deployments in progress and **Coolify vulnerabilities** counts resources with known vulnerabilities and
  links to Coolify. The dashboard offers them under Coolify in its add list; the Homepage plugin offers
  the same four as widgets. They read through the caches the tab uses and read again only once those
  have turned over, and only while shown
- Actions `coolify.connection-overview` and `coolify.vulnerability-summary`, with the routes
  `GET /connections/{id}/overview` and `GET /connections/{id}/vulnerabilities`, for Operations Center,
  Automations, the CLI, the Termix API and MCP. The vulnerability counts come from Coolify's image scanning
  and are kept five minutes per connection; they carry no resource names or Coolify text
- Linked hosts on Termix's dashboard show their Coolify server's resources: how many are running, degraded
  and stopped, by the same rules as the Coolify tab (exited is stopped, Parts aren't counted). While a
  deployment on that server is queued or running, the row's status badge shows **Deploying**. The
  homepage's host metrics show the CPU and memory all running containers use on a Linked host, from one
  `docker stats` reading over SSH, for people with **Operate Coolify resources** and owner or operate
  access to the connection (the Stats tab's rule). Hosts that aren't linked show nothing. Every host of a
  connection shares one request, the counts come from the plugin's shared caches, and a host's container
  stats are read over SSH at most once every 30 seconds however many people look
- Actions `coolify.host-summary` (a Linked host's resource counts and deployments) and
  `coolify.host-metrics` (its container CPU and memory), in Operations Center, Automations, the CLI, the
  operations API and MCP, and the route `GET /plugin-api/coolify/connections/{id}/host-metrics`

<!-- Companion plugins -->

- Other Termix plugins, when installed: Create DNS record for a resource's domain (records made here are
  remembered and can be removed), Uptime monitor status with a link to Uptime, Search logs across servers
  through Log Search, and, on Linked hosts, the Security Center score, a Host Metrics card with Coolify's
  resource counts, failed backups and whether Databases has a saved login. Each hides while its plugin is
  missing or Termix's plugin list can't be read, and stops with `target-changed` when the connection's
  target changes while it runs. Create DNS record and Uptime also appear on a resource's Overview, and a
  click on Create DNS record made as the view first appears is kept
- Log Search results are masked as container logs are, in every field of a hit, before a message is cut
  to 2,000 characters, including a private key split across several hits
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

<!-- Status pages -->

- Public, read-only status pages: in Connections, publish a page for the resources you pick. It shows each
  one's name, status and last deploy, never uuids, servers, domains, logs or secrets. The link is shown
  once and only its hash is stored; give a page a new link or revoke it at any time. Pages are served from
  the plugin's cache with a strict Content-Security-Policy and no scripts, refresh every 30 seconds, and
  say "Status may be out of date" when the status is over 5 minutes old. While a page is published the
  plugin checks Coolify every minute, backing off after errors
- Turning off "Allow public status pages" refuses new pages, and existing pages answer "not found"
- A page answers "not found" once its connection is gone or its owner loses View Coolify, and the
  background check stops for it. After a connection's address or token changes, a page shows nothing from
  the old target, and only its chosen resources from the new one
- Actions to list, publish, rotate and revoke status pages (`coolify.status-page-list`,
  `coolify.status-page-create`, `coolify.status-page-rotate`, `coolify.status-page-revoke`). Run history
  never holds a page's link: create and rotate answer a handoff id, and the link is taken once over MCP,
  with the MCP tool `take_status_page_url`, or with `POST /plugin-api/coolify/status-pages/handoff/:id`

<!-- The full Coolify API -->

- Coolify's API descriptions for v4.7.5, `main` and `next`, a list of every Coolify API operation with the
  oldest Coolify version that has it, and a coverage page naming how the plugin uses each one
- The full Coolify API through Termix: `coolify.api-read` runs any Coolify read and `coolify.api-call` any
  operation after a confirm, each checked against the permission, connection access and token that
  operation needs (deletes and instance settings need **Administer Coolify**, logs need **Operate Coolify
  resources**). Request parameters and bodies never enter run history, and answers are masked. Coolify's
  "turn the API off" is never run, and operations newer than the connection's Coolify are hidden
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
- Raw config, Compose files, scripts and env text in answers are masked whole, and reads whose answer is
  logs or command output (deployments, executions, imports) need Operate Coolify resources and ask first,
  while log fields in other answers (a server's validation logs) come back masked unless an operator
  confirms, both found from Coolify's own API description. Log fields shown to an operator are masked as
  container logs are
- Request bodies through the full API offer the fields of every variant Coolify accepts (such as a
  database import from an upload or from S3)
- The API console in the Coolify tab: a form for every Coolify operation. Plain reads run at once, reads of
  secrets or logs and changes ask first and a delete asks you to type the operation id. Masked values can
  be revealed one at a time with **Configure Coolify** and a token with `read:sensitive`; each reveal is
  audited. The console keeps only the newest answer when you switch connections or reveal twice, keeps a
  Reveal clicked as an answer first appears, retries loading connections on Refresh, and can send null to
  clear a nullable field

<!-- MCP, operations and other plugins -->

- An MCP endpoint at `/plugin-api/coolify/mcp` for Termix API keys scoped to `operations:read` or
  `operations:run`: one tool per action plus `list_connections`, `list_hosts`, `list_resources` and
  `take_status_page_url`, run through Termix's operations with approvals and history. Changes over MCP
  stay off until an admin turns on "Allow changes over MCP", except deploy and restart, which MCP may run
  either way
- MCP output masks tokens, passwords, keys, env values and compose files at any depth, and cuts long output
  at 8,000 characters
- "Use with an MCP client" in the Connections view, with the endpoint and a client config to copy
- The `coolify.client` service for other Termix plugins: list connections and resources, deploy, start,
  stop and restart, read the Coolify API and tail logs, each run as the calling user through Termix's
  operations, so permissions, confirms, approvals and run history apply. It never hands out a token
- An API and MCP reference (`docs/api.md`) with every action's route, run path, key scope, MCP tool and a
  `curl` example, and a route map naming the action behind every plugin route and socket
- Docs pages for Cloudflare tunnels, permissions, companion plugins and troubleshooting
