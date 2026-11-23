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
  Where things stand: the plugin is at 1.0.2 (1.0.0 was its first release). It holds connections, resources and
  lifecycle, host sync, shells, logs, exec, metrics, server updates, companions, status pages, deployments,
  previews and rollback, recent activity, the activity panel, dashboard cards and homepage widgets, the
  event pipeline and event log (#89), the poller (#90), the team webhook (#91) and its one-click setup
  (#92), alerts with per-person preferences (#93), the Events section (#94), the full Coolify API, the MCP
  endpoint and the `coolify.client` service. The read-only smoke test against a real Coolify is the owner's
  (`scripts/smoke-readonly.md`). User docs: `docs/index.md`, `tunnels.md`, `permissions.md`,
  `companions.md`, `troubleshooting.md`, `api.md`, `coverage.md`.
  The design is in `docs/superpowers/specs/2026-11-19-coolify-plugin-design.md` and the build plan in
  `docs/superpowers/plans/2026-11-19-coolify-1.0.md`.
- Own registry (`docs/registry.md`): `.github/workflows/registry.yml` runs `scripts/registry-index.mjs`
  (pure rules in `scripts/registry-lib.mjs`, tests in `tests/backend/registry/`) and pushes `index.json` to
  the orphan `registry` branch. It copies Termix-Registry's `scripts/sync.mjs`/`lib.mjs` rules (gated by
  `engine.termix` against 26.10.2, betas only above stable) and refuses the whole index on any failed
  signature, manifest or provenance check. `registry/public-key.txt` is the owner's (key id
  `d07bfdc9da00b6e7`, pinned by a test); never generate or commit a key, a private one least of all.
  Releases made by Release don't fire `release` events (workflow token), hence the hourly run. Its
  `--if-changed` shortcut skips only when `inputs.json` on the branch equals every input verification reads
  and every release field the index shows (per release its `releaseFacts` and three asset digests;
  repository, key, `first-version.txt`, tooling hash, published index hash). `readRelease` sees a release
  only through `releaseFacts`, so a field the index starts using lands in the record; a new input to the
  checks must join it too. Each release needs exactly one `.tmxplug`, named `coolify-<tag version>.tmxplug`.
  After a key rotation, `registry/first-version.txt` leaves out releases the old key signed.
- Completeness tests: `authz.test.ts` (every route and socket has an `authz.json` entry, and no stale ones),
  `route-parity.test.ts` (docs/api.md's "Route map" lists exactly the served routes and sockets, each with
  a declared action or `none: <reason>`, and every route an action's row names is served and maps back),
  `api-docs.test.ts` (one row per declared action with route, run path, scope, MCP tool and a runnable
  `curl` whose JSON holds every required input), `mcp/server.test.ts` (one tool per action plus
  EXTRA_TOOLS) and `coverage.test.ts`. A new route needs a Route map row and an authz entry; a new action
  needs an api.md row.
- `coolify.client` (`src/backend/service.ts`, provided in `activate` with `ctx.services.provide`, declared
  in the manifest's `provides` with `coolify.view`). The manifest's `sandbox` block has no slot for
  services (its `registry` is for `ctx.registry.provide` only). Each method is one `ctx.operations.run`
  with `via: "service"`; it checks the action's own permission with `ctx.rbac.has` first (the mock ctx's
  run applies no gate) and refuses a destructive action without `{ confirmed: true }`, then passes
  `confirmed` on. Answers go through `redactFields(outputs)`, `redact()` and a JSON copy; `logsTail` takes
  the redacted text from the logs handoff once, like MCP. Nothing in it reaches Coolify directly.
- MCP `list_hosts` takes `connectionId`, runs `coolify.sync-preview` and keeps the rows with a `hostId`.
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
  an unreachable URL. Another user's connection is always 404. Only owners reach a connection; the
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
- Tests and time (#105): no test budgets milliseconds; a busy machine failed them with nothing wrong.
  Linear-time checks use `growth()` (`tests/shared/linear-cost.ts`): the same call on an input 8 times as
  long, timed by the thread's CPU time (which steps in 4 ms ticks on some kernels, so sub-samples run
  10 steps), must cost less than 24 times as much (linear about 8, quadratic about 64). storagePaths
  can't take a longer path (4096 cap), so it compares against a 32nd (`growth(at, 32)`, bound
  `linearLimit(32)` = 96). One sample never decides a check (#124): a pause on the thread (a major
  GC, a deopt) counts as its CPU time. Each of up to three tries takes the median of three
  interleaved sub-samples per size, the best try of each size counts, and only a pass stops early;
  a failure takes every try. `tests/shared/linear-cost.test.ts` (run with the backend tests) checks
  that one paused call reads a linear call as linear and a quadratic one as quadratic.
  `LINEAR_COST_LOG=1` prints each check's growth and CPU time (vitest `--silent=false`). Waits use `WAIT_MS` (`tests/shared/timing.ts`): `eventually()` for vi.waitFor, and `tests/frontend/setup.ts` (loaded by
  `vitest.config.ts`) for every findBy and waitFor. Tests with heavy fixed work or a real timer in the
  code take `HEAVY_TEST_MS`. A fixed sleep is only for checking that nothing happened.
  `tests/backend/wall-clock-guard.test.ts` refuses `performance.now`, `expect(Date.now()`, `vi.waitFor`,
  short `timeout:` options and a per-file `asyncUtilTimeout`.
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
  is confirmed and the actor has `coolify.operate` and an operate grant; when it does come back, every
  string under a log field goes through `redactLog` (`redactLogFields`) with the snapshot's secrets, as
  container logs do. Revealing a log field needs
  `coolify.operate` too. A server transfer's status stays operate by hand (its schema has no log field).
  `authorize` also applies `tokenAllows` (`token-ability`, 409), and `send` passes `beforeFetch` so the
  request layer checks the revision again after its budget and retry waits, right before each fetch.
  The console drops late answers with request generations (reveal, operation list, connections).
- Scanner hygiene (#84): trim a trailing run with `trimTrailing` (`src/backend/text.ts`), never `/x+$/`
  (quadratic on a long run that isn't at the end); an unanchored `A.*B` or `x+y` regex rescans from every
  start, so use index scans or a pattern that can only start once (`isTaskRunPath` in
  `ops/api-generic.ts`). Every sort takes a compare function: `byText` (`tests/backend/helpers/order.ts`)
  in tests, `byCodeUnit` (`scripts/registry-lib.mjs`) in the scripts, both the order `sort()` gives without one. Use
  `Number.NaN` and `Number.parseInt`, not the globals. `tests/backend/linear-regex.test.ts` times each
  rewritten site on a hostile input.
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
  that finishes after a change is not cached. A read answers only for the revision it started under
  (#123): a fetch that ends after a change rejects with `target-changed` for everyone sharing it, and
  `load` (behind `list`, `get`, `byServer`, `counts`) checks the revision once more with
  `stillAt` (`connections/hold.ts`, also behind `forRevision`) when its rows are in, so a caller that
  joined a fetch or read the cache just before a repoint gets 409, and a removed connection 404. Rows
  from before an invalidate are still the right target: they answer, uncached. `refreshUnattended`
  swallows `target-changed` (nothing cached, no status-page back-off); `readUnattended` lets it through
  and the poller starts again from a baseline. Concurrent misses share one fetch. `invalidate(connectionId)`
  is the hook for lifecycle actions: it advances an in-memory per-connection generation, drops the
  in-flight fetches and the cached row. Cached rows carry their generation too, and a hit needs both the
  revision and the generation to be current, so a write that lands after the drop is never served.
  Generations are unique to each `createResources` instance (`<epoch>:<n>`, the epoch a random uuid), so
  after a restart no row an old instance wrote matches and the cache starts cold.
  The `cache` table (`src/backend/cache.ts`, shared by resources, server statuses and kept update
  checks): a write is a delete then an insert under the unique (connectionId, kind) index, which on
  Postgres or MySQL two overlapping batches of one key can both pass and then collide on (#120). So
  `write` and `drop` of one `connectionId:kind` run one at a time in call order, in an in-process
  queue entered before any await and shared by every `createCache` over the same table (a WeakMap on
  the table object). A `drop` with no kind waits for every queued write and drop of that connection,
  and anything of that connection called after it waits for it. Like the other locks this relies on
  one backend process per Termix server. `write` never rejects: a failed write is logged by its
  error's name only and the read that produced the value still answers. An invalidate's drop now
  lands after a write already queued, so the generation check is the second guard, not the only one.
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
- Toolbar status: `src/frontend/toolbar-status.ts` fills the `terminal.toolbarStatus` data slot (row key is
  the tab id). It finds the tab with `useShell().tabs.list`, answers only for `coolify-shell` tabs (parsed
  with `shellTabData`), and reads statuses from `createStatusFeed`: one `listResources` read per connection
  (the backend's 20 second cache) shared by every tab, read again `STATUS_POLL_MS` after each answer (a
  `setTimeout` chain, so a slow read is never overtaken and dropped) while a tab shows it, and dropped when
  the last one goes. The label is the container the tab connected to: `ShellView` runs in its own frame, so
  it sends `{tab id, keyOf(tab data), container}` to the background frame with
  `invokeAction("coolify.shell-target")` (`SHELL_TARGET_ACTION`), held in `createShellTargets`; an entry
  counts only for the current tab data's key, and a clear only removes an entry with its own key. A uuid missing from the list shows "Gone"; a failed read shows nothing.
  The hook runs in the background frame, so the feed is made in `activate`, not in a view. Its test mocks
  `useShell` because the SDK's test host has no shell.
- Locale templates: `fill(template, values)` in `src/shared/template.ts` is the one way to fill a
  `{{key}}` template: one pass with a callback, so `$&`, `$1`, `$$` or a `{{...}}` inside a value (a
  resource or server name) is kept as it is and never filled again. Recent activity, the deploy and
  rollback dry runs and the status page (`fillHtml` escapes each value, then calls `fill`) use it.
  `String.prototype.replace` with a string value expands `$` patterns, and chained calls refill earlier
  values; `tests/backend/template-fill.test.ts` fails on any `.replace`/`.replaceAll` of a `{{` literal in
  `src/` outside that file. The frontend's `t()` is core's i18next, which splices values in and skips
  inserted text (`skipOnVariables`, on by default).
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
- Confirms: `src/frontend/confirm.ts` is the only code that asks. A view calls
  `useConfirmFor(target)`, never the SDK's `useConfirm`; its `confirm` answers false once the view
  unmounted or `target` (what the action acts on: connection, uuid, revision, host link) is not the one
  of the render that asked, and `still(forTarget)`/`isMounted()` guard the view's other awaits.
  `useLifecycle(connectionId, onChanged, target)` takes its caller's target. Outside a view (the host
  menu's Unlink, in the background frame) `confirmOnApp(app, options, holds)` asks `app.confirm` and
  then `holds()`: Unlink reads `app.listHosts()` again and sends nothing unless the host still has the
  link it was opened for (a failed read sends nothing). `tests/frontend/confirm-guard.test.ts` scans
  `src/frontend` and fails on any `useConfirm`, `.confirm(` or `confirm(` not bound from the helper.
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
  unlocked and deleted (`discardHost`). Coolify's `GET /servers` has no `private_key_id`
  (only `GET /servers/{uuid}` does; the specs list neither), so `withKeyIds` reads each server without
  one, only when keys may be copied, and a failed read leaves it unknown. Before 1.0.1 every server
  asked for a picked credential because of it, so a stored pick (`credentialMode = "termix"`) yields to
  the copied key whenever the copy succeeds; a pick sent in that apply is always used. Key material comes only from
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
  the host is left untouched. Plain hosts that were never tunnelled get no SSH Terminal settings. `servers.viaTunnel` (migration 0005) is
  the owner's **Reach through a Cloudflare tunnel** for a server Coolify reaches directly (its own host:
  Coolify must keep reaching itself without Cloudflare, so its own flag is never set). It sends the row
  through `planTunnel` like Coolify's flag, with the address override as the hostname (`needs-address`
  without one, never Coolify's address); the sync service treats `isTunnel || viaTunnel` as tunnelled
  everywhere it checks, and turning it off clears the tunnel through `tunnelApplied` as usual. `pluginEnable.docker` is only ever true and only
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
- Host dot and host action: the badge's `useDot` runs `useHostDot` (`src/frontend/index.tsx`,
  over `useHostProblem` in `linked.ts`). It reads
  `GET /connections/:id/server-health`, cached a minute per connection in the frontend
  (`cachedServerHealth`); the route answers from the backend's shared server statuses (`ops/signals.ts`,
  a minute) and resources cache (20 seconds), so many host rows cost one request and at most one Coolify
  read per list. Degraded counts use `countResources` (Parts left out, `exited` is stopped). The dot goes only
  through `useDot`, which the layout merges with other plugins' dots (PLUGIN-GUIDE.md). Don't add a
  `registerHostStatusIndicator` for it: a layout could draw a second dot. The "Coolify" host action and the Resources menu item open the tab with `serverUuid`, which
  `CoolifyTab` turns into a clearable server filter on Resources (cleared by a connection pick, Sync
  servers and an Overview tile).
- Host data slots (#96): `src/frontend/host-slots.ts` fills `dashboard.hostRow` (stat: running,
  degraded, stopped), `dashboard.hostRowBadge` (a Deploying badge while the server has deployments) and
  `homepage.hostMetrics` (bars: container CPU of the host's CPUs, memory of its memory). Rows and badge
  read `server-health` through `useServerHealth(api, link)` (`linked.ts`): the per-connection
  `cachedServerHealth`, read again every `HEALTH_MAX_AGE_MS` while the row is mounted, keyed by the link
  (a late answer for an old link is dropped), nothing without `coolify.view` or for an unlinked host, and
  nothing for a server the target's server list no longer has. `server-health` is built by
  `resources/server-health.ts` (`createServerHealth`, also behind `coolify.host-summary`): servers,
  resources and `deployments.queue` in parallel, `counts` by `countResources`, `deploying` = the server's
  resources (no Parts) with a running queue row or a deploying status; the reads run inside
  `forRevision` (`connections/hold.ts`), so an answer never mixes targets (`target-changed`). The dot still
  reads it once per mount (unchanged). Metrics: `homepage.hostMetrics` context has only `hostId`, so the
  host comes from `useHost` (shell ids are strings) and the read needs `usePermission("operate")` and
  `online !== false`. `createHostStatsFeed` batches every shown server of a connection into one
  `GET /connections/:id/host-metrics?servers=a,b` (20 a request), polls `HOST_STATS_POLL_MS` after each
  answer while any row shows it, and drops a server's value with its last row. The backend's
  `metrics.hostStats` checks `coolify.operate` and an operate grant first (403), then per server: Linked
  host (`not-linked`), connect access, then a cache keyed by connection, server and revision
  (`HOST_STATS_TTL_MS`, 30 s, never below the stats socket's `STATS_INTERVAL_MS`; concurrent misses share
  one read), else the server in Coolify, the sudo probe and one `hostStatsCommand` (`docker info` CPUs and
  memory, then `docker stats --no-stream` for all containers), each behind `read.holds()`. Per-server
  failures go in `errors`; a target change or a cut grant fails the whole request. `readHostStats` is a
  `parses` entry in `tests/backend/log-exits.json`. `coolify.host-metrics` is the host action over it.
- Frontend host surfaces: `src/frontend/linked.ts` reads a host's link from its own settings and shares one
  sync preview per connection (five minutes) with the host card. Each cached preview
  records the revision it was read for; `useLinkedRow(link, revision)` (the host card passes the
  connection's) refetches when it differs, and a dot, which has no revision, takes the newest one.
  `SyncView` keys its preview on the connection's id and `revision`: a change clears rows, drafts and
  results and loads again, and a request generation drops a late answer. The host card shows the
  tunnel line from the row's `tunnel` flag and opens the host editor with `shell.editHost`.
  Terminal companion: `app.registerCompanion("coolify", TerminalCompanion, { tabTypes:
["terminal"], when: isLinked })` in `src/frontend/index.tsx` (the core id is `coolify.coolify`; not the
  backend's `companions/`, which is about other plugins). `views/TerminalCompanion.tsx` draws nothing and
  asks nothing without a link; otherwise its body is keyed by `connectionId:serverUuid`, so a host change
  remounts it and the old host's answers land on an unmounted view. It reads the connection (access,
  revision), then `useResources` filtered to the server. Actions need `coolify.operate` and
  `OPERATE_ACCESS`; Shell uses `openShellTab` (ShellTab.tsx, shared with CoolifyTab), Logs draws
  `LogsView` in the panel, Restart and Deploy confirm and then call `useLifecycle().run` only while the
  view is mounted and on the target the confirm was opened for (`mounted`/`current` refs, as RollbackView).
  Refresh (and `isVisible` turning true) bumps `attempt` (reads the connection again) and reloads the
  list. Tests draw the
  registered component through `renderCompanion` (tests/frontend/helpers.tsx): the SDK test host has no
  companion renderer, and SDK hooks only work inside a registered component.
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
  in-flight fetch from before the action is dropped. A waited deploy ends on every final status in
  `src/shared/deployment-status.ts` (`isFinalDeployment`; Coolify's `isFinal()` counts `skipped`). Only
  `isSuccessfulDeployment` (finished, or the older success) emits deployment-finished; every other final
  status emits deployment-failed and throws `DeploymentFailedError`, whose code is `skipped` (with its own
  message in words) for a skipped deployment and `deployment-failed` otherwise. `waitFor` is the only
  deployment wait (deploy by tag, rollback and previews don't wait); it answers the last status when it
  reaches `MAX_WAIT_MS` (30 minutes, timed with `Date.now` and `setTimeout`, so vitest fake timers drive
  it). A status that isn't final then throws `DeploymentFailedError` with code `wait-timeout` (last status
  in words, the plugin's own deployment route as the link, applications only) and emits no event. The
  lifecycle routes map it, thrown or as core's outcome, to 504 `wait-timeout`. Recent activity is
  recorded once, at accept, before the wait. That module is the one reading of a deployment status
  (final, cancellable, succeeded, failed, skipped, Coolify's own spellings);
  `tests/backend/deployment-status-guard.test.ts` fails on a `status === "<spelling>"` comparison or a
  `new Set([...])` of spellings anywhere else in `src/`.
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
console, revision? }`, calls the shell route and draws `PluginComponent id="terminal.view"` with `hostConfig` and
  `executeCommand`; the fallback is a NoticePanel with the command to copy. Picking a container re-asks in
  place; after a failed pick, Change container clears it and asks for the choices again (Retry keeps it).
  `ShellView` is keyed by `keyOf(tab data)` (resource, part, console, container, revision; CoolifyTab's
  `openShell` and the terminal companion pass the connection's revision through `openShellTab`), so new
  tab data starts with no pick, and loads carry a request generation. Shell host ids can be strings, so hosts are matched by `String(id)`, not `useHost`.
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
- Log exits: `tests/backend/log-exits.json` (loaded by `tests/backend/log-exits.test.ts`, its shape checked
  by `parseLogExits` and the source audited by `tests/backend/helpers/log-exits.ts`; JSON because the
  table as TypeScript failed SonarCloud's duplication gate) lists every backend function that touches log or command text (Coolify log reads, `docker logs`, SSH
  channels and `.stdout`/`.stderr`, Log Search, the generic API's `LOG_FIELDS`, Package Manager's upgrade)
  and what it does with it. An `exit` must call `redactLog` or a helper built on it (`redactLogFields`,
  `keyBlockCarry`, `lineSplitter`, `redactLogStream`, `buildLog`); a new read of log text anywhere else
  fails until it is listed. Function spans come from prettier's layout; the innermost function around a read (or a feeder's call) decides, so a nested helper is registered on its own. A `pending` entry (an exit known to
  skip the redactor; none today) fails once it calls one, so it becomes an `exit`. `reveal` is
  deliberately `unredacted`.
- Log redaction: every snapshot text and every followed line goes through `redactLog`. It first masks
  every private key block's body (`maskKeyBlocks`: several on a line, escaped `\n` or real newlines, and a
  block without END to the end of the text; linear `indexOf` scans). `lineSplitter` keeps a block opened
  by one line open (`keyEnd`) and drops the body lines until its END, and `openSecretStart` counts an open
  block, so a long-line cut never splits one. The tail rule (#81): a tail cut (`--tail`, `?lines=`, a
  follow at now) can start inside a key, so an END that no BEGIN before it opened (`lastLoneKeyEnd`)
  masks everything from the start of that text up to it, and what follows is untouched. `maskKeyBlocks`
  applies it to every text `redactLog` gets; `maskKeyTail` applies it across texts in order (buildLog's
  commands and outputs); `lineSplitter` holds a stream's first lines while its last line is shaped like
  a key's body (`mayBeInKey`: 64/70/76-wide base64, a PEM header or blank line, a short line first or
  after a wide one; a `docker logs --timestamps` prefix is ignored) or a partial line is pending, up to
  `KEY_HOLD_MAX` (32 KiB), then applies it to everything held. A key interleaved with other lines in a
  live follow can still pass once a non-key line settles the start. `safeCut` compares its windows with
  `redactSlice` (no tail rule): a window's start is not where the log starts, and the rule there only
  refused good cuts. Then the snapshot's own
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
  property test in `logs.test.ts` streams mixed secret shapes 1–5× MAX_LINE long in random chunks. Its
  work is fixed by the seed; only wall time grows with load, so it has its own 120 s timeout (#75), not
  Vitest's 5 s default.
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
  `servers.invalidate` and `resources.invalidate`. Install's `output` (Package Manager's or SSH's) goes
  through `redactLog` with the snapshot's secrets before its last 4,000 characters are kept. The mock ctx's `hosts.checkAccess`
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
  the fetch); SSH commands call it before and after. `holds` also checks the actor's live
  `connections.access` against `read.need` (operate for Sentinel, owner/configure for the PATCH), since a
  grant change doesn't change the revision. Resource reads use
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
  cached only if neither changed while it ran. A fetch that ends after a repoint rejects with
  `target-changed` and `list` checks the revision again when its answer is in (#123), so every signal
  catches it and reads unknown, never the old target's state or a zero; `coolify.signal-deploying` is
  unknown only when no connection could be read (the others still add up). The activity panel
  (`attention/service.ts`) also checks each connection's revision against the one it was listed with
  once every part is in, and shows `target-changed` with no rows when it moved. The degraded
  count is `countResources`, so exited (with any health suffix) is stopped and never counts; bare
  `unhealthy` does. `coolify.updates` takes the newer (`newestSecurity`, parsed timestamps, an unparsable
  one counts as oldest) of Coolify's patch check (`ServerDto.patch`) and the updates service's own last
  check (`updates.lastCheck`: the `updates:<serverUuid>` cache row, served only under the current revision
  and generation, as in `status`); a signal never runs SSH or calls Coolify beyond the servers cache.
  A deploy run with `wait` hands its deployment's end to `events.ingest` (lifecycle.ts, source `poll`,
  with the revision read before its client: a change in between drops the event), so it and a poll of
  the same deployment are one event (dedupe by deployment uuid); the pipeline adds the Linked host from
  the resource's server. The poller reads servers through `listUnattended(id, snap)`, the same cache
  and keys as `list`.
- Poller (#90): `src/backend/poll/` (`service.ts` `createPoller`, `diff.ts` pure `diffPoll`),
  made in `index.ts` after `createServerStatuses` and started after the status pages. The
  `coolify-poll` job (60 s, 10 s jitter, in `sandbox.schedules`) polls each connection at most every
  `max(60 s, minPollSeconds)` (a success's next time is that minus the jitter, so an early tick counts),
  and backups and scheduled tasks at most every `SLOW_POLL_MS` (5 minutes, strict). Which connections
  poll (`polling()`): none while `allowPolling` is false; otherwise every connection
  (`connections.pollTargets()`, no access check, nothing returned) unless its `instanceKey` has a
  `webhooks` row with `lastReceivedAt` set (#91 sets it) and `pollEnabled` is false, and only while
  `ctx.rbac.hasFor(owner, "view")`. `keepAwake("coolify polling", any)` follows that list on every tick
  and on `connections`' `changed` hook (create, remove, `setPoll`; awaited, failures only logged), so
  a new connection wakes core. Step order of one connection's poll (`pollOne`): its backoff time,
  `connections.unattendedSnapshot(id)` once (gone: forget), the owner's view (else forget), then the
  reads, each through that snapshot: `resources.readUnattended` (the 20 s cache), `deployments.
queueUnattended` (the 10 s queue cache, running plus recent, its `revision` source the snapshot's),
  `servers.listUnattended`, and when due the backup runs of each database and the runs of each enabled
  scheduled task of the first 50 applications and services (at most 50 tasks). Token scope: a
  `forbidden-ability` on the queue (or its history), on servers or on one resource's backups, tasks
  or task runs makes that part unread (`null` in `PollRead`, or the resource in `RunsRead.refused`):
  what was seen of it stays and it sends nothing, never "gone" events. A scoped connection
  (`unattendedSnapshot().scoped`, the probe's flag) is never asked `/servers`. A resource's
  `not-found` is an empty list. Only the resource lists failing fails the poll for scope; every other
  error fails it. Unread deployments keep their own `deploymentsReadAt`, so the unseen-deployment
  window doesn't skip them. Every request is guarded: the resources fetch (all three lists) and the
  servers fetch check their own source revision in `beforeFetch` (for actor reads too), the queue and
  the run reads take the poll's guard (`holds`: revision and the poller's generation), so a removal
  or repoint during a budget or retry wait sends nothing more; `holds` is also checked after each
  read; then the last `holds`, the diff, one
  `events.ingest` per change with the snapshot's revision (a `dropped` other than `invalid` forgets
  and stops), `holds` again, and only then the seen state and timing are kept. What was seen is in
  memory per connection with the revision and a per-instance generation (`<epoch>:<n>`, advanced by
  `forget`): a state from another revision or generation is not used. Startup must not flood: the
  first poll of a connection (after a start, since the state is only in memory; after a repoint; after
  polling stopped for it, its owner lost view or `changed` ran) is a baseline that records everything
  and emits nothing; changes while nothing polled are lost by design, so a restart never replays
  history. After a baseline, an unseen deployment or run counts only when it ended within
  `CLOCK_SLACK_MS` (5 min) before the last poll or later (older history that comes into the recent
  window is not news). Statuses of top-level resources only: entering `restarting` is read from
  Coolify's raw word (the seen state keeps `statuses`), so `running:unhealthy` to `restarting` (both
  degraded) is still `container-restarted`, and only that event; other changes compare
  `resourceHealth`, deploying is no change (the last settled health stays), and any other change is
  `status-changed` (a kind this ticket added, `fields` `from`/`to`). Servers: reachable to
  unreachable is `server-unreachable`. A `target-changed` anywhere forgets and is not a failure;
  any other error keeps the last state (the next success diffs against it and catches up) and backs
  off `POLL_BACKOFF_MS` 1, 2, 5, 15 minutes counted from `now()` when the failure is handled (not the
  tick's start), with the cause id (`CoolifyError.cause`, else
  `upstream`) as the connection's `pollError` (through `ConnectionsOptions.pollError`, in memory, not
  `lastError`, which stays the probe's). A success clears both. One tick runs at a time.
- Event pipeline (#89): `src/backend/events/` (`kinds.ts`, `service.ts` `createEvents`,
  `routes.ts`) and `src/backend/ops/events.ts`. It is the only writer of the `events` table and the only
  emitter of the `coolify.<kind>` operations events; the poller (#90) and the webhook (#91) feed it, alerts
  (#93) and the event log view (#94) read it. The source interface, made in `index.ts` right after
  `createResources` and passed to whatever feeds it:
  `events.ingest(connectionId: number, event: SourceEvent, read: { revision: string }): Promise<IngestResult>`.
  `SourceEvent` is `{ kind, source: "poll" | "webhook", resourceUuid?, serverUuid?, deploymentUuid?, taskUuid?,
name?, status?, at?, fields? }`; `revision` is `connections.revision()`/the snapshot's, as the source
  read Coolify. `IngestResult` is `stored` (with the `EventRecord`), `duplicate`, or `dropped` with
  `invalid`, `connection-gone`, `target-changed` or `no-access` (owner lost `coolify.view`). It needs no
  actor (it uses `connections.unattendedSnapshot`, which also gives `secrets()`) and throws only when the
  database or the emit fails, and then keeps nothing that makes a retry a duplicate. A row is inserted
  with a pending key (`pending|<nonce>|<key>`, which neither the dedupe lookup nor the log read matches
  and the nonce keeps off the unique index) and gets its real `dedupeKey` (`store.commit`) only after the
  emit. Step order: sweep, connection check, owner view, clean, dedupe lookup, insert pending, read-back,
  prune, persist, then `linkedHostFor`, then the last check `current()` as the very last await, then the emit
  with no await between, commit, persist. A failed last check deletes the pending row and answers
  `dropped` with its reason. `store.commit` answers how many rows it updated (read back by the new key, as
  no dialect reports affected rows alike); 0 means a removal (under the connections lock, not this queue)
  deleted the row after the emit, and the answer is `dropped`/`connection-gone`, not `stored`, though the
  event went out. Every step after the insert shares one catch that deletes by `(connectionId, [pendingKey, dedupeKey])` and rethrows. If
  that delete fails too, the pending row stays, unlisted and ignored, and the next ingest for the
  connection sweeps it (`store.sweep`): fail closed, a retry may send again but is never suppressed. The
  table steps are `createEventStore` (deps.store), so tests make each fail once. Kinds live in `EVENT_KINDS` (kinds.ts) with their subject (`resource`, `server`,
  `any`, `team`), severity and log title; each is declared in the manifest as `coolify.<kind>` with scope
  `server` (hostId only when Linked, so no event needs one) and the payload `PAYLOAD_KEYS[subject]`; a
  test checks both lists and every emitted payload's keys. A new kind adds a row there, a manifest event
  and its `ops.events.*` locale. Dedupe: `deployment|<deploymentUuid>` when there is one (one event per
  deployment, whatever its kind), else `task|<kind>|<taskUuid>|<minute>` for a task run, else `<kind>|<resourceUuid or serverUuid>|<minute>`, the minute from
  the source's `at` unless it is missing, invalid or more than a minute ahead of the clock (then the
  pipeline's `now`). The key is the `dedupeKey` column with a unique `(connectionId, dedupeKey)` index
  (migration 0003 hand-adds it: the generator writes no index for an existing table); ingests for one
  connection run one at a time in memory (single process, like `withLock`), so read, insert and prune
  never interleave. Pruning keeps the newest `EVENT_LOG_LIMIT` (1000) per connection by id, never createdAt (ids
  only grow, so the row just written is never pruned; `prune` also excludes its id). Removing a
  connection deletes its events in `removeNow`'s batch; hostId is
  `sync.linkedHostFor(connectionId, serverUuid)` read right before the last check (an unlink or host.deleted doesn't
  change the revision) and written at commit, so a resource event needs its server's uuid from the
  source. Redaction: uuids must match `^[A-Za-z0-9_-]{1,128}$` (else `invalid`); `name` and `status` go
  through `redactLog` with the connection's own secrets, then keep their first line, capped (255, 64);
  `fields` keeps at most 20 top-level scalars with plain names, drops log-shaped names (any name ending in `log`,
  `logs`, `output`, `stdout` or `stderr` in any case, like `backup_log`, `deploymentLogs` or
  `commandoutput`, except plain words in `NOT_LOG_FIELDS` such as `catalog` and `dialog`) and nested values, runs `redact()` (secret keys) and then each string
  as `name`, capped at 500. The read is `events.list(connectionId, { limit, before, kind, uuid })`
  (a list or other non-scalar is 400; the route refuses a repeated query key rather than ignore it)
  (coolify.view, any access, another user's 404), answering `{ rows: EventRecord[], nextBefore }` newest
  first, paged by id. Grant rule (#94): grants are connection-wide levels with no resource scope, and a
  grant lends the owner's token, so a grant covers what the connection's Coolify has now. The owner
  sees every row and Coolify is never asked; anyone else gets `grantRule` (service.ts): a resource row
  needs its uuid in `deps.subjects.resources` (the shared resources cache, Parts included), a server row
  its uuid in `deps.subjects.servers` (the server statuses cache), `any` rows the resource when they name
  one, else the server, and team rows always pass. A row naming no subject it needs is hidden. Each list
  is read once per call and only when a row needs it; a failed read throws (Coolify's cause, usually
  502), so a grantee never gets a silently partial log. The resources and server lists answer only for
  the revision they started under (#123: a move mid-fetch is `target-changed` from the list itself);
  a granted read still runs whole (lookups, scan, page) inside `forRevision` (connections/hold.ts), and `grantRule`'s
  `holds` checks the revision the read started under before and after each lookup (a lookup that threw
  after a move is target-changed too): a list from an old target never authorizes a row, and a move
  mid-read is 409 `target-changed` with no rows. The owner path makes no lookup and skips both. `list` scans chunks of `limit + 1` until the
  page is full, so `nextBefore` is set only when another visible row is older (bounded at twice
  `EVENT_LOG_LIMIT` scanned rows; then `nextBefore` is the scan's cursor). `createServerStatuses` is made
  before `createEvents` in `index.ts` for this.
- Events section (#94): `src/frontend/views/EventsSection.tsx` and `useEventLog.ts`, a SideNav section
  of `CoolifyTab` keyed by connection id and `revision` (a change remounts it: empty list, filters reset).
  `useEventLog` holds rows with a key of connection, revision, kind and uuid; newest-page reads and
  older-page reads each take a generation, and the effect's cleanup advances both, so a late answer for
  an old target or filter is dropped. It reads the newest page when active and again `EVENTS_POLL_MS`
  (60 s, no faster than the poller) after each read settles, a `setTimeout` chain, only while the tab is
  visible and the section mounted. `mergeNewest` lays a newest page over the rows shown (a page that
  doesn't reach them replaces them). Older pages use `before`. Filters are server-side (`kind`, `uuid`;
  the resource select lists top-level resources). `subjectOf` picks a row's link: build log with operate
  (`mayOperate`), else the resource detail, the server filter on Resources, or nothing for team rows.
  `EVENT_KIND_IDS` mirrors `EVENT_KINDS` (a test checks it) and each kind has an `eventLog.kinds` label.
  No dashboard card or widget for the log yet; it would reuse `coolify.events-list`.
- Team webhook (#91): `src/backend/webhooks/` (`shape.ts`, `service.ts` `createWebhooks`,
  `routes.ts`), made in `index.ts` after `createEvents`; `PUBLIC_WEBHOOK_PATHS` joins the router's `public`
  list (no `publicRateLimit`). `POST /webhook/:token` answers `200 {"ok":true}` or one fixed
  `400 {"error":"Bad request"}` for an unknown token, a body over `WEBHOOK_BODY_MAX` (65,536 bytes: the
  content-length or the parsed body's own JSON size, whichever is larger) and any body `readWebhook` refuses,
  alike; a database failure is 500 (Coolify retries 5xx and 429, and counts 401/403/404/410 against its
  channel, so a refusal is never one of those). Order: size, shape, then `verify` (token shape
  `^[A-Za-z0-9_-]{43}$`, lookup by sha256, `tokenMatches`' `timingSafeEqual`, from status/service.ts), then
  `lastReceivedAt` (#90 reads it) and persist, then the answer; the fan-out runs on unawaited and never
  rejects. At most `WEBHOOK_FANOUT_MAX` (32) fan-outs per row are in flight: `receive` reserves a slot
  right after `verify` and before `lastReceivedAt`, and a full row answers `{ accepted: false, busy }`,
  which the route sends as `503 {"error":"Busy"}` (Coolify's `SendWebhookJob` retries 429 and 5xx) with
  nothing stamped, so the poller never stops on a dropped event. Events with no kind take no slot.
  `shape.ts` is the strict shape: `COOLIFY_WEBHOOK_EVENTS` is every event Coolify v4.7.5 sends, by its
  `event` word, with each `toWebhook()`'s keys and types read from Coolify's source
  (app/Notifications/**, tag v4.7.5; main the same): only own keys of a plain object, every key known
  and typed, the required ones present. `status_changed` ("Resource stopped") maps to `status-changed`
  (`fields: { to }` by `resourceHealth`) only when its `url` ends `/application|database/<resource_uuid>`
  (`STATUS_LINK`; Coolify sends no type, and a preview's or a service part's link names the parent).
  Task events carry `taskUuid` (the scheduled task: Coolify's payload has no run uuid), and the pipeline's
  `dedupeKeyOf` keys them `task|<kind>|<taskUuid>|<minute>`; the poller's `PolledRun.taskUuid` gives its
  task runs the same. Backups keep the resource key: the backup webhook names no schedule or execution, so
  a poll-only identity would stop poll and webhook deduping. Events with no kind (test, general,
  container_restarted, Docker cleanup, patch checks, ...) are accepted and ingest nothing; image
  vulnerability digests aren't in it yet (refused). Mapped events carry only uuids, the name, a fixed
  status word and a few numbers; never `message`, URLs or log fields (`output`, `error_output`,
  `s3_error`). Fan-out: every connection with the row's `instanceKey`, in parallel: `unattendedSnapshot`,
  owner `hasFor(view)` (else skipped, not asked), `snap.api()` (the connection's cached client, so the
  check shares its 150 a minute budget), `api.canRead(subject)` (api.ts: one GET of the subject itself,
  `retry: false`, `exactStatus: 200`, any throw false; `GET /team` for a team subject, which no v4.7.5
  event maps to yet; its `beforeFetch` re-reads `unattendedSnapshot` right before the GET, after the budget
  wait, and a changed revision sends nothing and answers `dropped`), then
  `events.ingest(id, event, { revision: snap.revision })`. `deliverTo` gets the row's `instanceKey` and
  drops the event when the snapshot's own `instanceKey` (now on `unattendedSnapshot`, from the same row)
  or the `beforeFetch` re-read differs, so a connection repointed after it was picked sends nothing. A
  resource event's `serverUuid` comes from the check's own 200 body (`canRead` answers
  `{ serverUuid }`, picked by `resourceServerUuid` in dto.ts, the same fields as `ResourceDto.serverUuid`;
  `plainUuid` or null), so the pipeline gives it the Linked host; no extra request. #90's poller reads `lastReceivedAt` to make
  polling follow `pollEnabled` (cross-checked in `webhooks/routes.test.ts`). A task's subject is
  its application or service, a backup's `/databases/{uuid}`, restart limit `/applications/{uuid}`
  (Coolify names any resource application_uuid; others fail closed). `issueWebhookToken()` gives #92
  `{ token, tokenHash }`; `webhooks.verify(token)` answers `{ id, instanceKey }` or null.
- Webhook setup (#92): `src/backend/webhooks/setup.ts` (`createWebhookSetup`, made in `index.ts`
  right after `createWebhooks`), `setup-routes.ts` (`GET`/`POST`/`DELETE /connections/:id/webhook`,
  `POST .../webhook/replace`) and `src/backend/ops/webhooks.ts` (`coolify.webhook-status` read,
  `coolify.webhook-setup` change, `coolify.webhook-replace` and `coolify.webhook-disable` destructive and
  in `MCP_CONFIRM_REQUIRED`; the handlers pass `confirmed` because core confirms every destructive run).
  Coolify's specs describe no body for `/notifications/webhook`: the field names (`webhook_url`,
  `webhook_enabled`, `*_webhook_notifications`) come from Coolify's NotificationsController and
  WebhookNotificationSettings at tag v4.7.5. `WEBHOOK_EVENT_TOGGLES` maps each event `shape.ts` gives a
  kind to the key its notification passes to `getEnabledChannels` (`<key>_webhook_notifications`, so
  `status_changed` needs `status_change`); a test keeps its keys equal to the mapped events, so a new
  mapped event must add its toggle. `webhook_url` is hidden unless the token has
  read:sensitive, so a GET without the key is `secrets-unreadable` (409), never "unset". The URL is read
  only by `api.webhookChannelForSetup()` (`WebhookChannelForSetup`, like `KeyForCopy` not a DTO) and the
  PATCH answer is dropped unread. Order: `coolify.configure`, `connections.snapshot` once (its new
  `instanceKey`), owner or configure access, not `scoped`, an instanceKey (`no-team`), confirm, a base
  (`no-base-url`), then one queue per instanceKey (two setups for one team would each write a token).
  `holds` (revision plus the live permission and access) is every request's `beforeFetch` and runs before
  the row write. Ours means the path ends in `/plugin-api/<id>/webhook/<43-char token>`, no query, and
  `webhooks.verify(token)` finds this instanceKey's row; ours keeps its token and row (the URL is
  rewritten on today's base), unset and replace give the row a new `tokenHash` (write-ahead, before the
  PATCH; the old token wasn't in Coolify) and reset `lastReceivedAt`, so polling goes on until the new URL
  delivers (a busy 503 refusal stamps nothing, so polling also stays on through those). Someone else's URL is shown only through `maskWebhookUrl` (scheme, host, port, then
  `/[redacted]`). Disable writes `{ webhook_url: null, webhook_enabled: false }` only when ours, then
  deletes that row (by instanceKey and token hash). Every partial failure converges on a retry:
  `dropRow` removes this team's row whenever Coolify doesn't hold its token (disable finding unset or
  someone else's, and a declined replace), with no `holds` first since the row is dead either way, so a
  disable that cleared Coolify but lost its row delete, or a URL someone replaced, never leaves a
  `lastReceivedAt` that keeps polling off (fail closed: polling resumes). A setup whose PATCH failed
  left only a write-ahead row with no `lastReceivedAt`; its retry rotates the token again. The base is `baseUrlOf(req)` on routes and
  `knownBaseUrl(ctx, actor)` in operations. `privateBase` is `isPrivateAddress` (connections/service.ts,
  the transport check's `hostReach`) plus Coolify's blocked `.local`/`.internal` names; it only warns.
  Nothing returns, logs or audits the URL: answers carry `outcome`, `replaced`, `basePrivate`; the audit
  lines (`coolify_webhook_setup`, `coolify_webhook_disable`) hold the connection id and outcome. Frontend:
  `views/WebhookSetup.tsx` in `ConnectionEditor` (owner only), keyed by `id:revision`, confirms through
  `useConfirmFor`, and a read generation keeps only the newest status.
- Alerts (#93): `src/backend/alerts/` (`service.ts` `createAlerts`, `routes.ts`),
  `src/backend/ops/alerts.ts`, `src/shared/alerts.ts` (`DEFAULT_ALERT_KINDS`, `alertTabData`) and
  `src/frontend/views/AlertPrefsView.tsx`. The one pipeline hook is `EventsDeps.onStored?: (event:
EventRecord) => unknown`, called by `afterStored` in `createEvents` after the commit and its persist,
  right before `stored` is answered: started with a copy of the record and never awaited (it can't hold
  up the connection's queue), and whatever it throws or rejects with is logged by the error's name only,
  so an alert failure never fails or blocks an ingest. `index.ts` makes `createAlerts` before the
  pipeline and passes `onStored: (event) => alerts.notify(event)`. `notify` reads
  `connections.audience(id)` (name, owner, grantees of a known level; no actor) and, for each person in
  turn: their kinds (`p_coolify_alert_prefs`, migration 0004, one row per connection and user; no row is
  `DEFAULT_ALERT_KINDS`), `ctx.rbac.hasFor(user, "view")`, then `connections.accessFor(id, user)` as the
  last read before `ctx.notify.send({ audience: { userId } })`, so a lost permission or grant stops the
  next alert. One failed send is logged and the others go on. Text is `fill` of `alerts.title.*` and
  `alerts.body.*` from the stored, redacted record only (name, status, uuids) plus the connection's own
  name, passed through `redactLog` once more. Category `coolify.<kind>`, severity the kind's, dedupeKey
  `coolify:<user>:<connection>:<kind>:<dedupeSubject>`: the deployment, the subject for a `REPEATING`
  condition (restarts, unreachable, high disk, certificates, token expiry), else the event id, so two
  task runs (#118 keys them by `taskUuid`, which `EventRecord` lacks) or a status change and the change
  back are separate alerts (a duplicate event never
  reaches the hook at all). The SDK's `link` names only a tab type, so it is `{ tab: "coolify" }` and the
  subject's tab data (`alertTabData`, the shape `requestOf` in CoolifyTab reads) is `context.tab`.
  `alerts.idle()`/`pending()` exist for tests. Preferences: `prefs`/`setPrefs` act for the actor only
  (coolify.view, `connections.access`, another user's connection 404), a list of known kinds (deduped,
  in `EVENT_KINDS` order; an empty list is no alerts) or null for the defaults; anything else is
  invalid-input and saves nothing. Every save and reset runs in an in-process queue per
  `connectionId:actor` (`serialized`, like sync's; one plugin process), entered before any await, so
  the row read and its insert or update never interleave (two first saves would otherwise both insert
  and trip the unique index) and saves apply in the order asked; no DB upsert, which the SDK does not
  offer alike on sqlite, postgres and mysql. Removing a connection deletes its rows in `removeNow`'s batch; a
  user's rows go with the user (refUser). `coolify.alert-prefs-set` is a change with permission view and
  is in `MCP_CONFIRM_REQUIRED`. The UI is each connection row's Alerts action (every access level), keyed
  by the connection id, request generations for its loads and saves, and a button that runs the Alerts
  hub's `alerts.openChannels` (in the manifest's `uses`).
- Abort: `registerOperations` hands the ops files a ctx whose `operations.register` wraps every handler in
  `abortable` (operations.ts), so a cancelled run throws its signal's reason before it starts; the wrapper
  only adds that check, so each handler's own permission and confirm checks still run. Long handlers
  watch the signal as they go: deploy with `wait`, exec (kills the remote process and closes the session),
  logs-tail (`logs.snapshot` checks it after each await), server-updates-install and server-reboot
  (`Target.signal`), tunnel-open (`tunnelOpen`'s signal) and the deploying signal's loop. Each checks the
  signal once more after its last revision check, with no await before the SSH command, connect, Package
  Manager call or forward: a cancel during that check starts nothing. Checked before `guard(...)`, not
  inside it, since guard turns what its callback throws into ssh-failed. A shared update check takes no
  signal (other callers join its run; it only reads). `ctx.ssh.exec` takes no signal, so a one-shot SSH
  command already sent runs to its own timeout.
- Palette (`src/frontend/index.tsx`): Deploy, Open shell and Logs open the Coolify tab on Resources with tab
  data `{ section: "resources", open?: "shell", tab?: "<detail view>" }`, Sync servers with
  `{ section: "sync" }`. CoolifyTab's `pick` opens a shell once (coolify.operate and `OPERATE_ACCESS`, the
  Shell button's rule) or the detail on that view; `detailTabOf` falls back to Overview for a view it
  doesn't know, and `detailTabs` drops one the actor can't see. The request is tracked by the `tab.data`
  object, so an entry run while the tab is open applies there too.
- Operations Center host page: SDK 2.8.1 has no shell API that opens it (`ShellApi` has none, and the
  design's `host-page.open` action can't be detected), so the host section has no link to it yet.
- Other plugins: `src/backend/plugins.ts` is the one read of `ctx.plugins.list()` (`activePlugins`, null
  when unreadable) and the one table of their ids (`COMPANION_PLUGINS`: docker, sshTerminal,
  packageManager and the companions). Sync, server updates and companions all go through it; each treats
  null as unknown, never as "not running" (sync blocks tunnelled rows, updates refuses with
  `companions-unknown`, companions answer `companions-unknown` 409).
- Companions: `src/backend/companions/` (`detect.ts` `companions(ctx)`, read fresh on every call, the
  frontend's `useCompanions` caches it a minute; `adapters.ts`, the only code that invokes another plugin's actions;
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
  `configure`. `logSearch` (adapters.ts) takes the snapshot's `secrets()` and puts every text field of
  every hit through `redactLog` before the 2,000-character cut; messages go through one `keyBlockCarry`
  in the order given, else reversed (Log Search doesn't document its order), and when key markers fit
  neither order every message is masked. Whether an order reads as a log is `hasLoneKeyEnd` and
  `openKeyBlock` from logs.ts over the joined messages (every marker, each END paired with a BEGIN of
  its own kind); keep key-marker scans in logs.ts, not hand-rolled. Every companion call is a documented action from the companions' published references
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
  back to its own state from before (an unknown one is left as it is). Files, Tunnels and Reverse Proxy are ticket #19 (below).
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
- Container companions (ticket #19): `src/backend/companions/container-adapters.ts` (data paths,
  storage path rules, the `docker inspect` IP parse and private-address check, the `tunnels.access` and
  `reverse-proxy.endpoints` calls), `container-service.ts` (the checks, the in-memory forward registry),
  `container-routes.ts` (GET `paths`, POST/DELETE `tunnel`, POST `web-ui`; `/companions` is #13's) and
  `src/backend/ops/container-companions.ts`, whose `files-paths` and `tunnel-open`/`tunnel-close`/`web-ui`
  kinds `ops/companions.ts` dispatches to. These are the only service calls into other plugins (in
  `requires`, optional): Tunnels and Reverse Proxy publish no action that forwards a port or opens an
  endpoint. Their references name no methods; `forward`/`stop` and `available`/`open` are checked against
  the providers' source, and a provider without them is `companion-missing`. Paths: `coolify.view`, `connections.snapshot` once,
  `companions(ctx)` (unreadable list: `companions-unknown`), the uuid in the connection's own list
  (`resources.get`, a miss once fresh), the Linked host and the actor's `view` access to it, then the
  storages read (revision checked in `beforeFetch` and before answering). File storages must stay under
  the resource's own `/data/coolify/<kind>/<uuid>`; volume host paths (Coolify reports them as volumes)
  are normalized and may be anywhere but `/`; `..` is refused. Tunnels and web UI: snapshot once, the
  companion running, `containers.target` (lifecycle's `authorize`), the companion's service, then
  `containers.locate` (Linked host, `connect` access, revision, docker ps), `docker inspect` with a fixed
  format (each network's `IPAddress` and `GlobalIPv6Address`) and the docker ps name, then the companion call. `holds(id, snap, level)` is the guard before every
  SSH, Coolify and companion call: the snapshot's revision plus the actor's current permission and grant
  at `level` (operate for tunnels and web UI, view for paths), so a grant lowered during `docker inspect`
  stops it. Only a private container IP
  passes (`isContainerIp`: 10/8, 172.16/12, 192.168/16, fc00::/7, the first byte masked with 0xfe being 0xfc, read from the parsed address), IPv4 first; IPv6 goes to Tunnels
  and Reverse Proxy without brackets. The registry (`forwards`, by tunnel
  name) records the actor and port: close needs both to match (`tunnel-not-found`), another actor's name
  is `tunnel-in-use`, and `TUNNELS_MAX_PER_ACTOR` (5) is `too-many-tunnels`. Opens and closes of one
  tunnel name run one at a time (`serialized(name, ...)`, as sync's queue), so every overlapping pair
  acts as if one ran after the other (`container-registry.test.ts` checks every pair against Tunnels'
  state). Inside the queue an open reserves its slot synchronously after the cap check, so opens of other
  names count it; every failure gives it back (or restores the forward it was reopening) and stops a
  forward Tunnels may have opened; that record and its slot are released only once `stop(name)` works,
  so a forward that couldn't be stopped can still be closed here. It is per process and a restart forgets it. The call is `forward(hostId, { targetHost, targetPort, bindHost: "127.0.0.1" },
{ name })` (checked against Plugin-Tunnels' `src/backend/service.ts`; the name goes in the third
  argument and must be `web:<hostId>:<id>`), and Tunnels' `bindHost`/`bindPort` are passed on. Close is
  `stop(name)`, never the answer's `close()`, which doesn't survive the process boundary; a later forward
  of the same name opens again. The web UI URL is a sensitive output of `coolify.companion`; the handler keeps it in the logs
  handoff store (`holdHandoff`, `web-ui:<handoffId>`) and `actionResult` puts it back once
  (`takeWebUiUrl`). `MCP_CONFIRM_REQUIRED_KINDS` makes MCP refuse tunnel-open and web-ui without
  `confirmed: true`; `inputSchema` declares `confirmed` for every destructive action, every
  `MCP_CONFIRM_REQUIRED` id and every action in `MCP_CONFIRM_REQUIRED_KINDS` (`confirm-schema.test.ts`). Frontend: `views/ContainerCompanions.tsx` (in ResourceDetail's Overview, keyed by
  connection, uuid and `revision`, request generations through `useLatest`; the open forward is held
  above the panel switch and passed to `ForwardControl` as `open`/`onOpen`, so panels mount and unmount
  freely; container choices are disabled while a request is out; Reach from here and Open web UI are
  gated by ResourceDetail's effective `canOperate` (the connection's grant), and the Tunnels view lists only
  connections whose `access` is in `OPERATE_ACCESS`; Browse files with view, the
  rest with operate) and `views/TunnelsCoolifyView.tsx` (`tunnels.views`, registered only with
  `hasPermission("operate")`, rows keyed the same way, open forwards held in the view by row key, loaded sections tagged with the
  host scope they were read for and shown only while it is current; a host given without a Coolify link is its own
  state, `notCoolifyHost`, with no connection read, since only the hostless tab lists every connection's
  resources). `files.openHost` and `files.openEditor` are File
  Manager frontend actions run with `invokeAction`.
- Deployments: `src/backend/deployments/` (service, log, routes, queue, by-tag) and
  `src/backend/ops/deployments.ts`. `deployments.queue(connectionId)` is the one connection-wide read of
  Coolify's queue (`GET /deployments`) plus the recent history of the ten most recently deployed
  applications; it is cached 10 seconds in memory (`queue.ts`), keyed by revision and an invalidate
  generation like the resources cache, shared by the Deployments section, the Overview, the
  `coolify.deployment-queue` action and anything later (the sidebar panel, rail badge). Rows whose link
  names no application of the connection are dropped. Cancel, deploy by tag and rollback invalidate it. In the
  frontend, `useDeploymentQueue` is held by CoolifyTab and polls only while the tab shows Overview or
  Deployments. Deploy by tag finds the tag's targets itself (`/applications?tag=` and each service's tags)
  and deploys them by uuid: Coolify's own `tag` parameter refuses `pr` and `docker_tag`, and deploying by
  uuid deploys exactly what the confirm listed (`targets`, checked again before Coolify is asked).
- Recent activity: `src/backend/activity.ts`. `recordShell` runs in `containers.shell` (route and
  `coolify.shell-command`) once the answer is built. `createDeployActivity(ctx, sync)` makes the one
  post-start hook (`deployed`), built in `index.ts` and passed as a required dep to `createLifecycle` and
  `createDeployments` (previews reach it as `deployments.deployed`), so a new deploy service has to wire
  it. Every path that starts a Coolify deploy calls it once Coolify accepted, whatever a wait finds
  later: `lifecycle.run`, `deployByTag` (one entry per target Coolify answered for; servers come from
  `findTargets`' own read, so no extra read can stop a deploy), `rollback` and `previews.create` (text
  names the pull request). Each records before its last revision check, so nothing is awaited between
  that check and the answer. `deployStarted`: an application counts only with a deployment uuid, a
  service or database always (Coolify starts them with none). The hook resolves a server to its Linked
  host, checks `ctx.hosts.checkAccess(hostId, "connect")`, dedupes per `host:kind:uuid`, and never
  throws (a failure logs only the error's name). Texts go through `fill` (`src/shared/template.ts`). Types `coolify_shell` and
  `coolify_deploy` (`src/shared/activity.ts`) are claimed by the `coolify` tab's `activityTypes`. It needs
  only `hosts:read`; `hosts:activity-provide` is for the plugin that stores activity. `coolify.api-call`
  passthroughs record nothing.
- Activity panel and rail badge: `src/backend/attention/` and `src/backend/ops/attention.ts`
  (`GET /attention`, `coolify.attention`) put together, for every connection the actor can view, the
  queue's running rows, recent failures (`recentFailures`: the application's latest ended deployment per
  pull request, failed, ended within 24 hours), degraded resources (no Parts) and unreachable servers. It
  makes no Coolify request of its own: it reads `deployments.queue`, `resources.list` and `servers.list`,
  whose caches the tab shares, so the panel, the badge and the tab cost one read per connection. A part
  that fails sets the connection's `error` and keeps the others; a connection whose access went away by
  the end is dropped. Frontend: `views/useAttention.ts` (one hook; `railBadge` is the `coolify` rail item's
  `useBadge`, run in the background frame, checking `app.hasPermission("view")` before any read and
  polling every 60 s) and `views/ActivityPanel.tsx` (panel `coolify-activity` with its own rail item,
  polling every 15 s while `active`). Panel rows open the tab with data the tab reads in `requestOf`:
  `uuid` on Resources opens that resource's detail, `resourceUuid` + `deploymentUuid` on Deployments
  opens the build log, but only with operate (`shownDeployment` in CoolifyTab).
- Rollback: `deployments/service.ts` `rollbackImages` (view) and `rollback` (operate), applications
  only, through the same `open`/`holds` snapshot re-check as cancel; the image must be in Coolify's list as
  read in that same call. `ops/rollback.ts` has both scopes; the rollbacks are destructive and in
  `MCP_CONFIRM_REQUIRED`. `coolify.deploy` / `coolify.resource-deploy` declare them as `undo`: before an
  application deploy, `imageBefore` in `ops/lifecycle.ts` reads the current image and returns it as
  `undoInput` only when it is listed; a failed read never blocks the deploy. `PluginOperationOutcome` has
  no `undoInput`, so tests read it from the handler's own result. `RollbackView` re-checks after the
  confirm that it is still mounted and on the same application before it posts.
- Dashboard cards and homepage widgets: `src/frontend/views/dashboard/` (`register.tsx`,
  `CoolifyCards.tsx`, `useCardRead.ts`), shared kinds, settings and poll intervals in
  `src/shared/dashboard.ts`, backend reads in `src/backend/dashboard/` and `ops/dashboard.ts`. One
  dashboard card `coolify` (manifest `dashboardCards`) whose `entries` are the four kinds, each entry's
  `config` `{ card }`; the card's own `setConfig` adds `connectionId` (and `uuid` for the resource card).
  The same four go to `homepage.widgets` (in `uses`) as `coolify.<kind>`, with `components` `view`,
  `editForm` and `label` (the Homepage plugin's `WidgetRegistry` reads those three; its widget props are
  `{ widget, config, onConfigUpdate }`, its edit form's `{ config, onChange }`). A widget has no
  visibility prop, so it reads only while `document.visibilityState` is visible. `readCardConfig` keeps
  only well formed stored values. `useCardRead` reads the connection (403/404: the no-access state), then
  the card's data, keyed by the card's target, newest read only, a setTimeout chain every
  `CARD_POLL_MS[kind]`, which `poll-intervals.test.ts` holds at or above each backend cache's TTL.
  Overview reads `GET /connections/:id/overview` (resources and server statuses caches, no Coolify request
  of its own); the resource card reads the resource list and deploys through `useLifecycle` after a
  `useConfirmFor` keyed by connection, uuid and revision, with the body keyed by target (the terminal
  companion's rule for the button: `coolify.operate` and `OPERATE_ACCESS`, never a Part); deployments
  reads the queue route; vulnerabilities reads `GET /connections/:id/vulnerabilities`, Coolify's
  `/vulnerabilities` summarized to counts (`dashboard/vulnerabilities.ts`, in memory five minutes, keyed
  by revision, shared in-flight, kept only if the revision held; no names or Coolify text, so nothing to
  redact) and links to the connection's `baseUrl`. No recent events on any card: the event pipeline (#89)
  is separate, and an events card belongs to the event log ticket. `resources.load()` and
  `servers.list()` answer only for the revision they started under (#123); the overview and
  `GET /connections/:id/resources` still wrap them in `forRevision`, so the parts share one target
  (`connections/hold.ts`: revision before, checked again before answering, else `target-changed` 409);
  the queue (`holds`) and vulnerabilities (snapshot revision) check it themselves. `server-health` (host
  dots and host rows, `resources/server-health.ts`) wraps its reads in `forRevision` too. The vulnerabilities card counts only completed scans as
  scanned (`ok` plus affected); `check_needed` and `not_checked` are "not scanned yet", and with nothing
  scanned it never shows the clean state.
