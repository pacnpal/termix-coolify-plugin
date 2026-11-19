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
  Where things stand: identity, permissions, admin settings, the vendored API and the tables exist, and
  Connections work (routes, operations, the Connections view and the "Connect Coolify" onboarding step).
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
- Operation tests: the mock ctx records no run history, so `tests/backend/helpers/run-history.ts` applies
  the SDK's own `parseOperationInput` and `redactFields` around `ctx.operations.run`, as core does.
- Coolify API: `vendor/coolify/` holds the v4.7.5, `main` and `next` specs as fetched (see its README).
  `npm run gen:coolify` writes `src/backend/coolify/generated/operations.ts` (`OPERATIONS`,
  `EXCLUDED_OPERATIONS`) and `schemas.ts` (each operation's parameters and top-level body fields, from the
  newest spec that has it, for the generic API and the console's forms). `docs/coverage.md` must list every
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
  non-GET needs `confirmed`, a DELETE also `confirmText` equal to the operation id. Reveal re-reads Coolify,
  is audited and answers `Cache-Control: no-store`.
- Tables: `src/backend/tables.ts`, migrations in `migrations/`. Table names are snake_case
  (`p_coolify_status_pages`); the SDK refuses camelCase. `servers.hostId` is a plain nullable integer, not
  `refHost`: a cascade would delete the row and its `addressOverride` when the host goes. The `host.deleted`
  handler sets it to NULL (unlinks) instead.
