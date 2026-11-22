<div align="center">

<h1>Coolify for Termix</h1>

<p>Coolify inside Termix</p>

</div>

<br />

## Overview

A [Termix](https://github.com/Termix-SSH/Termix) plugin that brings [Coolify](https://coolify.io) servers,
applications, services and databases into Termix, so they can be used from Termix's UI, API and MCP.

See [CHANGELOG.md](CHANGELOG.md) for what is in each release, and [docs/index.md](docs/index.md) for how to use it.

<br />

## What it does

- Connect one or more Coolify instances with an API token
- Coolify servers become locked Termix hosts, Cloudflare tunnels included
- One-click shells and database consoles in any Coolify container
- Start, stop, restart and deploy applications, services and databases
- Server metrics, traffic and package updates
- Public read-only status pages
- Every Coolify API operation from Termix's API, CLI and MCP, and a `coolify.client` service for other plugins

<br />

## Install from this repo's registry

This repo is its own Termix registry, published by its owner. In Termix, open **Plugins**, **Registries**,
**Add registry**, and paste:

```
https://raw.githubusercontent.com/pacnpal/termix-coolify-plugin/registry/index.json
```

Choose **Check** and compare the key id Termix shows with the one below before you choose **Trust and add**.
Coolify for Termix then installs and updates from it.

**Key id:** `d07bfdc9da00b6e7`

The public key is in [`registry/public-key.txt`](registry/public-key.txt). The registry lists nothing until
the first signed release.

The key id is the first 16 hex characters of the sha256 of the raw public key; `npx termix-plugin keygen`
prints it, and Termix shows the same id. If the key ever changes, Termix stops updating from the registry
until you remove it and add it again. See [docs/registry.md](docs/registry.md) for how releases reach the
registry, key rotation and what to do when the key changes.

<br />

## Development

You need Node 24 and a Termix server you are an admin on. The Termix plugin guide ships with the SDK, at
`node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`.

```bash
npm install
npm test
npm run typecheck
npm run validate
npm run build
npm run format:check
npx termix-plugin migrations --check
```

The Coolify API descriptions the plugin is built against are saved in `vendor/coolify/`. After updating them,
run `npm run gen:coolify` and update `docs/coverage.md`. See [CONTRIBUTING.md](CONTRIBUTING.md).

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).
