---
title: Troubleshooting
order: 50
---

# Troubleshooting

## The connection check fails

| What it says                                   | What to do                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Coolify could not be reached                   | Check the address. If Coolify is on your local network, turn on **On my local network** under Advanced       |
| Coolify refused the API token                  | Create a new API token in Coolify and paste it in                                                            |
| API access is turned off in Coolify            | Turn on API access in Coolify, Settings, Advanced                                                            |
| Coolify is behind Cloudflare Access            | Add a Cloudflare Access service token under Advanced (see [Cloudflare tunnels](tunnels.md))                  |
| The address answered, but not as a Coolify API | Use the address you open Coolify at, without `/api` at the end                                               |
| This plugin needs Coolify 4.4 or newer         | Update Coolify, then check again                                                                             |
| The token lacks this ability                   | Give the token `read:sensitive` for keys and logs, or `write`, `deploy` or `delete` for the changes you want |
| Coolify is rate limiting requests              | Wait a minute. The plugin paces its own requests below Coolify's limit                                       |

A plain `http` address is refused unless it is `localhost` or a private IP address with **On my local
network** on. A name such as `coolify.lan` always needs `https`.

## Host sync

- **needs-address**: Coolify has no address Termix can reach for the server. Enter one on the server's row.
- **needs-credential**, **credential-not-found**, **credential-check-failed**: pick a Termix credential for the
  server, or let the plugin copy Coolify's key (the token needs `read:sensitive`, and an admin must allow
  copying Coolify SSH keys).
- **needs-ssh-terminal**, **ssh-terminal-too-old**, **needs-ssh-terminal-to-clear-tunnel**: turn on SSH
  Terminal 1.2.0 or newer with **Open Plugins**. See [Cloudflare tunnels](tunnels.md).
- **target-changed**: the connection's address, token or Cloudflare Access settings changed while it ran.
  Sync again.
- A scoped token sees no servers, so there is nothing to sync. Use a token for the whole team.

## Shells, logs and commands

- **not-linked**: the resource's server has no Linked host. Sync servers first.
- **no-host-access**: you can't open the Linked host in Termix. Ask its owner to share it.
- **host-key**: the server's SSH host key changed or isn't trusted yet. Check the fingerprint and accept it
  in Termix.
- Several containers match: pick one from the list.
- Running commands stays off until an admin turns on **Allow running commands in containers through the API
  and MCP** and the connection's owner turns it on for the connection.

## Over MCP or the API

- **mcp-changes-off**: an admin hasn't turned on **Allow changes over MCP**. Reads, deploy and restart work
  without it.
- **confirm-required**: pass `confirmed: true` (MCP, the operations API, the `coolify.client` service), or
  `confirm: true` where the action asks for it.
- A key scoped to `operations:read` runs only reads.
- A tool answers with a run id and waits: an approval rule needs a person to approve it in Termix.
- **unsupported-by-instance**: this Coolify is older than the one that added the operation. Update Coolify.
- **companions-unknown**: Termix's plugin list couldn't be read, so features from other plugins are hidden.
  Try again.

## Still stuck

Open an issue on the plugin's GitHub repository with your Termix, plugin and Coolify versions and the cause
the plugin showed. Never paste a token or key.
