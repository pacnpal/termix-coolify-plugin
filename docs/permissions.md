---
title: Permissions
order: 30
---

# Permissions

Four things decide what someone may do with Coolify from Termix: their Termix permissions, their access to
the connection, **Allow changes over MCP** for the MCP endpoint, and a confirm for anything destructive.
Coolify checks the API token's own abilities on top.

## Termix permissions

Admins and users get all five by default. Admins can take any of them away per role.

| Permission                       | Level      | What it allows                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **View Coolify**                 | view       | Open the plugin, read your connections, their resources, servers, sync previews, status pages, metrics over Coolify and companion reads                                                                                                                                                                                      |
| **Operate Coolify resources**    | operate    | Deploy, start, stop and restart, build logs, cancelling deployments and rollback, deploying, deleting and changing pull request previews and their logs, logs, shells and consoles, running commands, metrics and traffic over SSH (including container CPU and memory in host metrics), update checks and installs, tunnels |
| **Configure Coolify**            | configure  | Add, change and remove connections, sync servers into hosts and unlink them, DNS records, status pages, enabling metrics, revealing a masked value                                                                                                                                                                           |
| **Administer Coolify**           | administer | Rebooting a server, and the Coolify API operations that delete, create or transfer servers, provision cloud servers or change instance settings                                                                                                                                                                              |
| **Use the Coolify MCP endpoint** | mcp        | Reach `/plugin-api/coolify/mcp`. Each tool still needs the permission of the action it runs                                                                                                                                                                                                                                  |

Through the full Coolify API (`coolify.api-read`, `coolify.api-call` and the API console), each Coolify
operation needs the level its path and method call for: reads are view, reads that show logs or command
output are operate, other changes are configure, and the operations named above are administer.

## Access to a connection

A connection belongs to the person who added it. In 1.0 only its owner reaches it; another user's connection
answers as if it didn't exist. Every check already ranks access as view, operate, configure, then owner, so
an action needs both the Termix permission and at least that access to the connection.

Anything that reaches a Linked host over SSH also needs your own access to that host in Termix: **connect**
for shells, logs, tunnels and update checks, and **edit** for running commands, installing updates and
rebooting.

## Changes over MCP

The plugin's MCP endpoint always runs reads, and deploy and restart (`coolify__deploy`, `coolify__restart`,
`coolify__resource_deploy`, `coolify__resource_restart`). Every other change and destructive tool, start and
stop included, answers `mcp-changes-off` until an admin turns on **Allow changes over MCP** in the plugin's
settings. The switch covers this endpoint only. A key scoped to `operations:read` can call only read tools,
whatever the switch says.

## Confirms

- **Destructive actions** (stop, `coolify.resource-action`, removing a connection, rebooting, removing a DNS
  record, rotating or revoking a status page, `coolify.api-call`, `coolify.exec`, cancelling a deployment,
  rolling back, deleting a pull request preview) need a confirm: Termix asks in the UI, the operations API takes `confirmed`, MCP takes `confirmed: true` in
  the tool's arguments, and the `coolify.client` service takes `{ confirmed: true }`.
- **Logs** (`coolify.logs-tail`, build logs through `coolify.deployment-get` and a preview's logs through
  `coolify.preview-logs`) need `confirm: true`, since logs can hold secrets.
- **Pull request previews:** deploying one and changing its domains ask first in the Previews tab, and over
  MCP need `confirmed: true`.
- **Server updates:** installing needs `confirm: true`; rebooting needs `confirmName`, the server's name.
- **Enabling metrics** needs `confirm: true`, and over MCP `confirmed: true` as well.
- **Deploy by tag** asks first in the UI, listing the resources it will deploy, and over MCP needs
  `confirmed: true` (and **Allow changes over MCP**).
- **Rollback** over MCP needs `confirmed: true`: the plugin refuses without it before Termix is asked.
- **Running commands in containers** also needs the admin setting **Allow running commands in containers
  through the API and MCP** and the connection's own switch, and over MCP `confirmed: true`.
- **Tunnels and web UI links** over MCP need `confirmed: true`.
- **The API console** asks you to type the operation id before a delete.

## Approvals and history

Every action runs through Termix's operations, so approval rules, run history and the audit log apply to the
UI, the operations API, the CLI, Automations, MCP and the `coolify.client` service alike. Secret inputs and
sensitive outputs (tokens, log text, command output, one-time links) never reach run history.

## Recent activity

Opening a container shell or database console on a Linked host adds "Opened shell in <app>" to your Termix
recent activity. Every deploy Coolify starts adds "Deployed <app>": deploy, deploy by tag (one entry per
resource it started), rollback (it deploys an earlier image) and a pull request preview, which reads
"Deployed <app> (pull request #<n>)". The entry is recorded once Coolify accepts the deploy, whether it
later finishes or fails. This happens however the action was run, and only after Coolify accepted it, only for a resource
whose server is a Linked host you can connect to, and only once per resource. Termix checks that access
again before it keeps the entry, and keeps it only when a plugin provides the recent activity list. Calls
made through the full Coolify API (`coolify.api-call` and the API console) add no entry: they are
Coolify's own endpoints, passed through as they are.

The plugin adds entries with `ctx.hosts.recordActivity`, which needs the `hosts:read` capability it already
has. It does not ask for `hosts:activity-provide`: that capability is for the one plugin that stores
everyone's recent activity, which this plugin isn't. If an entry can't be added, the shell or deploy still
works and the plugin logs only the error's name.
