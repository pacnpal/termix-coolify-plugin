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

- Re-implementing Coolify features that neither its API, its MCP nor Sentinel on the server exposes, such
  as the Traefik dashboard and the build-pack editor UI. Where Coolify's dashboard is the only way, link to
  that exact page.
- Replacing the Docker plugin. Hosts we create switch it on when it is installed.
- Our own Cloudflare tunnel code or running `cloudflared`. The SSH Terminal plugin already carries tunnels
  for every SSH connection in Termix.

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

**Coolify** (v4.7.5, the current stable release, which the owner's instance matches. Fields like
`is_coolify_host`, `settings.ssh_host_key_fingerprints` and `patch_check_result` are already in v4.7.5;
some are returned but missing from the OpenAPI schema. The nightly channel builds from the `next` branch
(`4.8.0-alpha`). Tolerate unknown and missing fields):

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
   - A build-time script (`scripts/gen-coolify-client.mjs`) turns the vendored specs into types and a thin
     request layer. The output is committed and regenerated when a spec is bumped.
   - Three specs are vendored under `vendor/coolify/`:
     - `openapi-v4.7.5.json`: the stable release, which is what the owner runs.
     - `openapi-main.json`: fixes heading for the next patch release.
     - `openapi-next.json`: the `next` branch the nightly builds from. Today it adds
       `POST /databases/influxdb`, the `use_production_values_in_previews` and `copy_value_to_preview`
       fields, and InfluxDB database fields.
   - The client is generated from the union of the three.
     - Each operation records its provenance (`source`: which spec first has it) separately from `minVersion`.
     - Operations in the v4.7.5 spec are treated as available from the supported floor, 4.4.0. On older
       instances their real availability is feature-detected: a 404 or 405 means "your Coolify doesn't have
       this yet".
     - Operations only in `main` or `next` get the first release that can carry them (4.7.6 or 4.8.0) and are
       hidden below it. The comparison uses only major.minor.patch and ignores prerelease tags, so a nightly
       or alpha of 4.8.0 already offers 4.8.0's operations. A nightly built before an endpoint landed answers
       404 or 405, which the same feature detection reports as "your Coolify doesn't have this yet".
     - `POST /disable` (turn the API off) is excluded outright: no route, no curated operation and neither
       generic operation can call it, even when its operation id is supplied directly.
   - Careful: an earlier research copy labelled "v4.7.5" was really `main`'s spec. Take each file from its
     named git ref.
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
- Database imports for service databases: start and status, with the same sources as standalone databases
  below.
- Where it surfaces: same as applications, with parts as child rows.

**Databases (44)**

- Create all nine engines: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse and
  SQLite.
- Detail and PATCH, including public port and image. Start, stop, restart, delete and clone.
- Move and migrate, envs, storages, tags and logs.
- Scheduled backups: CRUD, executions list, delete an execution, run now via create.
- Imports: start an import from a file already on the server (`source: server`) or from an S3 storage
  (`source: s3`), then poll its status. See "Database imports" for why there's no browser upload.
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
- **Grant:** the owner may share a connection with individual Termix users (picked with
  `ctx.hosts.listUsers`) at a level:
  - `view`: read everything except secret reveals.
  - `operate`: view plus start, stop, restart, deploy, cancel, and run tasks and backups. **It does not
    include shells.**
  - `configure`: operate plus edits, envs and creates.
  - Grantees never see the token. Every Coolify API call is made with the owner's token, so a grant is
    the owner lending their Coolify rights through Termix's permission checks. The UI says so when
    granting.
- **Server access is a separate, explicit grant, not a grant level.** Container shells, database consoles,
  live logs and stats run over SSH on the linked host. Whoever can SSH there can read every container's
  environment, whatever the Coolify token allows. So:
  - Shells and other SSH features need Termix host `connect` access on the linked host, and nothing else
    gives it.
  - Granting a connection never shares hosts. Host access is a separate checkbox per grantee, off by
    default: "Also give server access (full shell on <servers>: can read every container's secrets)". It
    calls `ctx.hosts.share` at `connect` level only after the owner ticks it, and is audited.
  - Removing the grant offers to revoke the host shares it made.
  - The three-way minimum (see Permissions) governs Coolify API actions. SSH features are governed by
    two things only: the Termix role permission `coolify.operate` and Termix host `connect` access on the linked host (see Permissions). The docs and grant UI say so plainly.
- **Linked server:** a Coolify server mapped to a Termix host this plugin created and manages.
- **Resource:** an application, service, service part (app or database) or standalone database.

### Permissions (Termix)

| Permission           | Allows                                                                                                             | Default roles |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------- |
| `coolify.view`       | Open the plugin, read connections you own or were granted                                                          | admin, user   |
| `coolify.operate`    | Lifecycle actions, deploys, tasks, backups, Coolify API logs; also the role switch for SSH features (see below)    | admin, user   |
| `coolify.configure`  | Edits, envs, creates, imports, keys, sources, storage, DNS, notifications                                          | admin, user   |
| `coolify.administer` | Deletes, server create, delete and transfer, cloud provisioning, instance settings, MCP toggle, connection sharing | admin, user   |
| `coolify.mcp`        | Use the plugin's MCP endpoint (calls still need the permission of each action)                                     | admin, user   |

There are two kinds of access, checked differently.

- **Coolify API actions** (everything that calls Coolify's REST API, including logs read through Coolify's
  `/logs` endpoints): the effective right is the minimum of three things. Those are the Termix
  permission, the grant level (or owner), and the Coolify token's ability, which Coolify checks itself
  and the plugin translates when it says no.
- **SSH features** (container shells, database consoles, logs read with `docker logs` over SSH, live log
  follow and stats): these need two things only. One is the Termix permission `coolify.operate`, the
  admin's per-role switch for these features. The other is Termix host `connect` access on the linked
  host. The connection grant level and the Coolify token's abilities don't apply, because SSH reaches the
  server directly. Host access is given only through the separate, explicit server-access grant
  described under Concepts.
- In the Logs view, the source is labelled ("from Coolify" or "from the server over SSH"), so it's clear
  which rule applied.

Admins can tighten the defaults per role in Termix.

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
| `users:read`                     | medium       | Send alerts in the grantee's language (`users.getLocale`)                 |
| `operations:invoke`              | high         | Run companion plugins' declared actions, listed one by one in `invokes`   |

`ssh:connect` and `operations:invoke` are the high-risk capabilities.

- `ssh:connect` is needed for anything container-level, because Coolify has no exec API.
- `operations:invoke` is needed only for the companion-plugin features that have no service. It lists
  exact action ids, never `*`.

`contributes.uses`:

- `terminal.view`, `terminal.open` and `homepage.widgets`
- `files.openHost`, `files.openEditor`
- `tunnels.openView` and the `tunnels.views` extension point
- `host-metrics.managers` (slot)
- `host-page.open` and `operations.hostMenu`
- `alerts.open`

Services used, all optional in `requires`:

- `docker.containers`, `docker.events`
- `files.sftp`, `tunnels.access`, `dns.records`, `reverse-proxy.endpoints`, `security-center.access`
- `uptime.access`, `automations.access`

Operations invoked (`contributes.operations.invokes`):

- `package-manager.list-updates`, `package-manager.upgrade-all`
- `log-search.search`
- `uptime.pause`, `uptime.resume`
- `backups.failed`

Optional dependencies (each feature switches on only when that plugin runs):

- `ssh-terminal`, `docker`, `homepage`, `file-manager`, `tunnels`, `dns`, `reverse-proxy`
- `security-center`, `uptime`, `log-search`, `package-manager`, `host-metrics`, `databases`, `backups`
- `automations`, `operations-center`, `alerts`

Pin each range to the version actually tested. The registry lags the plugin repos: for example,
file-manager is 1.0.3 in the registry and 1.2.2 at HEAD.

### Connection setup and ability probe

The Add connection form recommends creating the Coolify token with the abilities **read, read:sensitive,
write and deploy**. Everything works except deletes and instance settings, and a leaked token can't wipe
resources. The form explains how to add `delete`, or use `root`, for those. It has name, URL and API token, plus an Advanced group: CF Access id and secret, "on
my local network", and a CA certificate. On save, the probe runs:

1. Health and version (record the version). Both are allowed for every token. **Coolify older than 4.4.0
   is refused**, with "This plugin needs Coolify 4.4 or newer". The fallback for containers created before
   an upgrade stays.
2. **Scope first.** Try `GET /team`. A scoped token (limited to projects or resources) gets 403 here
   and on `/servers`, `/security/keys` and `/notifications`. So the probe treats a 403 from `/team` as
   "scoped", not as a failure, and confirms it with one allowed call (`GET /projects`).
3. **Team identity**, needed for `instanceKey` and webhook grouping:
   - Unscoped: the team id comes from `GET /team`.
   - Scoped: the team id comes from the `team_id` on a project returned by `GET /projects`. The builder
     confirms the field against the live API. If no team id can be found, `instanceKey` is left empty.
   - A connection with no `instanceKey` gets no webhook fan-out and alerts by polling only.
   - A scoped connection can never set up the team webhook itself (it can't reach `/notifications`). It
     receives webhook events only when an unscoped connection to the same team has set one up, and then
     only for resources its own token can see.
   - The setup screen says what a scoped token can't do: no servers, so no host sync, shells or keys;
     no notifications. It still offers everything that does work.
4. Non-mutating ability checks:
   - Keys readable? Try `GET /security/keys/{first}` and discard `private_key` immediately.
   - Logs readable? Try one resource's logs with `lines=1`.
   - Is it root? Try `GET /settings/email`.
   - Write, deploy and delete can't be probed without side effects. They're marked "checked on first use",
     and a 403 is translated to "this token lacks the X ability".
5. Store the ability summary. The UI hides or disables sections the token can't use, with the reason.

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
  - **Cloudflare tunnels are carried by SSH Terminal's built-in tunnel**, which this plugin uses and
    recommends. It does not use a separate tunnel plugin. SSH Terminal **1.2.0 or newer** is required:
    1.0.3 tunnelled only its own terminal tab, and 1.2.0 made the tunnel carry every SSH connection, which
    file manager, Docker and this plugin need.
    - The plugin checks this with `plugins:read`.
    - SSH Terminal off: the row is blocked with "Turn on the SSH Terminal plugin to reach servers behind
      Cloudflare tunnels", and a button opens Termix's Plugins tab.
    - SSH Terminal older than 1.2.0: the row is blocked with "Update SSH Terminal to 1.2.0 or newer; older
      versions tunnel only the terminal", and the same button.
    - Connection setup shows the same check once, as a line in its checklist, whenever the Coolify instance
      has tunnelled servers.
    - On a Linked host that is tunnelled, the host section says "Tunnel: through SSH Terminal (Cloudflare)".
      It offers "Open tunnel settings", which opens the host editor at SSH Terminal's section. The fields
      there stay read-only while the host is linked, because of the lock.
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

All questions come first. Nothing is changed on the host or in Coolify until the person confirms a summary
of every step.

1. Pick the host and connection. Check `edit` access to the host.
2. Ask "Is this host reached through a Cloudflare tunnel?" The plugin can't read SSH Terminal's tunnel
   settings on the host (a plugin only sees its own host settings), so the person answers. When the host's
   address looks like a tunnel hostname, prefill "yes".
3. Choose a key:
   - **Generate** a new ed25519 pair (`ssh-keys`).
   - Or **reuse an existing Coolify key**: use its uuid and `public_key` from the API. Nothing is posted to
     `/security/keys` in this branch. A Termix credential for mode A can only be made if the token can
     read the key material; otherwise fall back to mode B for this host's Termix side.
4. Confirm the summary. From here, every step records its progress (see "Partial onboarding" below).
5. Generate branch only: right after generating, the private key is sealed (`ctx.secrets.seal`) into the
   onboarding row, so a restart at any later step can't lose it. Then `POST /security/keys` uploads it to
   Coolify **before anything touches the host**. The Termix side honours the admin setting "Allow copying
   Coolify SSH keys": when it's on, a Termix credential is created from the generated key (mode A); when
   it's off, no Termix credential is made from it and the person picks an existing Termix credential in
   step 3's questions (mode B). The sealed
   copy is erased as soon as the run completes or is cleaned up. It's never logged or returned.
6. Over `ctx.ssh.exec`, append the public key to the SSH user's `~/.ssh/authorized_keys`, idempotently and
   with correct permissions.
   - The line carries a marker comment `coolify-termix:<onboarding id>`, so it can be found and removed
     later.
   - The key is sent on stdin, never in argv.
7. `POST /servers` with name, ip (the tunnel hostname when tunnelled), port, user, private key uuid and
   `instant_validate: false`.
8. If tunnelled, turn on Coolify's tunnel mode for the server (`PATCH /servers/{uuid}/cloudflare-tunnel` with
   `is_cloudflare_tunnel: true`, or `POST …/cloudflare-tunnel/enable` where that fits the setup).
   - This must happen before validation: plain SSH validation can't reach a tunnel-only host.
   - Warn that Coolify runs `cloudflared access ssh` without a service token, so the tunnel hostname must
     not sit behind a Cloudflare Access app that needs one.
   - Coolify's managed tunnel creation needs a Cloudflare integration token on the Coolify side, which is
     linked from the DNS section.
9. `POST /servers/{uuid}/validate`, then poll `GET /servers/{uuid}` until `is_reachable` and `is_usable`. On
   failure, show the validation logs, with the tunnel warning above when tunnelled.
10. Link: the existing Termix host becomes a linked host. It isn't recreated, and it isn't locked unless
    the user opts in. Store the credential as mode A where possible and allowed, otherwise mode B.

**Partial onboarding.** Each run is a row in `onboardings`: `id`, `userId`, `connectionId`, `hostId`,
`keyMode` (generated or existing), `step`, `generatedKeySealed` (erased at the end), `authorizedKeyMarker`,
`coolifyKeyUuid` (when we created it),
`serverUuid`, `lastError` and `updatedAt`. Each step records its effect before moving on.

- **Every create can be matched after an uncertain outcome.** A timeout or crash can leave something created
  whose id was never recorded, so each create is tagged with the run's marker `coolify-termix:<onboarding id>`
  and reconciled before it is retried:
  - Coolify key: the marker is in the key's `description`. Before a retry, `GET /security/keys` and match it.
  - Coolify server: the marker is in the server's `description`. Before a retry, `GET /servers` and match the
    marker, together with ip, port and user.
  - `authorized_keys` line: the append is already idempotent, by the marker comment.
  - Termix credential: matched by its name (`Coolify: <connection> / <key>`) and fingerprint.
  - A match is recorded in the row and reused. Only when no match exists is the create sent again, so resume
    and clean up both see what an interrupted step really made, and nothing is duplicated.

- **Failure or abandonment:** the host shows "Coolify onboarding unfinished" with two choices.
  - **Resume:** reuses whatever already exists (the same authorized key, Coolify key and server) and
    re-runs only the steps that haven't finished, usually tunnel setup and validation.
  - **Clean up:** undoes, in reverse order, only what this run created:
    - deletes the Coolify server, if it was created by this run and still has no resources
    - deletes the Coolify key, if it was generated by this run and no other server uses it
    - removes the `authorized_keys` line by its marker, but only when the server is gone (deleted above, or
      never created) or Coolify now uses a different key for it. A server kept because it has resources
      keeps the line and the key, so Coolify doesn't lose access to it.
    - Each undo is confirmed and audited. A step that fails to undo is reported, never silently skipped.
- **Starting again on a host with an unfinished run:** the person must resume or clean up first. A second
  set of keys and servers is never created silently.

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
   - **No password ever leaves the server.** The command is returned to the browser and run by
     `terminal.view`, so it must hold no secret. Coolify already sets each database container's
     credentials in its own environment (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
     `MYSQL_ROOT_PASSWORD`, `MARIADB_ROOT_PASSWORD`, `MONGO_INITDB_ROOT_USERNAME`,
     `MONGO_INITDB_ROOT_PASSWORD`, `REDIS_PASSWORD` and so on). So the console runs inside the container
     and reads them there.
     - For example: `docker exec -it <c> sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U
"$POSTGRES_USER" "$POSTGRES_DB"'`.
     - The `$` references expand inside the container, never in Termix or the browser.
     - The variable names per engine are a per-engine table. The builder confirms them against Coolify's
       `StartPostgresql`, `StartMysql` and the other start actions, and against the owner's live containers
       (`docker inspect` over SSH, names only).
   - This needs no `read:sensitive` and no secret handoff.
   - When an engine's container has no usable credential variable (for example custom images), fall back to
     a plain shell with a note. Never pass a password through the returned command.
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
   - Coolify allows one webhook per team, so there is **one webhook per Coolify team per Termix install**
     (`webhooks` table, keyed by `instanceKey`), not one per connection. An event fans out only to the
     connections with that `instanceKey` **whose token can see the event's subject**:
     - **Access is checked live, per event and per connection, with that connection's own token.**
       - Resource events (deploys, restarts, backups, tasks): `GET` the resource itself (for example
         `GET /applications/{uuid}`).
       - Server events: `GET /servers/{uuid}`.
       - Team-wide events (API token expiring, vulnerability digest, test): `GET /team`.
       - Only a 200 lets the event through.
       - The cached resource list is used only to skip connections that clearly can't see the subject. A
         cache hit never lets an event through on its own, so a token that lost access since the cache was
         filled gets nothing.
       - A subject missing from the cache skips a connection only while that cache is at most 60 seconds
         old. Older than that, the live `GET` decides, so a resource created since the last refresh still
         gets its events.
     - **Fail closed.** A 401, 403 or 404, a timeout or any other error drops the event for that connection.
       It's never stored or emitted there. A failed check is not retried for a webhook event, so a dropped event can be lost for that connection. Polling, when it's on, catches up only on deployment and resource status changes (plus backups and tasks every five minutes), not on every kind of webhook event.
     - These checks count against the per-connection request budget. Webhook events are infrequent, and an
       event is checked once per connection, not once per alert recipient.
     - Each remaining connection then applies its own alert preferences and grants.
     - Polled events are naturally scoped, because each connection polls with its own token.
   - Body limit 64 KB, strict shape. It answers 200 fast and never echoes input.
   - One-click setup reads the team's current webhook first.
     - Unset, or already ours: it writes it.
     - Set to something else: it shows the current URL and asks before replacing it, because Coolify can
       only send to one place. Declining leaves polling on.
   - The UI warns that Coolify refuses private addresses.
2. **Polling** (fallback; on by default until a webhook arrives, then optional):
   - Schedule `coolify-poll` every 60 seconds or more, with jitter.
   - It unseals tokens with the install key and only reads Coolify: deployments, statuses, plus backups and
     tasks every 5 minutes. Diffs become events.
   - `ctx.schedule.keepAwake` keeps it up only while something polls.
   - Backoff after failures is 1, 2, 5 and then 15 minutes, with the last error shown on the connection.
3. **Event output:**
   - Alerts go to the owner and to each granted user who has `coolify.view`, filtered by the kinds each
     person picked.
   - The event goes to `ctx.operations.emit`, with `hostId` when linked.
   - It's added to the event log, pruned to 1000 per connection.
   - Default alert kinds: deploy failed, restart limit, server unreachable, backup failed, task failed, high
     disk, certificate problems, API token expiring.

### Fully usable through Termix's API and Termix's MCP (1.0)

The owner's requirement: everything the plugin can do must also work without the browser, through Termix's
REST API (Termix API keys) and through Termix's MCP. Nothing may exist only as a button.

**What Termix offers today** (core f1c2964, verified in source):

- **Plugin routes:** `/plugin-api/<id>/…` accept Termix API keys, and the request runs as the key's user.
  - A key with no scopes reaches every route.
  - A `read` key reaches GETs.
  - `operations:read` and `operations:run` keys reach `/operations/…` and `/plugin-api/<id>/mcp`
    (`operations/key-scopes.ts`).
- **Termix's REST operations API:** `/operations/<actionId>/run` runs any declared action, with the gate,
  approvals, dry runs and history. Community plugins are included.
- **The Termix MCP server:** served by the official Operations Center plugin at
  `/plugin-api/operations-center/mcp`, built from `ctx.operations.list({ surface: "mcp" })`.
  - Core's catalog **always leaves community plugins out of the `mcp` and `assistant` surfaces**
    (`operations/catalog.ts:210-214`). There is no admin switch in this build, even though the guide mentions
    one.
  - So this plugin's actions appear there only once it is signed as official, or core adds that switch.
- **A plugin's own MCP endpoint:** core already treats `/plugin-api/<id>/mcp` as an MCP path for scoped API
  keys. A plugin may serve its own MCP endpoint there.

**Design:**

1. **Every capability is a declared operation.**
   - The curated actions (lifecycle, sync, shells, logs, metrics, updates, companions, status pages) each get
     an operation. Actions that give back text a person reads in the UI (logs, metrics, update lists,
     traffic) are `read` operations that return the same data.
   - That includes the plugin-only mutations that Coolify's REST API can't do, so `coolify.api-call` can't
     stand in for them: the update check (`coolify.server-updates-check`, over SSH or the package-manager
     plugin) and status-page rotation (`coolify.status-page-rotate`, in the plugin's own store).
   - Connection management is operations too: `coolify.connection-create`, `-update`, `-delete` and
     `-set-exec`. Tokens and service secrets use Termix's `secret` input type, so they reach the handler but
     are never stored in run history or shown, and are sealed at rest like the UI path.
   - Interactive-only pieces (the live terminal and live log follow) have their non-interactive equivalents
     as operations:
     - `coolify.exec`: run one command in a container and return its output.
       - It's destructive, needs `coolify.operate` plus host `edit`, takes a timeout, and its output is
         capped.
       - **It is off unless two switches are both on.** One is the admin setting "Allow running commands in
         containers through the API and MCP" (`allowExec`, default off). The other is the Connection owner's
         per-Connection opt-in (`execEnabled`, default off).
     - `coolify.logs-tail`: read.
     - `coolify.shell-command`: read. It returns the `docker exec` line, so a client with its own SSH can
       open the shell.
   - The full Coolify REST API is reachable through two generic operations:
     - `coolify.api-read`: GET only, read.
     - `coolify.api-call`: any operation, destructive, with a confirm. Its `params` and `body` use Termix's
       `secret` input type, so request bodies carrying keys, env values or storage credentials never enter run
       history. The run records the method, operation and path, plus the redacted request.
     - Both take `connectionId`, `operationId` (with `optionsFrom` reads listing the vendored operations,
       hiding ones newer than the connection's version, the excluded `POST /disable` and ones above the
       actor's level), `params` and `body`.
     - **The wrapper's own permission is not enough.** Each `operationId` resolves to the Termix permission
       and grant level that the Permissions table gives the same action, kept as two separate values:
       - reads need `coolify.view`, except Coolify's log endpoints, which need `coolify.operate`;
       - lifecycle, deploys, tasks and backups need `coolify.operate`;
       - deletes, server create, transfer and migrate, cloud provisioning and instance settings need
         `coolify.administer` (with a configure grant, or ownership);
       - everything else needs `coolify.configure`.
     - The three-way minimum (see Permissions) is applied to that, in both the call and the operation
       pickers. So a view grant can't reach a write, and a configure user can't delete, through
       `coolify.api-call`.
     - Both return redacted output (see Redaction).
   - A test fails when any plugin route has no operation that does the same thing. The exceptions are the
     public status route and the sockets, whose equivalents are named in the test.
2. **Termix REST API:**
   - Every `/plugin-api/coolify/…` route has an `@openapi` block, so it appears in Termix's API docs, and
     works with an unscoped API key as the key's user.
   - Every operation runs through Termix's `/operations/coolify.<name>/run` with an `operations:run` key.
     Reads also work with `operations:read`.
   - `docs/api.md` lists each capability with its route, its operation id, the key scope it needs and a
     `curl` example.
3. **Termix MCP, through our own endpoint** `POST /plugin-api/coolify/mcp`:
   - **Transport:** stateless JSON-RPC over HTTP, with methods `initialize`, `ping`, `tools/list` and
     `tools/call`. The same shape as Operations Center's server, so the same MCP clients work.
   - **Auth:** a Termix session or a Termix API key with `operations:read` or `operations:run` (core
     enforces this). New permission `coolify.mcp` (default roles admin and user) gates the route.
   - **Tools:** one per declared coolify operation (name `coolify__<action>`), plus `list_connections`,
     `list_hosts` (linked hosts only) and `list_resources`.
     - The input schema comes from the operation's inputs, plus `hostId`/`resourceKey` by scope.
     - Annotations come from the risk: `readOnlyHint` for read, `destructiveHint` for destructive.
   - **Calls** go through `ctx.operations.run` with `via: "mcp"`. The gate, approvals, risk rules, dry runs,
     history and audit all apply exactly as in the UI.
     - A key with only `operations:read` can call only `read` tools.
     - **Changes over MCP:** read tools, deploy and restart always work, within the key's scope. Deploy and
       restart work through both their resource-scope actions (`coolify.deploy`, `coolify.restart`) and
       their server-scope ones (`coolify.resource-deploy`, `coolify.resource-restart`), so they also work
       for resources with no Linked host.
       Every other change or destructive tool answers "changes over MCP are turned off" unless the admin
       setting "Allow changes over MCP" (`allowMcpChanges`, default off) is on. This switch applies to the MCP
       endpoint only. REST API-key calls follow normal permissions, key scope and approvals.
     - An approval wait answers with the run id and "waiting for approval", like Operations Center.
   - **Output** is the operation's `summary` plus redacted `data`. Large data is cut at 8,000 characters with
     a note.
   - **`GET /plugin-api/coolify/mcp`** answers a short description and the client config snippet, so the
     Connections view can show "Use with an MCP client" with copy buttons.
4. **Also on the official surfaces:**
   - Every operation still sets `surfaces.mcp` and `surfaces.assistant` (read, deploy and restart on;
     destructive off), and `cli`, `automations` and `mobile` on.
   - So if the plugin is ever signed official, or core adds an admin switch, Termix's main MCP server and the
     AI assistant pick them up with no change.
5. **The `coolify.client` service** (moved into 1.0) gives other plugins the same capabilities as typed
   methods. Each method runs through `ctx.operations.run` too.

**Redaction:** every generic output passes through one redactor. That covers operation data, MCP tool
results and API console results.

- It masks keys matching
  `/(token|secret|password|passwd|private_key|api_key|apikey|webhook_secret|value|real_value|license|key_pem|client_secret|dsn)$/i`.
  It also masks values inside `docker_compose_raw`, `custom_labels`, `dockerfile` and `logdrain_*_config`.
- Operation and MCP outputs are always redacted, and have no reveal.
- The in-app API console (a section of the Coolify tab, generated forms for every operation, so the full
  Coolify API is also usable by hand) can reveal one value. That needs `coolify.configure` and a
  sensitive-capable token. The reveal is audited and never cached.

**Coverage contract, extended:** `docs/coverage.md` gets two more tables.

- Every plugin route, with its operation and MCP tool name.
- Every operation, with its MCP tool and REST run path.

Tests fail when a route lacks an operation, or an operation lacks an MCP tool or a `docs/api.md` entry.

### Companion plugins

Termix ships about 75 official plugins. When one of the plugins below is installed, Coolify features show up
inside it, and its features show up here. Each integration checks `plugins:read` and the service or action at
runtime. If it's missing, that one feature hides and nothing else breaks.

**File Manager.** Use: yes.

- "Browse files" on a resource opens `files.openHost(host, path)` on the linked host:
  - `/data/coolify/applications/<uuid>` for applications.
  - `/data/coolify/services/<uuid>` for services.
  - `/data/coolify/databases/<uuid>` for databases.
  - Each volume's mount path from the resource's storages.
- "Edit compose file" uses `files.openEditor`.
- The backend reads small files, such as a generated `docker-compose.yml`, through `files.sftp.read`.
- SSH rules apply, because this is server access.

**Tunnels.** Use: partial.

- "Reach from here" on a database or private port calls `tunnels.access.forward(hostId, {targetHost:
<container IP>, targetPort})`.
- The forward listens on the Termix server (127.0.0.1), is not saved in the user's Tunnels list, and is named
  `web:<hostId>:coolify-<uuid>`.
- The Tunnels tab gets a "Coolify" view through the `tunnels.views` extension point. It lists the resources'
  internal ports with forward and stop.
- Forwards to the person's own computer aren't possible: desktop-side tunnels offer no service. The UI says
  so.

**Reverse Proxy.** Use: yes, when the admin has set the endpoint domain.

- "Open web UI" on a container with an HTTP port calls `reverse-proxy.endpoints.open({hostId, target:{host:
<container IP>, port, scheme}})`.
- It opens the one-time signed-in URL. No public domain or tunnel is needed.
- If `available()` is false, the button explains what the admin must set up.

**DNS.** Use: yes.

- On the resource's Domains panel, "Create DNS record" uses `dns.records.findZone(fqdn)` and
  `setRecord({name, type: A or CNAME, content: <server public IP or tunnel target>})`.
- The person picks: Coolify's own DNS integration, or the Termix DNS plugin.
- Records made here are remembered, so they can be removed with the resource.

**Uptime.** Use: partial.

- Show each app's monitor status, matched by URL from `uptime.access.summary()`.
- Deploy actions pause the app's monitors and resume them after, through operations
  `uptime.pause`/`uptime.resume`. This is opt-in per connection.
- Uptime has no API to create HTTP monitors. The UI offers "Create monitor in Uptime", which opens the Uptime
  tab, and says why it can't be done in one click.

**Log Search.** Use: partial.

- "Search logs across servers" runs `log-search.search` with `source: "docker"` and the resource uuid as the
  query.
- Results show in our Logs tab with the source labelled. It can't filter by host. It needs
  `operations:invoke`.

**Package Manager.** Use: yes. See "Server updates".

**Security Center.** Use: yes.

- Linked hosts show `security-center.access.check(hostId)` (score, critical vulnerabilities) in the Servers
  view, next to Coolify's own image-vulnerability counts.

**Host Metrics.** Use: partial.

- A card in the `host-metrics.managers` slot on linked hosts shows the Coolify resource counts and Sentinel
  container top list (see "Metrics").
- Host Metrics has no read service and doesn't store container data. We don't feed its history.

**Databases.** Use: weak.

- It supports only MySQL, PostgreSQL and SQLite through host CLIs, with no Docker mode, and no way for
  another plugin to pre-fill a login.
- We show whether a Coolify database already has a saved login there (`databases.logins.list`) and link to
  its tab. Our own in-container console stays the main way in.

**Backups, Cron, Certificates.** Use: read only.

- The Servers view shows failed Termix backup jobs on linked hosts (`backups.failed`).
- Cron and certificates are linked to, not driven. They expose no create API.

**Automations.** Use: yes.

- Our declared operation events (`coolify.deployment-failed` and the rest) appear as Automations triggers
  with no extra wiring.
- Our actions appear as Automations steps.

**Operations Center.** Use: yes.

- Our resources, actions and signals show there.
- Our host section links to `host-page.open(host, "coolify")`.

**Alerts.** Use: yes.

- `ctx.notify.send` delivers through the Alerts hub. Our UI links to `alerts.openChannels`.

**Not yet released:** databases, log-search, uptime, dns, package-manager, security-center, certificates,
backups, cron, reverse-proxy and operations-center have repos but no registry release yet. Their integrations
ship dark and light up when they are installed.

### Metrics, traffic and Coolify MCP

Coolify keeps no metric time series itself. Sentinel, its agent on each server, stores them in its own
database for `sentinel_metrics_history_days`. Coolify reads them over SSH. So the plugin reads them the same
way, plus through Coolify's MCP where that is on.

- **Container and resource metrics** (SSH, linked host):
  - `docker exec coolify-sentinel curl -s http://localhost:8888/api/container/<uuid>/cpu/history` and
    `/memory/history`, the same paths Coolify's client uses.
  - The current top list comes from `/api/containers/current`.
  - Shown as charts on the resource's Stats tab, with ranges up to the Sentinel retention, plus the live
    `docker stats` readout.
  - If Sentinel or metrics is off for that server, the tab offers "Turn on metrics", which calls
    `PATCH /servers/{uuid}/sentinel` (needs write and deploy).
- **Server metrics:**
  - Preferred: Coolify MCP `get_server_metrics {server_uuid, minutes ≤ 43200}`, which returns `current` and
    `series` for cpu, memory, disk, load and network. It needs no SSH.
  - Fallback: Sentinel over SSH.
  - Shown on the Servers view and the host section.
- **Traffic analytics** (Sentinel 1.0.2+, when Coolify's traffic analytics is on for the server):
  - `.../api/{app|resource}/<key>/traffic/{overview|paths|series|breakdown/<dim>}` over SSH.
  - A Traffic tab on applications shows requests over time, top paths, status codes, countries, browsers and
    bots.
  - `traffic_ip_mode` is honoured. When it's `anonymized` or `off`, IPs never show.
  - Coolify's API can't turn analytics on. The tab links to the Coolify page that does.
- **Coolify MCP client:**
  - A small JSON-RPC client posts to `<url>/mcp` with the same Bearer token. It's stateless streamable HTTP:
    `tools/call` with `{name, arguments}`.
  - The result is a JSON string inside `content[0].text`, parsed and stripped like REST payloads.
  - Tools used beyond metrics:
    - `get_infrastructure_overview` and `list_unhealthy_resources` for the Overview, so it costs one call
      instead of many.
    - `get_deployment` with `include_log_summary` for failed deploys.
    - `get_logs`, whose output is already redacted, for log snippets in alerts.
  - The probe checks MCP. It is off by default in Coolify (instance flag), and enabling it needs a root-team
    token. If it's off, every feature falls back to REST or SSH and the Instance section says how to turn it
    on.
- **Rules:** these are SSH features, so they need `coolify.operate` plus host `connect`. MCP reads follow the
  API rules.

### Server updates

- **What Coolify reports:**
  - `settings.patch_check_result` per server: total, security count, the update list with risk labels
    (docker, kernel or system), held packages, `reboot_required` and the running and installed kernels.
  - Also `patch_checked_at` and `patch_check_error`.
- **Where it shows:**
  - The Servers view and the host section show updates and security counts, "reboot required" and when it
    was last checked.
  - A signal `coolify.updates` shows security updates per linked host.
  - Updates flagged risk `docker` are called out, because they restart containers.
- **What can be done** (Coolify has no API to trigger a check, update or reboot):
  - With Package Manager installed: "Install updates" invokes `package-manager.upgrade-all` on the linked
    host. It goes through that plugin's own dry run, confirm and edit-access rules. "Check now" invokes
    `package-manager.list-updates`.
  - Without it: the same, over our own SSH, using `@termix-ssh/plugin-sdk/host-commands` for the OS's
    package manager and sudo. It needs edit access on the host and a confirm that lists the packages.
  - "Reboot server" is a destructive host action with a typed confirm, run over SSH. It warns that every
    Coolify app on the server goes down meanwhile.
  - After our own check, the fresh result shows at once. Coolify's own record catches up at its next
    scheduled check, and the UI says which is which.

### Public status page

Termix's own share-link guest views don't render for framed (API 2) plugins on this core. So the status page
follows the Uptime plugin's pattern instead.

- **Per connection:** the owner can publish a read-only page at `/plugin-api/coolify/status/:token`. The
  token is 32 random bytes, stored hashed, and can be revoked and rotated.
- **The URL is shown once.** Create and rotate return it once and nothing later can. Through an operation
  (`coolify.status-page-create`, `coolify.status-page-rotate`), it comes back only as an output marked
  `sensitive`, which Termix drops before the run is stored or shown, and the run's summary names the page,
  never the URL. So run history, logs and MCP call records never hold the token.
- **Getting that URL to an MCP client.** Because the stored run doesn't hold the URL, the handler also keeps
  it in process memory for at most 5 minutes, for the same user, readable once. The plugin's MCP endpoint
  takes it from there and adds it to that one `tools/call` response. A second read, another user or a
  restart gets nothing, and the owner can rotate to get a new URL.
- **Content:** the owner picks which resources appear. The page shows only display names, status, last
  deploy time and result, and uptime when the Uptime plugin is there.
  - It never shows uuids, servers, domains the owner didn't tick, logs or anything sensitive.
- **Serving:**
  - A public route returns self-contained HTML (inline CSS, no scripts from elsewhere) with its own strict
    `Content-Security-Policy`, and a JSON variant at `…/status/:token.json`.
  - Data comes from the status cache, so a page view never calls Coolify.
  - Public rate limit, and every view is logged. `authz.json` declares it `access: public`.
- **Optional auto-refresh:** a meta refresh every 30 seconds, with no script.

### Data model (`p_coolify_*`)

- **`connections`:**
  - `id`, `userId` (refUser), `name`, `baseUrl`, `tokenSealed`, `cfAccessIdSealed`, `cfAccessSecretSealed`
  - `allowPrivate`, `caCert`
  - `instanceKey` (varchar 255, indexed): the normalized base URL plus the Coolify team id, used to group
    connections to the same team
  - `pollEnabled`, `autoSync`, `execEnabled` (default false), `alertKinds` (json)
  - `abilities` (json), `coolifyVersion`, `teamName`
  - `lastError`, `lastCheckedAt`, `createdAt`
- **`grants`:** `id`, `connectionId`, `userId` (refUser), `level`, `createdAt`. Unique on (`connectionId`,
  `userId`). Users only, not roles: see "Decisions settled during review".
- **`webhooks`:** `id`, `instanceKey` (unique), `tokenHash` (varchar 64, indexed), `createdByUserId`,
  `lastReceivedAt`. One per Coolify team, shared by every connection with that `instanceKey`.
- **`servers`:**
  - `id`, `connectionId`, `serverUuid` (unique with `connectionId`), `hostId` (refHost, nullable)
  - `addressOverride`, `credentialMode`, `credentialId`, `keyFingerprint`, `lastSyncedAt`
- **`cache`:** `connectionId`, `kind`, `json` (stripped DTOs only), `fetchedAt`.
- **`events`:** `id`, `connectionId`, `kind`, `resourceUuid`, `deploymentUuid`, `hostId`, `title`, `detail`
  (json, no secrets), `createdAt`. Indexed on (`connectionId`, `createdAt`).
- **`onboardings`:** see "Partial onboarding" under Reverse onboarding.
- **`statusPages`:** `id`, `connectionId`, `tokenHash` (varchar 64, indexed), `resources` (json list of
  uuids), `title`, `createdAt`, `revokedAt`.
- **`dnsRecords`:** records we made through the DNS plugin: `id`, `connectionId`, `resourceUuid`,
  `handle` (json), `fqdn`, `createdAt`.
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
  - In memory only, between fetch or generation and `createSshKey` or `POST /security/keys`. The one
    exception is a key generated for reverse onboarding. It's kept sealed in its `onboardings` row only
    until that run completes or is cleaned up, so a restart can't strand a half-installed key. Then it's
    erased.
  - Audited without material.
  - Reveal of a Coolify key in the Keys section is not offered. Use Coolify for that.
- **Env, notification and S3 secrets:** fetched only on an explicit reveal or edit, never cached, never put in
  operation outputs (`sensitive` outputs where shown).
- **Shell commands:** `shellQuote`, a name allow-pattern, and secrets via stdin.
- **Webhook:** token-in-path (hashed), size limit, strict parse. `authz.json` declares `access: public`.
- **Ownership and grants:** checked on every route through `resolveAccess`. Host access is checked before any
  SSH. Another user's connection answers 404.
- **Database imports:** the plugin never carries dump files. The user puts the file on the server with
  Termix's file manager (SFTP on the linked host), or it's already in S3. The plugin only passes a server
  path or an S3 path to Coolify. A server path is checked with `test -f` over SSH, through `shellQuote`.
- **Typed confirmation:** required for deleting servers, databases, volumes and projects with resources.

### Settings

- **Admin:**
  - "Allow polling" (on), "Minimum poll interval" (60s), "Allow copying Coolify SSH keys" (on; off forces
    mode B).
  - "Allow sharing connections" (on).
  - "Allow public status pages" (`allowStatusPages`, on). Connection owners with `coolify.configure` can
    publish pages.
  - "Allow changes over MCP" (`allowMcpChanges`, off).
  - "Allow running commands in containers through the API and MCP" (`allowExec`, off). Each Connection
    also needs its owner's opt-in.
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
   - **Added at the owner's request ("all of them, now, as 1.0"):**
     - Companion plugins: every integration in "Companion plugins".
     - Metrics, traffic and the Coolify MCP client: Sentinel over SSH, MCP server metrics, the Stats and
       Traffic tabs.
     - Server updates: the status display, check, install and reboot.
     - Spec handling: the three vendored specs, version tagging, and the coverage test over their union.
     - Public status page.
     - Fully usable through Termix's API and MCP: an operation for every capability (including
       `coolify.exec`, `coolify.logs-tail`, `coolify.api-read` and `coolify.api-call`), the
       `/plugin-api/coolify/mcp` endpoint, `docs/api.md`, the redactor, the API console, the extended
       coverage tests and the `coolify.client` service.
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
   - Security section (vulnerabilities, audit), Team and Instance sections.
   - Assistant and MCP surfaces review.
   - Mobile polish.

Each milestone updates `docs/coverage.md`. By 1.6.0 every spec operation is either used or listed with a
reason.

### Identity (AGENTS.md first-time setup)

| Field         | Value                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `coolify` (not an official id, not in the registry)                                                                                                                   |
| `name`        | "Coolify for Termix"                                                                                                                                                  |
| `description` | "Coolify inside Termix: servers become hosts (tunnels included), one-click container shells, deploys, logs, variables, backups and alerts, and the full Coolify API." |
| `category`    | Infrastructure                                                                                                                                                        |
| `icon`        | `Rocket`                                                                                                                                                              |
| `repository`  | https://github.com/pacnpal/termix-coolify-plugin                                                                                                                      |
| `docs`        | the repo's `docs/`                                                                                                                                                    |
| `engine`      | `termix >=26.11.2-0`, `api ^2.7.0` (frames embedding other plugins' parts, needed for `terminal.view`)                                                                |

### Database imports

Coolify (v4.7.5 and newer) imports a dump from three sources: `upload`, `s3` and `server`. The plugin uses
`server` and `s3` only.

- **From the server:** the Import form has a path field and a "Browse" list of the linked host's files. The
  list runs `ls` over SSH in a folder the user picks, defaulting to `/tmp`. A "Put a file there" button opens
  Termix's file manager on that host, if it's installed, so the user can upload with SFTP. The plugin then
  posts `{ source: "server", path }` along with the engine options (`dump_all`, `replace_existing`,
  `keep_owners`, `restore_mysql_users`, `sqlite_database`), and polls the import status.
- **From S3:** pick one of the team's S3 storages and a path.
- **`upload` is not used.** `ctx.fetch` only sends string bodies, so the plugin can't send a binary multipart
  stream. Holding a large dump in memory would also break the plugin process's memory cap.

## Decisions settled during review

A reviewer read this design as the builder would. These are the calls made from its questions. Each is
marked as mine for the owner to check.

1. **Connections are shared with users only, not roles** (my call). Termix plugins have no way to see who
   is in a role unless they take `db:core-refs`, a high-risk capability. That would break "stay inside what
   Termix allows, with the fewest capabilities". The owner shares with each person instead. Admins can
   still limit the plugin's permissions per role in Termix.
2. **One webhook per Coolify team, shared across connections** (my call). Coolify sends to only one URL per
   team, so a webhook per connection would silently steal events from each other. Events fan out to every
   connection for that team. Setup asks before replacing a webhook URL it didn't set.
3. **Two people connecting the same Coolify each get their own hosts** (my call). Termix hosts belong to
   one user, so that is how Termix works. The recommended way for a team is one connection, shared with
   the others, along with its linked hosts.
4. **Database imports come from a server path or S3, not a browser upload** (my call; reasons above).

### Confirmed with the owner (design interview)

These were settled one by one with the owner. The glossary is in `CONTEXT.md`, and the hard-to-reverse
choices are in `docs/adr/`.

- **Connections:** personal (owned by the Termix user who added them), shared with named users through
  Grants. Server access is a separate Grant.
- **Linked hosts:** locked while managed. Unlink makes them ordinary, editable hosts.
- **`coolify.exec`:** in 1.0, behind an admin switch and the Connection owner's opt-in. Both are off by
  default.
- **Changes over the plugin's MCP endpoint:** reads plus deploy and restart work by default. Everything else
  needs the admin switch `allowMcpChanges`, which is off by default. REST API-key calls are not affected by
  that switch.
- **Supported Coolify versions:** 4.4.0 and newer.
- **Name:** "Coolify for Termix", id `coolify`, generic Rocket icon, published to the community registry.
- **Default roles:** all five permissions go to admin and user. Termix admins can tighten them.
- **Public status pages:** allowed by default. Owners with `coolify.configure` publish them, and admins can
  turn them off.
- **Recommended Coolify token:** read, read:sensitive, write and deploy.

## Gaps (what neither API allows, and what we do instead)

- **Metrics history:** Coolify's REST API has none. Server series come from MCP, and container and traffic
  series from Sentinel over SSH. Both depend on Coolify having metrics or traffic analytics turned on for
  that server.
- **Patch check, OS updates, reboot:** Coolify exposes none of these in REST or MCP. We act over SSH or
  through the Package Manager plugin, and read Coolify's last check from the server settings.
- **Share-link guest views:** these don't render for framed plugins on this core, so the status page is a
  self-contained public route.
- **Termix plugins with no create APIs:** HTTP monitors in Uptime, Databases logins, backup and cron jobs.
  We link to them instead.
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
