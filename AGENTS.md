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
  host sync turns Coolify servers into locked Linked hosts, Resources can be browsed (Overview tiles,
  the Resources list, a resource's Overview detail), container shells and database consoles open in a
  `coolify-shell` tab, and a resource's Logs view reads and follows container logs.
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
- Host sync: `src/backend/sync/` (`mapping.ts` pure `planHost`, `credentials.ts` key copy, `locks.ts`,
  `service.ts` `createSync`, `routes.ts`) and `src/backend/ops/sync.ts`. `createSync` is async (it loads the
  lock set from `servers.hostId` before providing locks) and is made right after `createConnections`, whose
  `releaseLinkedHosts` hook calls `sync.releaseConnection`. Key material comes only from
  `api.keyForCopy()` (not a DTO) and goes only to `ctx.credentials.createSshKey`; reuse is by fingerprint
  among the connection's `credentialMode = "coolify"` rows. `ssh-keys` from the SDK needs `ssh2`, which only
  Termix supplies, so it is imported lazily and only when Coolify sends no `public_key`. Tunnelled servers
  are refused in `planTunnel` with `TUNNEL_CAUSE` (`needs-tunnel-support`); ticket #9 replaces that seam
  with SSH Terminal's tunnel settings. The SDK tsconfig has no strict null checks, so a boolean `ok` does
  not narrow a union: `HostPlan` names both fields on both sides. The mock ctx's `hosts.create` drops
  `pluginSettings` and `pluginEnable`, so tests spy on the calls to check them.
- Frontend host surfaces: `src/frontend/linked.ts` reads a host's link from its own settings and shares one
  sync preview per connection (five minutes) between badge dots and the host card. The tab opens the sync
  preview from `tab.data` `{ section: "sync", connectionId? }`; `section: "resources"` is for ticket #7.
- Resources: `src/backend/resources/` (service, routes) and `src/backend/ops/resources.ts`. The service
  merges `/applications`, `/services` (each service followed by its Parts) and `/databases`, never
  `/resources`, and caches the merged DTO list in the `cache` table (kind `resources`, 20 seconds) through
  `src/backend/cache.ts`. It checks `connections.access()` before reading the cache, so another user never
  gets a cached row. Concurrent misses share one fetch. `invalidate(connectionId)` is the hook for lifecycle
  actions. `ResourceDto.serverName` comes from `server.name` or `destination.server.name` in the payload.
- Status words: `src/shared/resource-health.ts` (`resourceHealth`, `countResources`) is the one reading of a
  Coolify status, imported by both the backend and the frontend. Exited and unhealthy are degraded; Parts
  aren't counted (their service's status covers them).
- Frontend: `src/frontend/views/CoolifyTab.tsx` owns the SideNav, the selected connection and the shared
  resource list (`useResources`). `ResourceDetail.tsx` lists its views in `DETAIL_TABS`; later views (shell,
  logs, stats) add an id there. Filtering and grouping are pure functions in `resource-model.ts`.
  `contributes.mobile` lists `coolify` and `coolify-shell`.
- Shells: `src/backend/ssh.ts` (`SshRunner` over `ctx.ssh.exec`, `isHostKeyError`) and
  `src/backend/containers/` (`commands.ts` name check, `DB_CONSOLES`, `shellCommand`; `resolver.ts` docker ps
  filters; `service.ts` the checks; `routes.ts`) and `src/backend/ops/containers.ts`. Order of checks:
  resource in the connection's list (connection access), Linked host (`sync.linkedHostFor`, else 409
  `not-linked`), the actor's `ctx.hosts.checkAccess(hostId, "connect")` (else 403 `no-host-access`), then SSH.
  A Grant level doesn't matter for shells; host access does. Container names are refused outside
  `[A-Za-z0-9_.-]` or with a leading `-`; every other value goes through `shellQuote`. Console scripts only
  name the container's own variables and are one quoted `sh -c` argument, so `$` expands in the container.
  Several matches answer HTTP 300 `{ choices }`; the frontend reads choices from a rejected axios call too.
  `ContainerError` has its own statuses (409 for `not-linked`), unlike `ConnectionError`'s 404.
- Shell tab: `src/frontend/views/ShellTab.tsx` reads its tab data `{ connectionId, uuid, part?, container?,
console }`, calls the shell route and draws `PluginComponent id="terminal.view"` with `hostConfig` and
  `executeCommand`; the fallback is a NoticePanel with the command to copy. Picking a container re-asks in
  place. Shell host ids can be strings, so hosts are matched by `String(id)`, not `useHost`.
- Logs: `src/backend/containers/logs.ts` (`readLogsRequest`, `logsCommand`, `createLogs` with `snapshot` and
  `follow`), `sockets.ts` (`WS /logs`) and the `coolify.logs-tail` action in `ops/containers.ts`. The
  containers service exposes `target`, `locate` (every check up to the chosen container, running or not),
  `assertHostAccess` and `guard` (host key errors to `host-key`); shells and logs share them. A snapshot
  uses Coolify's API only with an owner, operate or configure access level and `abilities.sensitive`, never
  for a whole service (Coolify needs one sub-service) or a container picked from SSH choices; a Coolify
  `forbidden-ability` falls back to SSH. The count is capped at 10,000 (`MAX_LINES`), never refused. The
  container name passes `assertContainerName` and is `shellQuote`d, and so is the line count.
- Follow socket: `ctx.asUser` needs `users:impersonate`, which the plugin doesn't have. Core runs a socket's
  events in the opener's actor context (its child runtime wraps them in `als.run`), so each message checks
  `ctx.currentActor() === conn.userId` (refused otherwise), `isDataUnlocked()`, `rbac.has("operate")`, and
  while following, `connections.access` and host connect access. The follow runs `docker logs -f --tail 0`
  over `ctx.ssh.connect` with a pty, so closing the channel hangs it up; stop sends KILL, closes the channel
  and disposes. Lines are batched every 250 ms, at most 500 a batch and 2,000 buffered (older ones dropped
  with a `dropped` count). Tests drive the handler from `mock.wsRoutes` with a fake socket and must
  `setActor` to the socket's user, as core does.
- Logs view: `src/frontend/views/LogsView.tsx` in ResourceDetail's `logs` tab (only with `coolify.operate`).
  It opens the socket through `src/frontend/socket.ts` (`keepSocketTarget(app)` in activate keeps
  `app.wsUrl`; tests swap it with `setWsUrl`). The follow effect depends on `isVisible`, so hiding the tab
  closes it; a Part is asked for by its service's uuid plus `part`.
- There is no log redactor yet: `redact` doesn't exist in the code, so log text goes out as docker or
  Coolify wrote it. Task 18A's redactor should be applied to both the snapshot and the follow.
