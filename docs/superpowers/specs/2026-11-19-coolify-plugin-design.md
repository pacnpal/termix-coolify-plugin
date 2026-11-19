# Coolify plugin for Termix: design

Status: draft for approval, 2026-11-19

## Intent

People who run Coolify also live in Termix, and the two don't know about each other. Today a Coolify server
has to be added to Termix by hand: copy the key, work out the Cloudflare tunnel, guess the port. Then
container names get dug out of `docker ps`, and deploys, logs, variables and backups happen in a different
app.

The owner asked for "the ultimate Coolify plugin": **use as much of both APIs as possible, while staying
inside what Termix allows plugins to do.** So this plugin is two things at once:

1. **Termix as a full Coolify client.** Every area of Coolify's REST API (about 330 operations in v4.7.5)
   shows up in Termix. That includes read, operate, configure, create and delete, for projects, apps,
   services, databases, servers, keys, git sources, storage, DNS, cloud provisioning, notifications, the
   team and security.
2. **Coolify woven into every Termix surface.** Coolify servers become ready-to-use Termix hosts, tunnels
   included. Containers open in Termix's real terminal in one click. Coolify things appear in Operations
   Center, Automations, the CLI, the assistant and MCP, the command palette, the dashboard, the homepage,
   the host page, beside terminals, in alerts and on the phone. It also works in reverse: any Termix host
   can become a Coolify server.

When in doubt, plug into an existing Termix surface rather than building a parallel one, and expose a
Coolify capability rather than leave it out.

## Goals

1. **Zero-setup access.** Connect a Coolify instance once. Every Coolify server becomes a Termix host
   that connects first time: tunnelled ones, the SSH key, the user and the port.
2. **One click into any container.** From any app, service part or database, a shell in its running
   container, or a native database console, in Termix's real terminal.
3. **Full Coolify control.** Cover every Coolify API area (the coverage matrix below). Each one is read,
   acted on, configured, created or deleted, as far as that area's API goes.
4. **Every Termix surface.** Use every Termix extension point that fits (the surface matrix below), so
   Coolify work happens wherever the person already is.
5. **Know when things happen.** Deploys, restarts, unreachable servers, failed backups and scheduled tasks
   reach Termix's Alerts inbox and Automations triggers.
6. **Both directions.** Turn an existing Termix host into a Coolify server (keys, validation, linking)
   without opening Coolify.

## Non-goals

- Re-implementing Coolify features that have no API, such as metrics history graphs, the Traefik dashboard
  and the build-pack editor UI. Where Coolify's dashboard is the only way, link to that exact page.
- Replacing the Docker plugin. Hosts we create switch it on when it is installed.
- Our own Cloudflare tunnel code or running `cloudflared`. The SSH Terminal plugin already carries tunnels
  for every SSH connection in Termix.
- Talking to Coolify's MCP endpoint (`/mcp`). Its one unique tool, metrics, is approximated over SSH. See
  "Gaps".

## Anti-goals (failure even if it "works")

- A Coolify token, Cloudflare token, cloud provider token, git app secret, S3 secret, env value or SSH
  private key reaching the browser, a log, an error, an operations run record or an audit detail. The one
  exception is a value the user explicitly reveals, which is shown once and never cached.
- Raw Coolify payloads stored or forwarded. `/resources` returns about 350 KB for 15 resources, with git
  credentials and compose files inside.
- A host that looks set up but silently can't connect. Every failure names its cause and its fix.
- A plugin that can lock itself or the user out. It never calls `POST /disable` (turns off Coolify's API) or
  `/mcp/disable` on its own initiative, and never deletes the private key or server its own hosts depend on
  without a typed confirmation.
- Destructive Coolify calls without a confirm naming the exact thing. Delete, stop, volume removal and server
  delete need `useConfirm`; deletes that remove data need the name typed out.
- Network calls the user didn't ask for (Termix review rule 19).
- Any Termix user driving a connection they don't own or weren't granted.

## Facts this design rests on

These were checked in source code, against the owner's live instances, or both. Details are in the research
notes. These are the load-bearing ones.

**Coolify** (v4.7.5 source and `openapi.json`; the owner runs a newer build with extra fields such as
`is_coolify_host`, `settings.ssh_host_key_fingerprints` and `patch_check_result`, so tolerate unknown and
missing fields):

- **API basics:**
  - REST is at `<url>/api/v1` with `Authorization: Bearer <token>`.
  - Token abilities are `read`, `read:sensitive`, `write`, `write:sensitive`, `deploy`, `delete` and `root`.
  - The rate limit is 200 requests a minute, and 30 failed requests a minute triggers a 429.
  - The instance-wide API toggle answers 403 "API is disabled."
- **What needs `read:sensitive` (or `root`) from a team admin:** private key material, container logs,
  deployment build logs, env values, and server sentinel and logdrain secrets.
- **Scoped tokens:** a token scoped to projects or resources can only reach applications, services,
  databases, projects, deploy, deployments, resources, version and vulnerabilities.
- **Servers:**
  - `ip`, `port` and `user` are the SSH target.
  - `settings.is_cloudflare_tunnel` marks a tunnelled server. Its `ip` is the tunnel SSH hostname, and
    `port` is the origin port behind the tunnel.
  - Coolify itself runs `cloudflared access ssh --hostname <ip>` with no service token. On the owner's
    account those hostnames have no Access app (verified), so a service token is optional.
  - The Coolify host has `ip: host.docker.internal`, which is unreachable from Termix.
- **Containers:**
  - They are labelled `coolify.managed`, `coolify.{application,service,database}Uuid` (v4.4+; numeric `…Id`
    before) and `coolify.service.subUuid/subType/subName`.
  - Standalone databases are named `<uuid>`, and service parts `<part>-<service_uuid>`.
- **Coolify's own terminal:** it checks that the container is running, prefers `bash` and falls back to
  `sh`, adds `sudo` for non-root users, and uses `docker attach` when the container has `OpenStdin`.
- **Webhooks:**
  - One unsigned JSON webhook per team.
  - Events: `deployment_success|failed`, `status_changed`, `container_restarted`, `restart_limit_reached`,
    `backup_*`, `volume_backup_*`, `server_reachable|unreachable`, `server_force_*`,
    `server_ssh_host_key_changed`, `high_disk_usage`, `docker_cleanup_*`, `task_*`, `ssl_certificate_renewal`,
    `api_token_expiring|failing`, `image_vulnerabilities_digest`, `test` and `general`.
  - Coolify refuses private or LAN targets.
- **What doesn't exist:** there's no exec API, no REST metrics data and no API to create a team or invite
  members.

**Termix** (SDK 2.8.1, core f1c2964):

- **Host settings of other plugins:** `ctx.hosts.create` and `update` may write another plugin's declared
  host settings, secrets included and encrypted. Core's own test `ctx-hosts.test.ts:456` proves it.
  - The SSH Terminal plugin's `cloudflareTunnelEnabled`, `Hostname`, `Port`, `ClientId` and `ClientSecret`
    make its `ssh:transport` carry every SSH connection to the host over the tunnel.
  - If the owning plugin isn't running, the values are skipped and logged.
- **Real terminal from other plugins:** SSH Terminal offers the component `terminal.view`, which other
  plugins embed via `PluginComponent` (manifest `uses`). Its `executeCommand` prop runs once the shell is
  ready, on fresh connections only.
- **Hosts:** create, update, delete, `listOwned`, `folders.ensure`, `share` and `setShares`, and locks
  (`hosts:lock`). `ctx.credentials.createSshKey` (`credentials:write`). There's no API to pre-trust a host
  key; the first connect needs a terminal (`HOST_KEY_UNVERIFIED` otherwise).
- **SSH:** `ctx.ssh.exec`, `connect` and `withConnection` (`ssh:connect` + `credentials:use`), through the
  full pipeline with tunnels and jump hosts.
- **Operations:**
  - Resources need a host: the list action runs per host, and each row is `{hostId, resourceKey}`.
  - Signals and events can be `server` scoped.
  - `optionsFrom` fills choice inputs.
  - Assistant and MCP surfaces are opt-in per action.
- **Frames:** they reach only our own routes, `app.tabs.openTab` and `connectHost` work, badges and dots
  are data values, and other plugins' parts are embedded through `uses`.
- **Public routes:** `ctx.http.router({ public: [...] })` parses JSON, with a default limit of 120 requests a
  minute per address.
- **Background work:**
  - `ctx.notify.send({ audience: { userId } })` needs no actor.
  - `ctx.secrets.seal` and `unseal` work with no actor.
  - `ctx.asUser` needs `users:impersonate`, which we don't request.
- **Docker plugin:** its console isn't reusable. Its services `docker.containers` and `docker.events` and
  its operations are.

## Approaches considered

1. **Hosts-first integration plus a full Coolify client (chosen).**
   - Mirror Coolify servers as managed Termix hosts with tunnels preset.
   - Build the Coolify experience on those hosts, plus a complete client UI.
   - Everything else in Termix (terminal, files, Docker, snippets) works on them for free, and Operations
     Center gets real hosts to hang resources on.
2. **Standalone console, no Termix hosts.** Rejected: no tunnel reuse, no Docker plugin, no files, no
   Operations resources, and we'd own SSH plumbing.
3. **Our own tunnel transport** (`ssh:transport` + `network:sockets`). Rejected: duplicates SSH Terminal and
   needs two high-risk capabilities.
4. **Typed client generated from Coolify's `openapi.json` vs. hand-written per endpoint.** Chosen: generated.
   - A build-time script (`scripts/gen-coolify-client.mjs`) turns the pinned spec (committed under
     `vendor/coolify-openapi.json`) into types and a thin request layer. The output is committed and
     regenerated when the spec is bumped.
   - This makes "cover all 330 operations" tractable and checkable: a test asserts every spec operation is
     either used by a feature or listed in `docs/coverage.md` with a reason.
   - This is not code downloaded at runtime (rule 18): the spec is vendored, and the generator runs in
     development only.

**SSH key handling (owner's decision): A with fallback.**

- When the token can read keys, each Coolify private key becomes one Termix SSH key credential, and hosts
  use it.
- Otherwise the user picks an existing Termix credential per server, or one default per connection.

## Coolify coverage matrix

Every tag in Coolify's API and where it lands. "Tab" means the Coolify tab, which uses a `SideNav` with
these sections.

**Applications (43 operations)**

- List, detail and edit (PATCH) the common fields: name, domains, build pack, branch, ports, health check,
  limits and commands. Raw compose and Dockerfile are shown read-only, and editable behind a "show
  advanced" switch.
- Create from a public git repo, a GitHub App, a Gitea App, a deploy key, a Dockerfile, a Docker image or
  compose. The create wizard has project, environment, server and destination pickers.
- Delete, with options to delete volumes, configurations, connected networks and run docker cleanup.
- Start, stop and restart. Deploy and force rebuild through `/deploy`.
- Clone. Move to another environment and migrate to another server.
- Logs, previews (list, create, delete, update domains, logs), envs (CRUD and bulk) and storages (CRUD).
- Storage backups: set the schedule, run now, delete.
- Tags, rollback images plus rollback, and destinations (list, add, remove: multi-server).
- Where it surfaces: the tab's Resources section and the detail view, Operations resource
  `coolify.resource`, the palette, host companion and section, and mobile.

**Services (27), service applications (8) and service databases (10)**

- Everything above that services have.
- Create from Coolify's one-click templates: `POST /services` with `type`. Template ids come from
  `GET /services` validation errors and Coolify's template list. The builder confirms the source; if
  there's no API list, ship the template id list vendored with the spec.
- Per-part start, stop, restart, logs and PATCH (image, domains, excluded-from-status).
- Database imports for service databases: upload, start, status.
- Where it surfaces: same as applications, with parts as child rows.

**Databases (44)**

- Create all nine engines: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse and
  SQLite.
- Detail and PATCH, including public port and image. Start, stop, restart, delete and clone.
- Move and migrate, envs, storages, tags and logs.
- Scheduled backups: CRUD, executions list, delete an execution, run now via create.
- Imports: upload a dump (multipart, through our route, streamed), start the import, poll its status.
- Where it surfaces: the tab, the native database console in the terminal, backups views, Operations, and
  alerts on backup failure.

**Deployments (5)**

- The global queue, per-app history with paging, detail with live build log, cancel, deploy by uuid or tag
  (with force, PR and docker tag options).
- Where it surfaces: the tab's Deployments section, Overview, the dashboard card, events and Automations.

**Projects (10) and environments**

- CRUD for projects and environments. An environment detail lists its resources.
- Where it surfaces: the tab's Projects section (a tree), create pickers and palette scoping.

**Shared environment variables (16)**

- Team, project, environment and server shared variables: CRUD with masked values.
- Each value shows where it's referenced (`{{team.X}}`, `{{project.X}}` and so on) by scanning resource env
  keys. Values are only fetched when the user reveals them.
- Where it surfaces: the tab's Variables section, and links from each env editor.

**Servers (36)**

- List, detail, create (manual), PATCH and delete (typed confirm; refused while linked hosts exist unless
  unlinked first).
- Validate, host-key reset, resources and domains.
- Proxy: get, PATCH, configuration editor (`PUT`) and restart.
- Sentinel config. Docker cleanup: config, run and executions. Registries: list, add, check and delete.
- Image scanning config. Log drains config, with drain secrets masked.
- Cloudflare tunnel: get, PATCH, enable and disable.
- Transfer and migrate between instances: `GET transfer`, `import/check`, `import` and `transfer/complete`.
  This appears in the UI only when the connection is a root token, with a guided flow between two
  connections.
- Where it surfaces: the tab's Servers section, the host section and companion on the linked host,
  Operations host actions, and alerts.

**Destinations (6)**

- Docker networks per server: CRUD.
- Where it surfaces: the Servers detail, and create pickers.

**Cloud provisioning: Hetzner (7), DigitalOcean (5), Vultr (5), Hostinger (6), cloud tokens (6) and
cloud-init scripts (5)**

- Cloud tokens: CRUD and validate.
- Cloud-init scripts: CRUD.
- "New server in the cloud" wizard: provider, then the provider's regions, sizes, images, SSH keys,
  firewalls, networks and templates. Then create, which calls `POST /servers/<provider>` and then runs
  host sync, so the new server shows up as a Termix host when ready.
- Where it surfaces: the tab's Cloud section, the palette and Operations (`coolify.provision-server`, a
  destructive-cost action that needs a confirm).

**Private keys (5)**

- CRUD. Shows the fingerprint and which servers use each key.
- "Generate in Termix": makes a key pair with `@termix-ssh/plugin-sdk/ssh-keys`, saves it to Coolify
  and as a Termix credential.
- Where it surfaces: the tab's Keys section, and the reverse onboarding flow.

**GitHub Apps (6), GitLab Apps (4) and Gitea Apps (1)**

- List, create, PATCH and delete (GitHub and GitLab). Repositories and branches browse, used by the app
  wizard.
- Where it surfaces: the tab's Sources section, and the create wizard.

**S3 storages (6)**

- CRUD and validate, used as backup targets.
- Where it surfaces: the tab's Storage section, and backup forms.

**DNS (9) and integration tokens (6)**

- Zones list. Per-app and per-service DNS records: create, replace, delete.
- Integration tokens: CRUD and sync-zones.
- Where it surfaces: the Domains panel on resource detail, and the tab's DNS section.

**Secret managers (7)**

- Per resource: get, set or delete the source, list keys, add references, import.
- Where it surfaces: the Secrets panel in resource detail.

**Scheduled tasks (12)**

- Apps and services: CRUD, executions and run now.
- Where it surfaces: resource detail, Operations actions and alerts.

**Vulnerabilities (4)**

- Instance-wide and per resource: severity counts and CVE lists.
- Where it surfaces: the tab's Security section, resource detail, a dashboard card and Operations signals.

**Tags (4)**

- CRUD. Tagging lives on each resource. Deploy by tag.
- Where it surfaces: the tab's Tags section, filters and Automations inputs.

**Notifications (12)**

- Email, Discord, Slack, Telegram, Pushover and webhook: get and PATCH, with secrets masked.
- The webhook card has a one-click "Send Coolify events to Termix" that fills our webhook URL and ticks the
  events.
- Where it surfaces: the tab's Notifications section, and connection setup.

**Teams (6)**

- Current team and members (read only). `PATCH /team` (name and description).
- Other teams the token sees (read only).
- Where it surfaces: the tab's Team section, and the connection header.

**Settings (2)**

- Instance email settings: get and PATCH (root token).
- Where it surfaces: the tab's Instance section.

**Audit events (1)**

- Paged and filterable list.
- Where it surfaces: the tab's Security section, and the Activity tab on resources.

**Resources (1)**

- Not used for the UI. It's too heavy. We use per-type lists instead.

**Instance (`/version`, `/health`, `/mcp/enable|disable`, `/disable`)**

- Version and health are shown in the connection header.
- MCP is shown as a status. The enable and disable buttons sit behind a confirm.
- `/disable` is never offered.

**The coverage contract:** `docs/coverage.md` lists every operation id from the vendored spec with its
status: used, plus where, or skipped, plus why. A test fails when a spec operation is missing from that
file. That's how "use as much as possible" stays true over time, including when the spec is bumped.

## Termix surface matrix

Each surface is listed with what the plugin puts there.

**Hosts** (`hosts:read`, `hosts:write`, `hosts:lock`)

- Linked hosts with tunnels and keys preset, in a "Coolify" folder (`folders.ensure`, with a color and icon).
- Tags `coolify` and the connection.
- Locked while managed.
- Removal is detected through the `host.deleted` event.

**`hosts.importMenu` slot**

- "Import from Coolify" opens the sync flow.

**Host section** (`registerHostSection`, `contributes.hostSections`)

- On linked hosts: server status, the resource list with status dots and quick actions, proxy status and
  Coolify links.

**Host badge, dot and context menu**

- A "Coolify" badge.
- The dot warns or alarms when the server is unreachable or a resource is degraded.
- Menu items: Resources, Sync, Unlink, Open in Coolify.
- On _unlinked_ hosts the menu offers **Add to Coolify** (see Reverse onboarding).

**Companion panel** (`registerCompanion`, `tabTypes: ["terminal"]`)

- Beside any terminal on a linked host, a Coolify panel shows that server's resources with Shell, Logs,
  Restart and Deploy.
- Clicking Shell in the companion opens a container shell in a new tab.

**Host action** (`registerHostAction`)

- "Coolify" opens the tab, filtered to that server.

**Tabs**

- `coolify` is the main, singleton client.
- `coolify-shell` is a host tab that embeds `terminal.view` with `executeCommand`.
- `coolify-logs` is a host tab that follows logs live.

**Panels** (`registerPanel`)

- A slim sidebar panel with deployments in progress and attention items.

**Rail item**

- Opens the `coolify` tab. A rail badge shows the count of running deployments and failures.

**Palette** (`registerPaletteGroup` and entries)

- "Coolify: Deploy…", "Open shell in…", "Logs of…", "Restart…", "Database console…", "New app…",
  "Sync servers", "Go to project…".
- Each opens a resource picker, ranked by recent use.

**Keybindings** (`registerKeybindingAction`)

- Unbound actions for deploy-current, shell-current and open-Coolify. "Current" means the resource of the
  focused `coolify-shell` or `coolify-logs` tab.

**Dashboard cards** (`contributes.dashboardCards`, using entries)

- Connection overview, a single resource (status plus Deploy), deployments in progress, and vulnerabilities.

**Homepage widgets** (`registerExtension("homepage.widgets")`, through `uses`)

- The same cards as homepage widgets.

**Data slots**

- `dashboard.hostRow`: resource counts on the linked host.
- `dashboard.hostRowBadge`: a deploying badge.
- `terminal.toolbarStatus`: the container name and status in a `coolify-shell` tab.
- `homepage.hostMetrics`: container CPU and memory summary.

**Operations** (`operations:provide`)

- Resource `coolify.resource`: rows are a linked host's apps, services and databases.
- Resource actions:
  - deploy (with force and wait), start, restart, stop (destructive)
  - logs-tail (read, sensitive output)
  - run-scheduled-task, backup-now, rollback (with image input from an `optionsFrom` read)
- Host actions: sync-host, restart-proxy, docker-cleanup, validate-server.
- Server-scope actions (no host):
  - deploy-by-tag, list-deployments, cancel-deployment
  - create-app, create-database, create-service, provision-server
  - connection health
- Signals:
  - degraded resources per host
  - server reachability
  - deploying now (server scope)
  - vulnerabilities (critical count)
  - backup failures in the last 24 hours
- Events: deployment finished and failed, container restarted, restart limit, server unreachable and
  reachable, backup failed, task failed, high disk usage, certificate renewal.
- `check` and `undo` where Coolify allows it: start undoes stop, rollback undoes deploy.
- `idempotent` on start, stop and restart.
- Assistant and MCP surfaces:
  - On: every read action, plus deploy and restart.
  - Off: stop, delete, create, provision, env and key changes.

**Services provided** (`provides`)

- `coolify.client` v1, for other plugins: `listConnections()`, `listResources(connId)`,
  `deploy(connId, uuid, opts)` and `resolveContainer(hostId, uuid)`.
- Callers act as their user and get only that user's connections. Declared with permission `coolify.view`.

**Services used** (`requires`/optional)

- `docker.containers` and `docker.events` when the Docker plugin runs. They power container state and
  refresh in the host section without extra polling.

**Events** (`events:core`)

- `host.deleted` unlinks the server. `host.updated` re-checks the lock.

**Alerts** (`notify:send`)

- Events go to the connection owner, and to grantees by permission. Category is `coolify.<kind>`, with
  dedupe and links.

**Onboarding step** (`registerOnboardingStep`, section `setup`)

- "Connect Coolify" with the add-connection form inline.

**Settings**

- Admin: polling, interval floor, key copying, sharing.
- Host (hidden): `coolifyConnectionId` and `coolifyServerUuid`.
- Custom setting component: the connection picker.

**Mobile** (`contributes.mobile`, webview)

- Views: `coolify`, `coolify-shell` and `coolify-logs`. Phone layouts through `useIsMobile()`.

**Docs** (`DocsLink`, `docs/`)

- Pages: setup, tunnels, permissions, coverage, troubleshooting.

**Activity** (`ctx.hosts.recordActivity`)

- "Opened shell in <app>" and "Deployed <app>" show in Termix's recent activity.

**Audit** (`ctx.audit.record`)

- Key copies, host sync, destructive Coolify calls and connection sharing changes.

Not used, deliberately:

- Layouts, themes, auth, protocols, second factors and sync provider: they don't fit.
- `hosts:status-provide`: core's reachability is right for SSH. Coolify's view of reachability is shown as
  a badge instead.
- `users:impersonate`, `network:sockets`, `process:spawn`, `ssh:transport`, `credentials:read` and
  `hosts:export`.

## Design

### Concepts

- **Connection:** one Coolify instance.
  - Created and owned by one Termix user.
  - Holds a name, base URL, API token, optional Cloudflare Access service token for a dashboard behind
    Access, optional "on my local network" (`allowPrivateHosts`), an optional CA certificate, a sync
    policy, alert preferences and a webhook secret.
  - Tokens are sealed in our own table (`ctx.secrets.seal`), so background polling can use them with no
    actor.
- **Grant:** the owner may share a connection with Termix users or roles at a level:
  - `view`: read everything except secret reveals.
  - `operate`: view plus start, stop, restart, deploy, cancel, run tasks and backups, and shells. Shells
    still need Termix host `connect` access.
  - `configure`: operate plus edits, envs and creates.
  - Grantees never see the token. Every call is made with the owner's token, so a grant is the owner
    lending their Coolify rights through Termix's permission checks. The UI says so when granting.
  - Linked hosts can be shared to the same people with `ctx.hosts.share` in the same step.
- **Linked server:** a Coolify server mapped to a Termix host this plugin created and manages.
- **Resource:** an application, service, service part (app or database) or standalone database.

### Permissions (Termix)

| Permission           | Allows                                                                                                             | Default roles |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------- |
| `coolify.view`       | Open the plugin, read connections you own or were granted                                                          | admin, user   |
| `coolify.operate`    | Lifecycle actions, deploys, tasks, backups, shells, logs                                                           | admin, user   |
| `coolify.configure`  | Edits, envs, creates, imports, keys, sources, storage, DNS, notifications                                          | admin, user   |
| `coolify.administer` | Deletes, server create, delete and transfer, cloud provisioning, instance settings, MCP toggle, connection sharing | admin, user   |

The effective right on a connection is the minimum of three things: the Termix permission, the grant
level (or owner), and the Coolify token's ability, which is checked by Coolify itself and translated when it
says no. Admins can tighten the defaults per role in Termix.

### Capabilities

| Capability                       | Risk         | Why                                                                       |
| -------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `db:own`                         | low          | Connections, grants, servers, cache, events, recent items                 |
| `secrets:own`                    | low          | Seal and unseal tokens                                                    |
| `kv:own`                         | low          | Small cursors (last poll times)                                           |
| `network:serve`                  | medium       | Routes, the public webhook route, log and stats sockets                   |
| `network:outbound`               | medium       | Coolify API through `ctx.fetch`                                           |
| `ui:surface`                     | low          | Tabs, panels, cards, settings, host sections                              |
| `hosts:read`                     | low          | Linked hosts, access checks, activity                                     |
| `hosts:write`                    | medium       | Create, update and delete linked hosts and the folder, share hosts        |
| `hosts:lock`                     | medium       | Managed hosts are read only                                               |
| `credentials:write`              | medium       | SSH key credentials copied from Coolify or generated                      |
| `credentials:use`, `ssh:connect` | medium, high | Container lookup, SSH logs fallback, live logs, stats, reverse onboarding |
| `operations:provide`             | medium       | Actions, resources, signals, events                                       |
| `notify:send`                    | medium       | Alerts                                                                    |
| `events:core`                    | medium       | `host.deleted`, `host.updated`                                            |
| `plugins:read`                   | low          | Detect SSH Terminal and Docker so features degrade cleanly                |
| `users:read`                     | medium       | Show grantee names, send alerts in the grantee's language                 |

`ssh:connect` is the only high-risk capability, and it's required for anything container-level, because
Coolify has no exec API.

`contributes.uses`:

- `terminal.view`, `terminal.open` and `homepage.widgets`
- the Docker plugin's operations, read-only use through services

Optional dependencies: `ssh-terminal`, `docker`, `homepage`.

### Connection setup and ability probe

The Add connection form has name, URL and API token, plus an Advanced group: CF Access id and secret, "on
my local network", and a CA certificate. On save, the probe runs:

1. Health and version (record the version).
2. `GET /team` (record the team).
3. Non-mutating ability checks:
   - Is it scoped? Try `GET /servers`.
   - Keys readable? Try `GET /security/keys/{first}` and discard `private_key` immediately.
   - Logs readable? Try one resource's logs with `lines=1`.
   - Is it root? Try `GET /settings/email`.
   - Write, deploy and delete can't be probed without side effects. They're marked "checked on first use",
     and a 403 is translated to "this token lacks the X ability".
4. Store the ability summary. The UI hides or disables sections the token can't use, with the reason.

Each step's failure maps to a cause and a fix:

- An unreachable instance offers "on my local network" if the URL is private.
- A redirect to `*.cloudflareaccess.com` means "behind Cloudflare Access: add a service token".
- 403 "API is disabled" means "turn on API access in Coolify, Settings, Advanced".

### Host sync

**Sync servers** comes from setup, the Servers section, the import menu or the palette. It shows each
Coolify server and the Termix host it would become:

- Name, folder ("Coolify", or "Coolify / <connection>" when there are several), tags, and notes linking
  back to Coolify.
- **Plain server:** `ip`, `port` and `user` from Coolify.
- **Tunnelled server:**
  - `ip` is the tunnel hostname, with Coolify's `port` and `user`.
  - `pluginSettings["ssh-terminal"]` is `{ cloudflareTunnelEnabled: true, cloudflareTunnelHostname: ip,
cloudflareTunnelPort: 443 }`, plus the service token if one is set.
  - If SSH Terminal isn't running, the row is blocked: "Needs the SSH Terminal plugin for Cloudflare
    tunnels".
- **The Coolify host** (`is_coolify_host`, or `ip` of `host.docker.internal`, `localhost` or `127.*`):
  prefill the connection URL's hostname, require confirmation, and keep it as an address override. Any
  server can have an override, and overrides survive syncs.
- **Auth:**
  - Mode A: one credential per Coolify key, named `Coolify: <connection> / <key>`. It's reused, and
    replaced only when the fingerprint changes.
  - Mode B: the picked credential.
- **Other settings:** `statusCheckEnabled: true`, `pluginEnable: { docker: true }` when Docker runs, and our
  hidden host settings.

After the person confirms, hosts are created or updated in place (keeping the id, pins, shares and
history), then locked.

- Servers gone from Coolify are flagged with **Remove host** or **Keep as normal host**, which unlinks and
  unlocks.
- Re-sync is manual, or "keep in sync when I open Coolify" (on open, at most every 10 minutes). Host writes
  always happen inside the user's own request, so no impersonation is needed.
- Host keys: the first connection needs trusting in a terminal. When Coolify reports
  `ssh_host_key_fingerprints`, the UI shows the expected fingerprint next to the prompt.
- `server_ssh_host_key_changed` webhook events become an alert that says to compare fingerprints.

### Reverse onboarding: add a Termix host to Coolify

From an unlinked host's context menu or the Servers section ("Add a Termix host"):

1. Pick the host and connection. Check `edit` access to the host.
2. Choose a key:
   - Generate a new ed25519 pair (`ssh-keys`).
   - Or pick an existing Coolify private key, which needs its public key; the API returns `public_key`.
3. Over `ctx.ssh.exec`, append the public key to the SSH user's `~/.ssh/authorized_keys`, idempotently and
   with correct permissions. The key is sent on stdin, never in argv.
4. `POST /security/keys` with the generated private key, which is held in memory only.
5. `POST /servers` with name, ip, port, user, private key uuid and `instant_validate: true`.
6. Poll `GET /servers/{uuid}` until `is_reachable` and `is_usable`, or show the validation logs.
7. Link: the existing Termix host becomes a linked host. It isn't recreated, and it isn't locked unless the
   user opts in. Store the credential as mode A.
8. Offer "Behind a Cloudflare tunnel?". If the host already uses SSH Terminal's tunnel settings, call
   Coolify's `cloudflare-tunnel` endpoints so Coolify knows. Coolify's managed tunnel creation needs a
   Cloudflare integration token on the Coolify side, which is linked from the DNS section.

### The Coolify tab

`PanelShell`, with a connection switcher, `RefreshButton`, docs link and the version and team in the
header. A `SideNav` holds these sections:

**Overview**

- Tiles: running, degraded, stopped, deploying, critical CVEs, failed backups (24 hours).
- An attention list, deployments in progress, and recent events.

**Projects**

- A tree of project, then environment, then resources. CRUD for projects and environments.
- "New resource" here opens the create wizard prefilled.

**Resources**

- A flat searchable table: type, status, server, project, environment, tags, domains, last deploy.
- Filters, and bulk actions (restart or deploy selected, with a confirm listing them).

**Resource detail** (`InlineView`)

- Header: status, Deploy, Force rebuild, Restart, Start or Stop, more (Clone, Move, Migrate, Delete), and
  Open in Coolify.
- Tabs:
  - Overview
  - Shell: container and part picker, Server shell, Database console
  - Logs: snapshot, follow, search, download
  - Deployments: history, live build log, cancel, rollback
  - Previews: apps only
  - Environment: masked, reveal, edit, bulk `.env` paste, build-time and preview flags
  - Storage: volumes and files, CRUD, volume backups
  - Backups: databases
  - Scheduled tasks
  - Domains and DNS
  - Secrets manager
  - Tags
  - Security: CVEs
  - Stats: live container CPU, memory and network over SSH
  - Activity: audit events for this resource
  - Settings: the editable fields per type, PATCH with a diff preview

**Deployments**

- Queue and history across the connection, a live build log, and cancel.

**Servers**

- Coolify servers with their linked host, tunnel badge, reachability, proxy and Docker version.
- Detail tabs:
  - Overview
  - Proxy: config editor, restart
  - Destinations
  - Registries
  - Docker cleanup: config, run, history
  - Sentinel, image scanning and log drains
  - Cloudflare tunnel
  - Shared variables
  - Resources and domains
  - Transfer
- Actions: Sync, Add a Termix host, Validate, Reset host key, Delete.

**Cloud**

- Cloud tokens, cloud-init scripts, and the New cloud server wizard.

**Keys**

- Private keys with usage, CRUD, and generate.

**Sources**

- GitHub, GitLab and Gitea apps.

**Storage**

- S3 storages.

**DNS**

- Zones and integration tokens.

**Variables**

- Shared variables for team, project, environment and server.

**Tags**

**Notifications**

- Coolify's channels, plus "Send Coolify events to Termix".

**Security**

- The vulnerabilities overview and audit events.

**Team**

- The team and its members.

**Instance**

- Version, health, email settings and MCP status.

**Connections**

- Connections you own or were granted: add, edit, re-probe, sharing, sync policy, alert kinds and webhook
  setup.

**Create wizards** (in `InlineView`, `FormFooter` pinned):

- **Application:** source type, then repo, branch and build pack (browsing repositories and branches
  through the git-app endpoints), then destination, domains, ports and envs, then create, and optionally
  deploy now.
- **Database:** engine, then version, image and credentials (prefilled secure random), public port, then
  create, and optionally start.
- **Service:** template search, then config, then create, and optionally start.
- **Cloud server:** described above.

Every form validates on the client and the server. The server is the only source of truth, and
Coolify's 422 field errors map back onto fields.

### Container shells and consoles

1. `POST …/resources/:uuid/shell { part?, console?: "shell" | "db" }`. The backend:
   1. Finds the linked host for the resource's server (if none, "Link this server first").
   2. Checks host `connect` access.
   3. Resolves the container with `docker ps --filter label=coolify.<type>Uuid=<uuid>`, plus the pre-v4.4 and
      service-part fallbacks.
   4. Checks it is running.
   5. Picks `bash` or `sh`, and `sudo` when the SSH user isn't root or in the docker group.
   6. Uses `docker attach` mode when the container has `OpenStdin` and the user picks attach.
2. For `db`, it builds the native client for the engine: `psql`, `mysql`/`mariadb`, `mongosh`, `redis-cli`,
   `keydb-cli`, `clickhouse-client` or `sqlite3`.
   - Passwords go through `docker exec -e` from a short script sent on stdin to `sh -s`. They are never
     in argv or the frontend.
   - This needs `read:sensitive`. Without it, fall back to a plain shell with a note.
3. The response is `{ hostId, title, command }`, with everything built through `shellQuote`. Names are
   accepted only if they match `[A-Za-z0-9_.-]+`.
4. The frontend opens the `coolify-shell` tab, which renders `PluginComponent id="terminal.view"` with
   `hostConfig` and `executeCommand`.
   - Without SSH Terminal it shows a `NoticePanel` and offers logs, plus a copyable command.
   - `HOST_KEY_UNVERIFIED` becomes "Open a server terminal once to trust this host's key", with a button
     (`terminal.open`) and the Coolify fingerprint.

### Logs, stats and build logs

- **Snapshot:** Coolify `/logs` when the token allows it, else `docker logs --tail N --timestamps` over SSH.
- **Follow:** a socket `/plugin-ws/coolify/logs?…` streams `docker logs -f` over `ctx.ssh.connect`.
  - It checks `conn.isDataUnlocked()` per message, caps the rate and closes on hide.
  - The client keeps a ring buffer.
- **Stats:** a socket `/plugin-ws/coolify/stats` runs `docker stats --no-stream --format json` every 3 seconds
  while visible. The host-scripts helpers are used where they fit.
- **Build logs:** our route polls `GET /deployments/{uuid}` every 2 seconds while the view is open. It parses
  Coolify's JSON log lines and hides `hidden` lines by default.

### Alerts and live events

Both sources feed one pipeline, deduped by `deployment_uuid` or `(event, resource, minute)`.

1. **Webhook** (instant):
   - `POST /plugin-api/coolify/webhook/:token` with a 32-byte random token, stored as a sha256 hash and
     constant-time compared.
   - Body limit 64 KB, strict shape. It answers 200 fast and never echoes input.
   - Setup can write it into Coolify (Notifications, webhook) with one click.
   - The UI warns that Coolify refuses private addresses.
2. **Polling** (fallback; on by default until a webhook arrives, then optional):
   - Schedule `coolify-poll` every 60 seconds or more, with jitter.
   - It unseals tokens with the install key and only reads Coolify: deployments, statuses, plus backups and
     tasks every 5 minutes. Diffs become events.
   - `ctx.schedule.keepAwake` keeps it up only while something polls.
   - Backoff after failures is 1, 2, 5 and then 15 minutes, with the last error shown on the connection.
3. **Event output:**
   - Alerts go to the owner and to grantees with `coolify.view`, filtered by the kinds each person
     picked.
   - The event goes to `ctx.operations.emit`, with `hostId` when linked.
   - It's added to the event log, pruned to 1000 per connection.
   - Default alert kinds: deploy failed, restart limit, server unreachable, backup failed, task failed, high
     disk, certificate problems, API token expiring.

### Data model (`p_coolify_*`)

- **`connections`:**
  - `id`, `userId` (refUser), `name`, `baseUrl`, `tokenSealed`, `cfAccessIdSealed`, `cfAccessSecretSealed`
  - `allowPrivate`, `caCert`, `webhookTokenHash` (varchar 64, indexed)
  - `pollEnabled`, `autoSync`, `alertKinds` (json)
  - `abilities` (json), `coolifyVersion`, `teamName`
  - `lastError`, `lastCheckedAt`, `createdAt`
- **`grants`:** `id`, `connectionId`, `targetType` (user or role), `targetId`, `level`, `createdAt`. Unique on
  (`connectionId`, `targetType`, `targetId`).
- **`servers`:**
  - `id`, `connectionId`, `serverUuid` (unique with `connectionId`), `hostId` (refHost, nullable)
  - `addressOverride`, `credentialMode`, `credentialId`, `keyFingerprint`, `lastSyncedAt`
- **`cache`:** `connectionId`, `kind`, `json` (stripped DTOs only), `fetchedAt`.
- **`events`:** `id`, `connectionId`, `kind`, `resourceUuid`, `deploymentUuid`, `hostId`, `title`, `detail`
  (json, no secrets), `createdAt`. Indexed on (`connectionId`, `createdAt`).
- **`recent`:** `userId` (refUser), `connectionId`, `resourceUuid`, `usedAt`, for palette ranking.

Everything goes through `ctx.db.persist()`, lazily for cache, events and recent.

### Backend modules

- **`coolify/client`:**
  - Generated types plus a request layer: `ctx.fetch`, Bearer token, CF-Access headers,
    `allowPrivateHosts`, CA, timeouts, no redirects.
  - Retry and backoff on 429 and 5xx for GETs only.
  - A per-connection token bucket under 200/min.
  - Error mapping to plain causes, and 422 field errors to a field map.
- **`coolify/dto`:** strippers from Coolify payloads to our DTOs. Raw payloads never leave the client.
- **`connections`:** CRUD, sealing, probe, grants, access resolution
  (`resolveAccess(connectionId, actor) → level | null`).
- **`sync`:** host sync, reverse onboarding, locks, unlink, `host.deleted` handling.
- **`containers`:** resolver, shell and console command builder, SSH logs, stats.
- **`events`:** webhook, poller, dedupe, notify and emit.
- **`operations`:** registration and handlers. Handlers reuse the same service functions as the routes.
- **`routes/*`:** one file per tab section. Each route has `@openapi` and an `authz.json` entry.
- **`service`:** the `coolify.client` service implementation.

### Errors and limits

- Routes validate and send 4xx. Coolify upstream failures become 502 with a plain message, never throws,
  because of Termix's five-errors-a-minute budget.
- Operation handlers throw, which is fine because operations don't count against the budget.
- Signals and resource lists read from the cache: 20 seconds for statuses, 5 minutes for vulnerabilities and
  backups.
- Bulk actions run serially with a progress list, never in parallel bursts.

### Security notes

- **Tokens:** sealed at rest, unsealed only in the client, and never logged or returned. Forms use
  `SecretField`, where an empty value keeps the stored one.
- **Private keys:**
  - In memory only, between fetch or generation and `createSshKey` or `POST /security/keys`.
  - Audited without material.
  - Reveal of a Coolify key in the Keys section is not offered. Use Coolify for that.
- **Env, notification and S3 secrets:** fetched only on an explicit reveal or edit, never cached, never put in
  operation outputs (`sensitive` outputs where shown).
- **Shell commands:** `shellQuote`, a name allow-pattern, and secrets via stdin.
- **Webhook:** token-in-path (hashed), size limit, strict parse. `authz.json` declares `access: public`.
- **Ownership and grants:** checked on every route through `resolveAccess`. Host access is checked before any
  SSH. Another user's connection answers 404.
- **Uploads** (database import): streamed through our route to Coolify's upload endpoint, with a size cap
  from admin settings and never stored on disk. Uses `bodyLimit` on that router only.
- **Typed confirmation:** required for deleting servers, databases, volumes and projects with resources.

### Settings

- **Admin:**
  - "Allow polling" (on), "Minimum poll interval" (60s), "Allow copying Coolify SSH keys" (on; off forces
    mode B).
  - "Allow sharing connections" (on), "Maximum import upload size" (512 MB).
  - "Allow cloud provisioning" (on).
- **Host (hidden):** `coolifyConnectionId` and `coolifyServerUuid`.
- Everything else is per connection.

### Milestones (each shippable, each passes the full Done checklist)

1. **1.0.0: Foundation.**
   - Template rename to `coolify`.
   - Vendored spec, generated client, DTO strippers and the coverage test with `docs/coverage.md`.
   - Connections and the probe.
   - Host sync (tunnels, keys A/B, folder, lock, unlink, overrides).
   - The tab: Overview, Resources, resource detail Overview, Shell, Settings (read).
   - Lifecycle actions and deploy.
   - Shells and database consoles.
   - Host section, badge, dot, menu, import menu, host action.
   - Operations resource, lifecycle actions and signals.
   - Palette, onboarding step.
2. **1.1.0: Observe.**
   - Logs snapshot and follow, Stats.
   - Deployments section with live build logs, cancel, rollback, previews.
   - Companion panel, sidebar panel, rail badge, `terminal.toolbarStatus`.
   - Recent activity.
3. **1.2.0: Alerts.**
   - Webhook and one-click Coolify setup, poller, event log.
   - Notify and operations events, alert preferences.
   - Dashboard cards, homepage widgets, `dashboard.hostRow` slots.
4. **1.3.0: Configure.**
   - Env vars (resource and shared), storages and volume backups, database backups and imports, scheduled
     tasks.
   - Domains and DNS, tags, secret managers, resource Settings edit.
   - Notifications section.
5. **1.4.0: Create.**
   - Projects and environments CRUD.
   - Create wizards for app, database and service.
   - Clone, move, migrate, delete.
   - Sources (git apps), S3 storages.
6. **1.5.0: Infrastructure.**
   - Servers section in full (proxy, destinations, registries, cleanup, sentinel, scanning, drains, tunnel,
     transfer).
   - Reverse onboarding.
   - Keys section and generate.
   - Cloud tokens, cloud-init and the cloud server wizard.
   - Integration tokens.
7. **1.6.0: Team and sharing.**
   - Connection grants with host sharing.
   - The `coolify.client` service.
   - Security section (vulnerabilities, audit), Team and Instance sections.
   - Assistant and MCP surfaces review.
   - Mobile polish.

Each milestone updates `docs/coverage.md`. By 1.6.0 every spec operation is either used or listed with a
reason.

### Identity (AGENTS.md first-time setup)

| Field         | Value                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `coolify` (not an official id, not in the registry)                                                                                                                   |
| `name`        | "Coolify"                                                                                                                                                             |
| `description` | "Coolify inside Termix: servers become hosts (tunnels included), one-click container shells, deploys, logs, variables, backups and alerts, and the full Coolify API." |
| `category`    | Infrastructure                                                                                                                                                        |
| `icon`        | `Rocket`                                                                                                                                                              |
| `repository`  | https://github.com/pacnpal/termix-coolify-plugin                                                                                                                      |
| `docs`        | the repo's `docs/`                                                                                                                                                    |
| `engine`      | `termix >=26.11.2-0`, `api ^2.7.0` (frames embedding other plugins' parts, needed for `terminal.view`)                                                                |

## Gaps (what neither API allows, and what we do instead)

- **Metrics history:** Coolify's REST API has no metrics data, only its MCP. We do live container stats over
  SSH while a view is open. History is out of scope; we link to Coolify's metrics page.
- **Pre-trusting host keys:** Termix has no plugin API for it. We show Coolify's fingerprint at the trust
  prompt.
- **Container exec without SSH:** Coolify has no exec API, so shells, consoles, live logs and stats need a
  linked host and `ssh:connect`.
- **Team creation and invites:** there's no API. The Team section is read-only apart from name and
  description.
- **Webhook to a LAN Termix:** Coolify refuses private targets. Polling covers it.

## Left to the builder

- DTO shapes, file layout, test layout (following the template), cache TTL tuning, log caps, icons and
  copy (all in `locales/en.json`).
- How to source the one-click service template list (API, or vendored with the spec).
- Whether the container shell appends `; exit` (prefer not: dropping back to the server shell is handy).
- Exact Operations input shapes, keeping inputs minimal and using `optionsFrom` for pickers.
- Verify response shapes against the owner's live instance with read-only calls during building. Never run
  writes, creates or deletes against the owner's production Coolify without asking first. Use a throwaway
  Coolify (Docker) for write-path testing.

## Risks

- **`terminal.view` is SSH Terminal's contract at 1.4.1** (`hostConfig`, `executeCommand`, `isVisible`). Pin it
  with a `renderWithApp({ others: { components } })` test. If it's missing, degrade to `terminal.open` plus
  a copyable command.
- **Coupling to SSH Terminal's host setting keys.** Keep them in one constant. Detect the plugin
  (`plugins:read`) at sync time.
- **Coolify version drift.** Vendor and pin the spec, feature-detect, and never hard fail on extra or
  missing fields. The coverage test flags new operations on a spec bump.
- **Grants lend the owner's Coolify token.** This is documented in the UI and docs and audited. Grantees
  never see the token, and the three-way minimum applies.
- **Size.** This is a large plugin. Milestones keep each release shippable, and the generated client keeps
  per-endpoint work small.
- **Rate limits.** Operations fan-out times hosts. Everything Termix polls on its own reads from the cache.
