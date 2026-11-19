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
  started, stopped and restarted, and host sync turns Coolify servers into locked Linked hosts.
  The design is in `docs/superpowers/specs/2026-11-19-coolify-plugin-design.md` and the build plan in
  `docs/superpowers/plans/2026-11-19-coolify-1.0.md`.
- Coolify calls: `src/backend/coolify/http.ts` is the only way to Coolify (ctx.fetch, Bearer and CF Access
  headers, `redirect: "manual"`, 150 requests a minute, GET retries, every failure a `CoolifyError` with a
  `CoolifyCause`). `toRouteError` sends fixed messages only, never what Coolify sent back, because Coolify can
  echo a token. `/version` and `/health` answer `text/html`, so they use `{ text: true }`; any other HTML
  body is `not-coolify`. `dto.ts` picks fields by name (no spreads), `api.ts` calls paths from `OPERATIONS`.
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
  `EXCLUDED_OPERATIONS`). `docs/coverage.md` must list every operation; `tests/backend/coverage.test.ts`
  enforces it. There are no generated schema types: openapi-typescript needs a TypeScript 5 alias, and the
  registry CI's lockfile-lint (`--validate-package-names`) rejects npm aliases. DTOs are written by hand.
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
- Status words: `src/shared/resource-health.ts` (`resourceHealth`, `countResources`) is the one reading of a
  Coolify status, imported by both the backend and the frontend. Exited is stopped, whatever its health
  suffix. Degraded covers degraded, restarting, dead and unhealthy, as a state (`unhealthy`) or a suffix
  (`running:unhealthy`). Parts aren't counted (their service's status covers them).
- Frontend: `src/frontend/views/CoolifyTab.tsx` owns the SideNav, the selected connection and the shared
  resource list (`useResources`). The list is keyed by the connection's id and `revision` (the same
  non-secret hash, also on `ConnectionView`), and `ConnectionsView`'s `onSaved` puts a saved row back into
  the tab, so editing the selected connection's target clears and reloads it. `ResourceDetail.tsx` lists its views in `DETAIL_TABS`; later views (shell,
  logs, stats) add an id there. Filtering and grouping are pure functions in `resource-model.ts`.
  `contributes.mobile` lists only `coolify` until the `coolify-shell` tab is registered.
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
- MCP may deploy and restart without `allowMcpChanges` (`MCP_CHANGES_EXEMPT` in `mcp/server.ts`).
- Signals (`src/backend/ops/signals.ts`) read resources from the resources cache and server statuses from a
  `servers` cache kind (a minute, no addresses or keys kept). The degraded count is `countResources`, so
  exited (with any health suffix) is stopped and never counts; bare `unhealthy` does. Updates come from
  Coolify's own patch check (`ServerDto.patch.security`) until the updates service exists. The deployment
  events are emitted only by a deploy run with `wait`; container-restarted and server-unreachable are
  declared for later polling.
