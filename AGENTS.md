# AGENTS.md

This repo is a [Termix](https://github.com/Termix-SSH/Termix) plugin. These notes are for AI coding tools.

## Read first

Before changing anything, read `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`. It covers the
manifest, backend, database, frontend, UI, testing, releasing and submitting to the community registry,
and it matches the SDK version installed here. If it is missing, run `npm install`. If it is still missing,
the SDK is older than 1.0.6: run `npm install -D @termix-ssh/plugin-sdk@latest` or read
https://docs.termix.site/develop instead.

If the guide and the SDK's TypeScript types disagree, the types are right.

## Commands

```bash
npm run build        # bundle into dist/
npm test             # run the tests
npm run typecheck    # type check
npm run validate     # check manifest.json, migrations, changelog and docs
npm run migrations   # write migrations after changing src/backend/tables.ts
npm run pack         # write <id>-<version>.tmxplug
npm run format       # format with Prettier
```

`npx termix-plugin dev --server <url> --key <tmx_...>` installs the plugin on a Termix server with
developer mode on and reinstalls it on every save. Don't start it unless the user asks.

## The plugin process

The backend runs in its own Node process (plugin API 2). It reaches Termix only through `ctx`, can read only
its own folder and opens no sockets or child processes unless a capability grants it. List every
`ctx.schedule.every` id, `ctx.events.on` topic and `ctx.registry.provide` key in the manifest's `sandbox`
block, await `services.get` and `registry.consume`, and pass only plain data to `ctx`. The tests run with
`createMockCtx({ sandbox: true })`, which applies the same rules. The guide's "The plugin process" section
has the details.

The frontend runs in a sandboxed frame that reaches only its own routes. `tests/frontend/frame.test.ts`
(`checkFrameApp`) and `frame-views.test.ts` (`checkFrameViews`) fail when the plugin registers or reads
something a frame can't. Keep both; the guide's "Frames" section has the rules.

## Actions

Declare what the plugin can do in `contributes.operations` and register each handler with `ctx.operations.register` (see `src/backend/operations.ts`). Every surface then finds it on its own: Operations Center, Automations, the CLI, the phone app and the command palette. Read the Operations section of PLUGIN-GUIDE.md before adding one.

## Layouts and themes

A plugin can also be a layout (`contributes.layouts`, capability `ui:layout`, `app.registerLayout` in the
frontend, shell state from `useShell()`) or add themes (`contributes.themes`, capability `ui:theme`, one CSS
file per theme scoped under `.<id>`). A theme only plugin has no `src/`: just `manifest.json`, `themes/*.css`,
`locales/` and a test that runs `validateThemeCss()`. The guide's "Layouts and themes" section has the rules.

## Done means

- `npm test`, `npm run typecheck`, `npm run validate`, `npm run build` and `npm run format:check` pass
- `npx termix-plugin migrations --check` passes
- New UI text is in `locales/en.json`, new routes have an `@openapi` block and a test
- New routes and sockets have an entry in `authz.json` (the guide's "Authorization table" section)
- `docs/` and the section below still match what the plugin does
- User facing changes are in `CHANGELOG.md` under the version they ship in

## About this plugin

Keep this section current when the plugin changes: what it does, how it is put together, decisions that
aren't obvious from the code, and anything that has bitten you before.

- What it does: "Coolify for Termix" (id `coolify`) brings Coolify servers and resources into Termix.
  Where things stand: identity, permissions, admin settings, the vendored API and the tables exist,
  Connections work (routes, operations, the Connections view and the "Connect Coolify" onboarding step),
  Resources can be browsed (Overview tiles, the Resources list, a resource's Overview detail) and deployed,
  started, stopped and restarted, host sync turns Coolify servers into locked Linked hosts, container
  shells and database consoles open in a `coolify-shell` tab, a resource's Logs view reads and follows
  container logs, Stats and Traffic tabs and the host card's server metrics read Sentinel and Coolify's
  MCP, and a Linked host's card checks, installs and reboots its server's updates. Companion plugins (DNS, Uptime, Log Search, Security Center, Host
  Metrics, Databases, Backups) add their features when they run, and owners can publish public status pages.
  The design is in `docs/superpowers/specs/2026-11-19-coolify-plugin-design.md` and the build plan in
  `docs/superpowers/plans/2026-11-19-coolify-1.0.md`.
- Coolify calls: `src/backend/coolify/http.ts` is the only way to Coolify (ctx.fetch, Bearer and CF Access
  headers, `redirect: "manual"`, 150 requests a minute, GET retries, every failure a `CoolifyError` with a
  `CoolifyCause`). `toRouteError` sends fixed messages only, never what Coolify sent back, because Coolify can
  echo a token. `/version` and `/health` answer `text/html`, so they use `{ text: true }`; any other HTML
  body is `not-coolify`. `dto.ts` picks fields by name (no spreads), `api.ts` calls paths from `OPERATIONS`.
  Path parameters go through `fillPath` in `coolify/path.ts` (one segment: no dot-only values, slashes,
  backslashes or `%`; spec enums and integers enforced), and `buildUrl` refuses any path that URL parsing
  would change. fetch resolves `..`, so without both a checked operation could reach another endpoint.
- Connections: `src/backend/connections/` (service, probe, routes) and `src/backend/ops/connections.ts`.
  Tokens are sealed with `ctx.secrets.seal`. The `abilities` column holds the probe summary
  (`{ abilities, scoped, teamId, steps }`), since there is no column for scope or the checklist.
  `lastError` holds a cause id, which the UI translates under `causes`. Create refuses Coolify older than
  4.4 and stores nothing; any other failed probe is saved with `lastError`, so authz CI can seed one with
  an unreachable URL. Another user's connection is always 404. Only owners reach a connection in 1.0; the
  grants table is read but nothing writes it. `remove` calls the `releaseLinkedHosts` hook first (host sync
  supplies it) and keeps the webhook row, which other connections to the same team share.
- Probe: `abilities.root` is never inferred. `GET /settings/email` answers any root-team admin's token
  whatever its abilities, so it is only the `settings` step; no read-only call needs `root` alone. Only
  logs or key material prove `sensitive`. A check with nothing to try gets `skipped: "nothing-to-probe"`.
- Writes to one connection are serialized by an in-memory per-connection lock (`withLock` in
  `service.ts`): update (held through its probe, so updates apply in the order asked), remove, and storing
  an explicit probe's result. This relies on the plugin backend being a single Node process per Termix
  server; if that ever changes, the lock must move to the database. An explicit probe runs outside the
  lock and stores its result under it only while the connection still points at the probed target
  (`sameTarget`), so a probe of an old target is dropped. No path answers 409 for a write. Update
  reads a stored secret only when the change keeps it and needs a probe; an unreadable one is refused
  (400), and a replacement token or Cloudflare Access value repairs it.
- Transport: `checkTransport` runs in `clientFor`, before any client exists. https is required; plain http
  only for loopback (`localhost`, 127/8, ::1), or a private or link-local IP literal with `allowPrivate`.
  Names are never trusted as private (the plugin can't resolve them; `coolify.lan` could be public). In `http.ts`, an HTML answer to a 4xx is `not-coolify` (never a token ability), and every
  body read goes through `readText`, so a failed read is a typed `CoolifyError`.
- The connection form: after a create it edits the saved row (no duplicates), and saving a failed
  connection whose update didn't check again (same `lastCheckedAt`) calls the probe route, so a retry after
  fixing Coolify isn't stuck. The backend still doesn't re-probe a plain rename.
- Service logs are read per Part; `get-service-logs-by-uuid` needs a `sub_service_name` and is skipped.
- Operation tests: the mock ctx records no run history, so `tests/backend/helpers/run-history.ts` applies
  the SDK's own `parseOperationInput` and `redactFields` around `ctx.operations.run`, as core does.
- Coolify API: `vendor/coolify/` holds the v4.7.5, `main` and `next` specs as fetched (see its README).
  `npm run gen:coolify` writes `src/backend/coolify/generated/operations.ts` (`OPERATIONS`,
  `EXCLUDED_OPERATIONS`) and `schemas.json` with its accessor `schemas.ts` (each operation's parameters
  and top-level body fields, from the newest spec that has it, for the generic API and the console's
  forms). The JSON stores each distinct parameter and body field once and operations refer to them by
  index: as repeated TypeScript literals it was most of the bundle and failed SonarCloud's duplication
  gate. `docs/coverage.md` must list every
  operation; `tests/backend/coverage.test.ts` enforces it. There are no generated schema types:
  openapi-typescript needs a TypeScript 5 alias, and the registry CI's lockfile-lint
  (`--validate-package-names`) rejects npm aliases. DTOs are written by hand.
- Generic API: `src/backend/ops/api-generic.ts`. `requiredAccess(operationId)` gives the Termix permission
  and grant level by path and method rules, first match wins: excluded (throws), administer, operate
  (including reads with log or command output), other GET is view, the rest configure. `createGenericApi`
  (`dispatch`, `list`, `reveal`) applies permission, grant and the known token ability before calling
  Coolify; Coolify checks the rest of the token itself. The `upload-*` imports are refused (`ctx.fetch` only
  sends strings). A 404 from a Coolify older than the spec that documents an operation becomes
  `unsupported-by-instance`. The console routes (`src/backend/api/routes.ts`) call the same service; a
  DELETE also needs `confirmText` equal to the operation id. Reveal re-reads Coolify, is audited and
  answers `Cache-Control: no-store`. `isSensitive` (every DELETE, plus `SECRET_PATH`: envs, `/security`,
  cloud tokens, secret manager, logs, notifications, SMTP, S3, registries, Git apps) and every non-GET
  need `dispatch(..., { confirmed: true })`; `coolify.api-read` refuses sensitive ones (MCP runs it as a
  read, without Allow changes) and the api-call handler passes `confirmed` because core confirms every
  destructive run. Each call uses one `connections.snapshot()` (its `http` is the request layer) and
  checks `connections.revision()` right before the request (`target-changed`). Bodies are cut to the
  spec's top-level fields. Answers go through `scrubSecrets` in `http.ts` (masks strings holding the
  token or Access secret) and `redact`. Every non-GET invalidates the resources and server-status caches
  in a `finally`. `secrets-unreadable` is 409: it is the token's ability, not the user's access.
  The generator also writes `TEXT_ANSWERS` (operations whose 2xx answer lists no JSON type; sent with
  `{ text: true }`), `SECRET_FIELDS` (string fields any spec describes as a password or secret) and each
  array query parameter's `items`; arrays go out as one `name=value` per item (form, exploded).
  It also writes `RAW_FIELDS` (string fields described as YAML, Compose, a script, a Dockerfile, Nginx
  config, labels or env text; masked whole), `LOG_FIELDS` (per operation, every non-flag
  `logs`/`log`/`output`/`*_logs`/`*_output` property, or string described as output, anywhere in its
  2xx schema in any spec), `LOG_PURPOSE` and `nullable` on params and body fields (the console's "Send
  null"). Body fields are the union of the body's own, allOf, oneOf and anyOf properties; a field is
  required when the body or an allOf branch requires it, or every oneOf (anyOf) branch does.
  The log rule: an operation is for logs (`LOG_PURPOSE`) when it is a read (GET, or POST to `.../logs`)
  and its path has a `logs`, `deployments`, `executions` or `imports` segment, or log fields are at
  least half of its answer's top-level properties. Those need `coolify.operate`, an operate grant and a
  confirm (they are `isOperate` and sensitive). Any other answer that merely holds a log field
  (`list-servers`, `get-server-by-uuid`, the database reads and `update-server-by-uuid`, through
  `validation_logs`) is an ordinary read; `dispatch` masks the operation's `LOG_FIELDS` unless the call
  is confirmed and the actor has `coolify.operate` and an operate grant. Revealing a log field needs
  `coolify.operate` too. A server transfer's status stays operate by hand (its schema has no log field).
  `authorize` also applies `tokenAllows` (`token-ability`, 409), and `send` passes `beforeFetch` so the
  request layer checks the revision again after its budget and retry waits, right before each fetch.
  The console drops late answers with request generations (reveal, operation list, connections).
- Redaction: `src/backend/redact.ts` is the one redactor for the generic API, the console and every MCP
  tool result. It masks secret keys (`SECRET_KEY`, including `*_key` and `*_db_url`, plus
  `SECRET_FIELDS`) and, in every other string at any depth, a URL's userinfo password and credential
  query parameters (`maskCredentials`). A secret `*_url` that parses as a URL keeps its shape with the
  password masked. `isMasked` (a string holding `[redacted]`) is what `maskedPaths` and reveal use, so
  reveal (configure, a sensitive token, audited) is the only way an unmasked value comes back. DTOs
  carry no URLs or passwords.
- Tables: `src/backend/tables.ts`, migrations in `migrations/`. Table names are snake_case
  (`p_coolify_status_pages`); the SDK refuses camelCase. `servers.hostId` is a plain nullable integer, not
  `refHost`: a cascade would delete the row and its `addressOverride` when the host goes. The `host.deleted`
  handler sets it to NULL (unlinks) instead.
- Resources: `src/backend/resources/` (service, routes) and `src/backend/ops/resources.ts`. The service
  merges `/applications`, `/services` (each service followed by its Parts) and `/databases`, never
  `/resources`, and caches the merged DTO list in the `cache` table (kind `resources`, 20 seconds) through
  `src/backend/cache.ts`. Every read first asks `connections.revision(id)`, which checks access (so another
  user never gets a cached row) and answers a hash of the address, sealed token, sealed Cloudflare Access
  values and TLS settings. The cached rows carry that revision and in-flight fetches are keyed by it, so a
  changed target never serves old rows, a caller after a change never joins an older fetch, and a fetch
  that finishes after a change is not cached. Concurrent misses share one fetch. `invalidate(connectionId)`
  is the hook for lifecycle actions: it advances an in-memory per-connection generation, drops the
  in-flight fetches and the cached row. Cached rows carry their generation too, and a hit needs both the
  revision and the generation to be current, so a write that lands after the drop is never served.
  Generations are unique to each `createResources` instance (`<epoch>:<n>`, the epoch a random uuid), so
  after a restart no row an old instance wrote matches and the cache starts cold.
  `ResourceDto.serverName` comes from `server.name` or `destination.server.name` in the payload.
  The MCP tool `list_resources` (`src/backend/mcp/server.ts`) runs `coolify.list-resources-all`.
- Status pages: `src/backend/status/` (service, render, routes, base-url) and `src/backend/ops/status-pages.ts`.
  Tokens are 32 random bytes (base64url); only the sha256 is stored (`tokenHash`, unique), checked again with
  `crypto.timingSafeEqual`. Revoke sets `revokedAt`; unknown, revoked or switched-off (`allowStatusPages`)
  pages answer 404. The public routes are the router's `public` paths (core's limit of 120 public requests
  a minute per address applies; don't raise `publicRateLimit`) and read only the resource cache, never
  Coolify. A view reads the connection once with `connections.unattendedSnapshot()` (owner, `revision`, a
  lazy client; no actor check) and answers the same 404 as an unknown token when the connection is gone or
  `ctx.rbac.hasFor(owner, "view")` is false. `resources.peekCached(id, revision)` serves only rows cached
  under that revision and the current generation, so a repointed connection never shows the old target's
  rows, and a page still shows only its chosen uuids. Views that arrive together share one read, keyed by
  token hash and a page generation that rotate and revoke advance before and after their write, so a view
  after a rotate never joins an older read. The `status-refresh` job (60 s, jitter, in `sandbox.schedules`)
  refreshes that cache with `resources.refreshUnattended`, through the same snapshot, revision and
  generation keys as signed-in reads (it shares their in-flight fetch), and skips connections whose owner
  lost `view`. Never return what it reads to a caller. It calls `keepAwake("status pages", active)` and
  backs off 1, 2, 5, 15 minutes per connection. A page URL's base is the create/rotate request's own
  `ctx.http.baseUrl(req)`. Operations have no request, so `base-url.ts` keeps each signed-in user's own last
  address (memory and kv `publicBaseUrl:<userId>`) and uses only the same actor's; with none the URL is
  relative. Never share one remembered address between users: a Host header is the caller's to choose, and
  it would steer another user's secret link. The URL never enters run history: create and
  rotate return `{ id, handoffId, url }` with `url` a `sensitive` output, and stash it in memory
  (`stashOnceUrl`, 5 minutes, once, per user and run id) for the MCP `tools/call` answer,
  `take_status_page_url` or `POST /status-pages/handoff/:handoffId`. The MCP endpoint applies
  `redactFields(action.outputs)` to every action's data, as core does. Uptime is a `deps.uptime` hook,
  not wired to the Uptime companion yet, so pages show no uptime. The resource list has no deploy result yet, so
  `lastDeployOk` is null.
- Status words: `src/shared/resource-health.ts` (`resourceHealth`, `countResources`) is the one reading of a
  Coolify status, imported by both the backend and the frontend. Exited is stopped, whatever its health
  suffix. Degraded covers degraded, restarting, dead and unhealthy, as a state (`unhealthy`) or a suffix
  (`running:unhealthy`). Parts aren't counted (their service's status covers them).
- Frontend: `src/frontend/views/CoolifyTab.tsx` owns the SideNav, the selected connection and the shared
  resource list (`useResources`). The list is keyed by the connection's id and `revision` (the same
  non-secret hash, also on `ConnectionView`), and `ConnectionsView`'s `onSaved` puts a saved row back into
  the tab, so editing the selected connection's target clears and reloads it. `ResourceDetail.tsx` lists its views in `DETAIL_TABS`; a new
  view adds an id there. Filtering and grouping are pure functions in `resource-model.ts`.
  `contributes.mobile` lists `coolify` and `coolify-shell`. `DETAIL_TABS` has `shell`, whose view holds the
  Open shell and Open database console buttons (only with `canOperate`), and `logs`, `stats` and
  `traffic` (`OPERATE_TABS`: shown only with `canOperate`; `detailTabs()` shows `traffic` for
  applications only). Stats and Traffic are keyed by connection, uuid and revision, like Logs.
- Host sync: `src/backend/sync/` (`mapping.ts` pure `planHost`, `credentials.ts` key copy, `locks.ts`,
  `service.ts` `createSync`, `routes.ts`) and `src/backend/ops/sync.ts`. `createSync` is async (it loads the
  lock set from `servers.hostId` before providing locks) and is made right after `createConnections`, whose
  `releaseLinkedHosts` hook calls `sync.releaseConnection`. `apply`, `unlink` and `releaseConnection`
  run through `serialized(connectionId, ...)`, one queue per connection (`locks.ts` is the host lock
  provider, not a mutex); the `host.deleted` handler stays outside it because `release()` deletes hosts
  while holding it. Removing a connection is one step of that queue: `releaseLinkedHosts` gets the row
  deletion as a `deleteRows` continuation and `releaseConnection` runs it after releasing the hosts. Lock
  order is always the connections service's `withLock` first, then the sync queue; sync never takes
  `withLock`. `apply` also re-checks `ownedConnection` before its first host write and ends with the
  `ConnectionError` if the connection is gone. A host `apply` created whose link row fails to save is
  unlocked and deleted (`discardHost`). Key material comes only from
  `api.keyForCopy()` (not a DTO) and goes only to `ctx.credentials.createSshKey`; reuse is by fingerprint
  among the connection's `credentialMode = "coolify"` rows, and only while the id is still in
  `ctx.credentials.listSshKeys()` (a deleted copy is made again; an unreadable list blocks the server with
  `credential-check-failed`). A failed copy stores `credentialMode = "copy-failed"` (`COPY_FAILED`), which
  the preview reads as termix mode with `needs-credential`. Every stored id is checked before use:
  `hostId` by `ctx.hosts.update` answering null (then a new host is made), picked credential ids by
  `ctx.credentials.list()`, copied ones by `listSshKeys()`. `ssh-keys` from the SDK needs `ssh2`, which only
  Termix supplies, so it is imported lazily and only when Coolify sends no `public_key`. Tunnelled servers
  go through `planTunnel`: the host address is the tunnel hostname and `pluginSettings["ssh-terminal"]`
  gets SSH Terminal's own setting names from `SSH_TERMINAL_KEYS` (checked against SSH Terminal's
  `src/backend/settings.ts`; keep them in that one constant), port 443, and the connection's Access token
  only in `apply`, unsealed once from the snapshot (empty strings when the connection has none). Host
  updates merge the keys they are given and keep the rest, so `planHost` never leaves a key it once wrote
  out. `servers.tunnelApplied` (migration 0002) records that sync wrote tunnel settings on the row's
  current host. It must never lag the host: it is saved true before the update that turns an existing
  host's tunnel on (write-ahead), and in the same save that records a created host's id; it is cleared
  only in the link save after a tunnel-off write succeeded. An abort leaves it true, which costs at most
  one redundant clear. It is reset when the host is released or deleted (no host to track). 0002 backfills it to true on every row with a host:
  for hosts linked before it, unknown counts as tunnelled (fail closed). A plain server whose row has it gets the tunnel switched
  off and its hostname and token cleared once, and only while SSH Terminal runs (core skips settings for
  a plugin that doesn't); otherwise `planHost` blocks it with `needs-ssh-terminal-to-clear-tunnel` and
  the host is left untouched. Plain hosts that were never tunnelled get no SSH Terminal settings. `pluginEnable.docker` is only ever true and only
  while Docker runs, which is also the only time core would take a write. `apply` and `preview` read the
  connection once with `connections.snapshot()`: view (name, address, abilities, `revision`), client and
  a lazy Access token from one row, so nothing is read again from the connection later. `apply` checks
  `connections.revision()` against the snapshot after `api.servers()` and right before every write:
  each row save, each key copy (the copier's `beforeWrite`, after the key reads), the folder, and each
  host update or create (`beforeWrite` runs `assertSnapshotHolds`, with the owner check). It ends with
  `target-changed` (409) when they differ; a host created just before is discarded, since its link row
  is not saved. `discardHost` itself is not checked: it only undoes this sync's own write.
  connection updates take #23's `withLock`, not the sync queue. Previews pass `cfAccess: null`. SSH Terminal
  must be active at 1.2.0+ (`SSH_TERMINAL.minVersion`, semver order, pre-releases of 1.2.0 are below);
  `ctx.plugins.list()` is read once per preview (only when a server is tunnelled) or apply and fails
  closed: an unreadable list blocks tunnelled rows with `needs-ssh-terminal`. The SDK tsconfig has no
  strict null checks, so a boolean `ok` does not narrow a union: `HostPlan` names both fields on both sides. The mock ctx's `hosts.create` drops
  `pluginSettings` and `pluginEnable`, so tests spy on the calls to check them. `coolify.unlink`'s server
  input uses `ops.fields.linkedServerUuid`: `ops.fields.serverUuid` is the optional filter of
  `coolify.list-resources-all`.
- Frontend host surfaces: `src/frontend/linked.ts` reads a host's link from its own settings and shares one
  sync preview per connection (five minutes) between badge dots and the host card. The host card shows the
  tunnel line from the row's `tunnel` flag and opens the host editor with `shell.editHost`.
  `views/SshTerminalCheck.tsx` has the Open Plugins button (`useTabs().openSingletonTab("plugins")`) used
  by blocked sync rows, and the single SSH Terminal line `ProbeChecklist` adds when Coolify has tunnelled
  servers (it reads the sync preview; scoped tokens get none). That line reloads on the connection's
  `revision` and `lastCheckedAt`, clears when the token turns scoped, and keeps only the newest answer
  (a request generation, as in `useResources`). Host sync is the tab's
  Servers section (`SyncView` for the selected connection, shown with `coolify.configure`); a connection's
  Sync servers row action calls `ConnectionsView`'s `onSync`, which selects it there. `CoolifyTab` reads
  `tab.data` `{ section, connectionId? }`: `"sync"` opens Servers (no id: the first connection the actor
  owns with an unscoped token), and any section name opens that section on that connection. The request
  is tracked by the `tab.data` object (the shell sets a new one on every opening), not by its values, so
  the same action twice still applies. `SyncView` shows the address field on every row still in Coolify,
  and the credential picker for `CREDENTIAL_CAUSES` (needs-credential, credential-not-found,
  credential-check-failed). Rows blocked by `SSH_TERMINAL_CAUSES` (needs-ssh-terminal,
  ssh-terminal-too-old, needs-ssh-terminal-to-clear-tunnel) can't be included and show the Open Plugins
  button.
- Lifecycle: `src/backend/resources/lifecycle.ts` has `lifecycle(api, uuid, verb, opts)` (a Part uses its
  service's per-Part endpoints; a Part's deploy deploys its service) and `createLifecycle`, whose
  `authorize` is the one access check for every lifecycle path: `coolify.operate`, owner or a grant of
  operate/configure, and a uuid found in that connection's own resource list (a cache miss is checked once
  fresh). `onHost` also needs the resource on the host's own server. Routes (`resources/routes.ts`) run the
  resource-scope action on the Linked host (`sync.linkedHostFor`) or the server-scope one, and map a failed
  outcome back to a status and cause. `sync.linkOfHost(hostId)` is the reverse lookup handlers use. Every
  action that reaches Coolify calls `resources.invalidate(connectionId)` afterwards (success or failure),
  and a waited deploy calls it again when the deployment ends, so the next read refetches and an
  in-flight fetch from before the action is dropped.
- Shells: `src/backend/ssh.ts` (`SshRunner` over `ctx.ssh.exec`, `isHostKeyError`) and
  `src/backend/containers/` (`commands.ts` name check, `DB_CONSOLES`, `shellCommand`; `resolver.ts` docker ps
  filters; `service.ts` the checks; `routes.ts`) and `src/backend/ops/containers.ts`. Order of checks:
  `connections.snapshot(id)` once, lifecycle's `authorize` (operate permission, owner or operate/configure
  grant, uuid in the connection's own list; a Part is authorized too and must have the path's uuid as its
  parent), Linked host (`sync.linkedHostFor`, else 409 `not-linked`), the actor's
  `ctx.hosts.checkAccess(hostId, "connect")` (else 403 `no-host-access`), the snapshot's revision checked
  again, then SSH, and the revision once more before the command is answered (409 `target-changed`).
  Fingerprints come from the snapshot's client. Container names are refused outside `[A-Za-z0-9_.-]` or with
  a leading `-`; every other value goes through `shellQuote`. Console scripts only name the container's own
  variables and are one quoted `sh -c` argument, so `$` expands in the container. A password reaches a
  client only through an env variable (PGPASSWORD, MYSQL_PWD, REDISCLI_AUTH, clickhouse-client's own
  CLICKHOUSE_PASSWORD; mongosh reads `process.env` in `--eval`), never argv, which `ps` on the host shows to
  every user. Several matches answer HTTP 300 `{ choices }`; the frontend reads choices from a rejected axios
  call too. `ContainerError` has its own statuses (409 for `not-linked`), unlike `ConnectionError`'s 404.
- Shell tab: `src/frontend/views/ShellTab.tsx` reads its tab data `{ connectionId, uuid, part?, container?,
console }`, calls the shell route and draws `PluginComponent id="terminal.view"` with `hostConfig` and
  `executeCommand`; the fallback is a NoticePanel with the command to copy. Picking a container re-asks in
  place. Shell host ids can be strings, so hosts are matched by `String(id)`, not `useHost`.
- Logs: `src/backend/containers/logs.ts` (`readLogsRequest`, `logsCommand`, `redactLog`, `createLogs` with
  `snapshot` and `follow`), `sockets.ts` (`WS /logs`) and the `coolify.logs-tail` action in
  `ops/containers.ts` (refused without `confirm: true`, so MCP and ops reads are explicit). The containers
  service exposes `target` (lifecycle's `authorize`: coolify.operate, owner or operate/configure grant, uuid
  in the connection's own list), `locate(id, snap, uuid, request)` (every check up to the chosen container,
  running or not, including the snapshot's revision before any SSH), `assertHostAccess`,
  `assertSnapshotHolds` and `guard` (host key errors to `host-key`); shells and logs share them. Each read
  takes `connections.snapshot(id)` once; the revision is checked again in Coolify's `beforeFetch`, right
  before `docker logs` and right before `ctx.ssh.connect`. A snapshot uses Coolify's API only with
  `abilities.sensitive`, never for a whole service (Coolify needs one sub-service) or a container picked
  from SSH choices; a Coolify `forbidden-ability` falls back to SSH. The count is capped at 10,000
  (`MAX_LINES`), never refused. The container name passes `assertContainerName` and is `shellQuote`d, and so
  is the line count; no secret is ever in the command.
- Log redaction: every snapshot text and every followed line goes through `redactLog`. It first masks
  every private key block's body (`maskKeyBlocks`: several on a line, escaped `\n` or real newlines, and a
  block without END to the end of the text; linear `indexOf` scans). `lineSplitter` keeps a block opened
  by one line open (`keyEnd`) and drops the body lines until its END, and `openSecretStart` counts an open
  block, so a long-line cut never splits one. Then the snapshot's own
  token and Access secret (`snapshot.secrets()`, unsealed from the same row) are replaced anywhere, then
  redact.ts's `maskCredentials`, then secret-named `name=value`/`"name": "value"` fields and
  `Authorization` credentials. Names are bounded (`{0,64}`) so a long line can't backtrack for long.
  A quoted value is masked through its closing quote (escapes honoured); an unterminated quote or a YAML
  `name: value` starting its line masks the rest of the line; other unquoted values run to the end of
  the token (whitespace or `&`, so every secret on a line is matched; YAML is its own `YAML_FIELD`
  pass). Authorization and Proxy-Authorization credentials are masked at any length; a bare scheme word
  (`Bearer x`) needs 8 characters. `redactLog` repeats the passes until the text stops changing (at most
  `MAX_PASSES`). LogsView keeps the follow's own source (`followSource`) for its badge. Followed bytes go through `lineSplitter`: one streaming `TextDecoder` per
  stdout/stderr, and a line over MAX_LINE is cut only at a point `safeCut` finds no bounded match
  across (redacting the halves of a 4 KiB `CUT_WINDOW` around it equals redacting it whole), keeping
  1 KiB (or twice the longest secret) back; with no safe cut the rest of that line becomes one
  `[redacted]`. Window equality isn't proof for a secret that starts before the window, so each cut
  first asks `openSecretStart(prefix)` (one forward scan from the last clean cut): an open URL
  userinfo, quoted or unquoted secret value, YAML secret line or Authorization credential masks from its
  start to the end of the line. A prefix whose redaction ends masked does the same. At a cut a context
  closes only at whitespace (or its own closing quote): `@`, `/` and `&` never close it. The connection's
  own secrets, which can outrun the window, are checked by `indexOf` across the cut. A seeded 500-case
  property test in `logs.test.ts` streams mixed secret shapes 1–5× MAX_LINE long in random chunks.
- logs-tail over MCP: `text` is a sensitive output, so core drops it from run history and from what
  `redactFields` passes on. The handler keeps the redacted text in memory (`takeLogText`, per user and
  `handoffId`, 60 s, 16 MB at most) and `actionResult` in `mcp/server.ts` puts it back into that one
  answer.
- Follow socket: `ctx.asUser` needs `users:impersonate`, which the plugin doesn't have. Core runs a socket's
  events in the opener's actor context (its child runtime wraps them in `als.run`), and timers started in
  a handler keep it, so each message and each `RECHECK_MS` (15 s) check runs `ctx.currentActor() ===
conn.userId` (refused otherwise), `rbac.has("operate")` and the follow's own `recheck` (authorize, the
  snapshot's revision, host connect access); `isDataUnlocked()` is checked per message and per flush.
  Checks are queued with messages so they never interleave. A refusal closes 1008; `target-changed` stops
  the follow. The follow runs `docker logs -f --tail 0` over `ctx.ssh.connect` with a pty, so closing the
  channel hangs it up; stop sends KILL, closes the channel and disposes. One follow per socket: a new
  subscribe stops the old one. Lines are batched every 250 ms, at most 500 a batch and 2,000 buffered
  (older ones dropped with a `dropped` count), lines over 16 KiB split. When docker logs ends, the
  whole buffer is drained in batches before `ended`. A `choices` reply shows LogsView's picker. Tests drive the handler from
  `mock.wsRoutes` with a fake socket and must `setActor` to the socket's user, as core does.
- Logs view: `src/frontend/views/LogsView.tsx` in ResourceDetail's `logs` tab, keyed by connection, uuid
  and `revision`, so switching resources or targets starts empty and closes the follow. Its loads keep only
  the newest answer (a request generation, as in `useResources`). It opens the socket through
  `src/frontend/socket.ts` (`keepSocketTarget(app)` in activate keeps `app.wsUrl`; tests swap it with
  `setWsUrl`). The follow effect depends on `isVisible`, so hiding the tab closes it; a Part is asked for
  by its service's uuid plus `part`. A follow socket that closes on its own is `lost`: retried after
  `RECONNECT_DELAYS_MS` (3, growing), then Reconnect; a 1008 close is `failed` with its reason (no
  retry). Once the effect cleans up (`stopped`), nothing the old socket sends reaches the view.
- Server updates: `src/backend/updates/` (`service.ts` `createUpdates`, `routes.ts`) and
  `src/backend/ops/updates.ts`; the UI is `src/frontend/views/ServerUpdates.tsx` inside the host card.
  `ServerUpdates` remounts its card on `connectionId:serverUuid:revision` (the revision from
  `HostSection`'s connection read), so a changed link drops its answer and any open confirmation; each
  request has a generation (only the newest sets state), and a confirmation keeps the key it was
  opened for and acts only while that key is current.
  Coolify's `patch_check_result` is mapped by `toPatch` in `dto.ts` (an explicit `security_updates: null`
  stays unknown; a `patch_check_error` makes `updates` and `security` null with no items, whatever
  result is left, so the card, Install, the updates signal and the actions never read it as zero). Check and install go through `ctx.operations.invoke` of `package-manager.list-updates` /
  `upgrade-all` when that plugin is active, else SSH (`sshRunner` from `ssh.ts`) with fixed commands built
  from `host-commands` (no request value ever reaches a command; root or `sudo -n`). Reboot is always SSH.
  The plugin list decides the path; when it can't be read, check and install refuse (409
  `companions-unknown`) rather than use SSH. The SSH check reports each step's exit status in a marker
  line (`checkCommand`, its own `LISTING`, not the SDK's, which hides failures); a failed or missing
  refresh or listing is 502 `check-failed`, never zero updates.
  Refresh steps: apt `apt-get update`, dnf and yum `makecache`; pacman has none (`pacman -Sy` alone risks
  a partial upgrade) and lists with pacman-contrib's `checkupdates` (a temporary database; without it the
  check fails). Concurrent checks of one server under the same revision and generation share one run
  (`checks`, keyed by connection, server, revision and generation), so an older run never overwrites a
  newer one.
  A failure on the Package Manager path is reported, never retried over SSH, so that plugin's read only
  setting can't be bypassed. Order of checks (`prepare`): permission (operate, administer to reboot),
  `connections.snapshot(id)` once, the snapshot's grant (operate, configure to reboot), confirm, the
  server read from the snapshot's own client (a uuid that connection's Coolify doesn't have is 404,
  whatever link row is left), Linked host (409 `not-linked`), host share level (connect to check, edit to
  install or reboot; a host access read that throws refuses), then the revision again. The revision is
  checked once more right before every SSH command, Package Manager call and kept-check write (409
  `target-changed`). `UpdateError` has its own statuses (409 for `not-linked`, `host-key` with a fixed
  message, never core's text). The plugin's own last check is kept in `cache` as kind
  `updates:<serverUuid>` with the revision and the per-instance generation (`<epoch>:<n>`, advanced by
  install and reboot) it was read under, and written and served only while both are current.
  Install and reboot, once they reached the server (even when they failed), drop that row, then call
  `servers.invalidate` and `resources.invalidate`. The mock ctx's `hosts.checkAccess`
  only knows hosts given up front, so tests spy on it, on `ssh.exec`, on `operations.invoke` and on
  `plugins.list` (`tests/backend/updates/fixtures.ts`).
- Exec: `src/backend/containers/exec.ts` (`readExecRequest`, `createExec`) and `coolify.exec` in
  `ops/containers.ts`. Remote code execution, so every refusal is before any SSH: `coolify.operate`,
  `allowExec`, the snapshot's `execEnabled`, lifecycle's `authorize` (through `containers.target`), the
  Linked host and the actor's `edit` access to it (checked before `locate`, whose docker probes are SSH),
  then one run per actor and resource (`EXEC_MAX_PER_ACTOR` in all) and `EXEC_RATE_PER_MINUTE`, both in
  memory per process. It runs over `ctx.ssh.connect` (through `containers.guard`, so host keys are core's)
  with `pty: false` and only `execScript` on the channel's stdin (`docker exec -i <name> sh -s`): the
  command is data in a quoted here-document (delimiter with a per-run nonce), run by a shell started with
  `setsid` when the container has it (busybox and util-linux do; no `timeout`, whose flags differ), which
  prints `EXEC_MARK <nonce> <pid>` before the command runs. Only the first stdout line can be that marker;
  it is stripped before redaction and the cap, and a later or wrong-nonce one is plain output. The
  revision is checked right before connect and right before `client.exec`. Output goes through logs'
  `lineSplitter` (redactLog with `snap.secrets()`, key blocks included), then the 64 KB cap;
  the cap, `EXEC_RAW_CAP` per stream, the timeout or the handler's abort signal send KILL and close the
  channel, which ends only docker exec on the host, so `shutdown` then runs
  `docker exec <name> sh -c 'kill -KILL -<pgid> 2>/dev/null || kill -KILL <pgid>'` on the same
  connection (no revision check: it only cleans up what this run started; 5 s cap, a failure only
  logged) and then disposes. A command that
  ended on its own gets no group kill. Without setsid the fallback kills only that shell. The channel open races the timeout and abort; one that opens late
  is closed unwritten. A timeout flushes the splitters (output without a newline yet), masked and capped.
  The PATCH route applies `execEnabled` only after the rest of the update succeeded. `stdout`/`stderr` are sensitive outputs; MCP gets them once through the logs
  handoff store (`takeExecOutput`). MCP refuses exec without `confirmed: true` (`MCP_CONFIRM_REQUIRED`).
  The audit holds only lengths and the exit code. Resources and server-status caches are invalidated
  after a run reaches SSH. `connections.setExec` is owner only and checks `configure` itself.
- MCP may deploy and restart without `allowMcpChanges` (`MCP_CHANGES_EXEMPT` in `mcp/server.ts`).
- Metrics: `src/backend/coolify/mcp.ts` is the client for Coolify's own MCP (`<url>/mcp`, JSON-RPC
  `tools/call`). It is built on a connection's `CoolifyHttp` (`request(..., { mcp: true, text: true })`), so
  it shares the snapshot's headers, transport check, budget and fixed errors; tool answers go through
  `redact()`. Nothing probes it: server metrics try it first and any `CoolifyError` falls back to Sentinel.
  `src/backend/metrics/sentinel.ts` builds Sentinel paths from fixed templates, the uuid through
  `pathParamProblem` (path.ts), and refuses any path outside `/^\/api\/[A-Za-z0-9_/.\-?=&:]+$/` or with
  `..`. The command is `docker exec coolify-sentinel sh -c '<script>' sh '<url>'`: the script reads the
  container's own `$TOKEN` and gives it to curl on stdin (`tests/backend/metrics/sentinel-token.test.ts` runs
  it through a real `sh`). Answers go through `scrubbed()` (maskCredentials plus secret-named fields).
  `metrics/service.ts` reads the connection once per request (`connections.snapshot`). Its Coolify calls go
  through `read.api`/`read.http`, the snapshot's request layer wrapped by `guarded()` so
  `containers.assertSnapshotHolds` is every request's `beforeFetch` (after the budget wait, right before
  the fetch); SSH commands call it first too. Resource reads use
  `containers.target` (lifecycle's `authorize`); the server read over MCP needs view and any access, its
  Sentinel fallback operate and an operate grant. IPs need `traffic_ip_mode` `full` and `canConfigure`
  (coolify.configure plus owner or configure grant); anything else hides them. Traffic `limit` is clamped to
  `MAX_TRAFFIC_LIMIT` (200). Enabling metrics needs `canConfigure` and `confirm: true`; the operation
  `coolify.enable-metrics` is a change and in `MCP_CONFIRM_REQUIRED`. No metrics cache exists.
- Stats socket: `src/backend/containers/stats.ts` (`WS /stats`), separate from the logs socket. One stream
  per socket, one subscribe a second (`rate-limited`), `MAX_STREAMS_PER_USER` (3) per person
  (`too-many-streams`). Each subscribe has a generation; an older one's answer or failure is dropped. A
  subscribe takes a snapshot and `containers.locate`; every tick checks the session, `currentActor()`
  against the socket's user, the snapshot (first and again last, since the checks can wait),
  `containers.target` and host access, then runs `docker stats --no-stream` (4 KB output cap). Refusals close with 1008. The frontend
  opens it with `openSocket` (`socket.ts`); tests mock that module. A `choices` answer shows the Logs
  view's picker (same `logs.pick` texts); the pick lives in `StatsTab`, keyed per resource.
  A socket that closes on its own shows why (1008: the backend's cause under `metrics.live.errors`,
  else `refused`), keeps the last sample marked stale, and offers Reconnect; a lost connection retries
  itself `RECONNECT_DELAYS_MS` (3, growing), a refusal never. A generation ref drops superseded sockets.
- Signals (`src/backend/ops/signals.ts`) read resources from the resources cache and server statuses from a
  `servers` cache kind (a minute, no addresses or keys kept) through `createServerStatuses`, made in
  `index.ts`. That cache works like the resources cache: rows carry `connections.revision(id)` and a
  per-instance generation (`<epoch>:<n>`) that `invalidate` advances, a hit needs both to be current,
  in-flight fetches are keyed by id, revision and generation (invalidate drops them), and a fetch is
  cached only if neither changed while it ran. The degraded
  count is `countResources`, so exited (with any health suffix) is stopped and never counts; bare
  `unhealthy` does. Updates come from Coolify's own patch check (`ServerDto.patch.security`), not the
  updates service's own checks. The deployment events are emitted only by a deploy run with `wait`;
  container-restarted and server-unreachable are declared for later polling.
- Other plugins: `src/backend/plugins.ts` is the one read of `ctx.plugins.list()` (`activePlugins`, null
  when unreadable) and the one table of their ids (`COMPANION_PLUGINS`: docker, sshTerminal,
  packageManager and the companions). Sync, server updates and companions all go through it; each treats
  null as unknown, never as "not running" (sync blocks tunnelled rows, updates refuses with
  `companions-unknown`, companions answer `companions-unknown` 409).
- Companions: `src/backend/companions/` (`detect.ts` `companions(ctx)`, read fresh on every call, the
  frontend's `useCompanions` caches it a minute; `adapters.ts`, the only code that calls another plugin;
  `service.ts`; `routes.ts` with its own `handle` for `CompanionError`) and `src/backend/ops/companions.ts`
  (`coolify.companion-read` for reads, `coolify.companion` for changes, `coolify.companion-dns-remove` on
  its own because it is destructive and is the only call that passes `confirmed: true` downstream, to
  `dns.delete-record`; one `kind` per route). Every service method checks, in order: the Termix
  permission (`ctx.rbac.has`), `connections.snapshot(id)` once and its grant rank (view < operate <
  configure < owner), that the companion runs, a resource from the shared resource cache
  (`resources.get`, a miss checked once fresh, as lifecycle does) or a server path that is linked to the
  connection (`sync.linkedHostFor`, else `not-linked`) and that the snapshot's Coolify still has
  (`snap.api.server`, else Coolify's 404), then for Linked hosts `ctx.hosts.checkAccess(hostId, "view")`,
  failing closed. The adapters reach companions through a `CompanionCaller` whose `before` checks the
  snapshot's revision right before every `ctx.operations.invoke`, and reads check it again before they
  answer, so a target change ends with `target-changed`. A missing companion is a `CompanionError`
  (`companion-missing`, 404, with `plugin`). Log search is `operate` (it shows log output); DNS is
  `configure`. Every companion call is a documented action from the companions' published references
  (docs.termix.site/plugins/<id>/reference), by its id and input names, through `ctx.operations.invoke`;
  `operations.invokes` lists exactly those ids (and Package Manager's) and `optionalDependencies` pins each
  companion to `~` the version its reference documents. The references list no service methods, so no
  service is called and there is no `requires`. They don't describe outputs either: answers are read as
  `{ rows }` lists or `{ value }` host reads, fields picked by name, and a failed run is `companion-failed`
  with a fixed message. DNS: `dns.list-zones` (longest matching zone, its `id` or else its `name`),
  `dns.upsert-record` and `dns.delete-record` take `zone`, `type`, `name`, `content`; the
  `dns_records.handle` column holds exactly those four as JSON text, and removal looks the row up by id,
  connection and resource, so only a record made here can be removed. A stored row is never enough on
  its own: listing and removing first need the resource in the current target's list (`exposed`:
  `resourceOf`, then the snapshot's revision), so a repoint or a narrowed token that hides it, or a list
  that can't be read, refuses before any row is read or any DNS call runs. `holds` also re-checks the
  grant level the call was opened for (`levels`), so a grant lowered mid-way stops it. Create stores the
  row first (`storeRecord`, one in-process queue, read back by exact handle), then calls
  `dns.upsert-record`, and drops only the local row if that fails. Creates and removes for one resource
  run in one queue (`serialized`, per `connectionId:uuid`), and a row whose DNS write is still out is in
  `pendingRows`: not listed and not removable. `dns_records` is #13's only write-ahead row. After a
  create or remove the frontend reads the list again, and only the newest read lands. The DELETE route needs
  `{ "confirm": true }` or `?confirm=true` (`confirm-required`). `listOf` answers companion-failed when an
  answer has no list it knows, so "couldn't read" is never "none". Monitors match by host and path prefix
  (`monitorMatches`); a login by uuid, or by name only when unique among the server's databases.
  `setMonitorsPaused` is the hook for
  pausing Uptime during deploys (ticket #10 decides when); monitors already in the asked state are left alone, and a failure part way sets each monitor it changed
  back to its own state from before (an unknown one is left as it is). Files, Tunnels and Reverse Proxy are ticket #19.
  Nothing here writes host or plugin settings. Frontend: `src/frontend/companions.ts` (`useCompanions`),
  `views/CompanionActions.tsx` (at the end of `ResourceDetail`'s Overview, with `useTabs()` as its shell)
  and `views/HostCompanions.tsx` (inside the host card, keyed by connection, server and `revision`).
  Every CompanionActions part is keyed (React `key` and its state) by `connectionId:uuid:revision`
  (`targetOf`; `CoolifyTab` passes the connection's `revision` through `ResourceDetail`), and Uptime, Log
  Search and Databases read through `useTargetAnswer`, whose request generation drops any answer that is
  not the newest for the current target. `DnsRecords` keeps its rows the same way and drops a confirm
  answered after the view moved to another target or unmounted. Never give a part a constant key: a
  service and its Part would share state. Opening Uptime or Databases uses `openSingletonTab("uptime")`
  and `("databases")`.
