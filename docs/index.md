Coolify for Termix brings your Coolify servers, applications, services and databases into Termix.

So far you can connect Coolify instances, see what each API token can do, and browse each connection's
applications, services and databases. Servers, shells, deploys and the rest come with the rest of release
1.0.0.

## Turn it on

1. Install Coolify for Termix from the Plugins tab.
2. Open the Coolify tab from the sidebar, or use the "Connect Coolify" step in setup.

## Connect a Coolify instance

1. In Coolify, open Keys & Tokens, API tokens, and create a token with the abilities **read, read:sensitive,
   write and deploy**. Everything works with these except deletes and instance settings, and a leaked token
   can't wipe your resources. Add `delete`, or use `root`, only if you want those from Termix.
2. In the Coolify tab, choose **Add connection** and enter a name, the address you open Coolify at and the
   token.
3. Under **Advanced**, if you need them:
   - **Cloudflare Access client ID and secret**, when the Coolify dashboard sits behind Cloudflare Access.
   - **On my local network**, when Coolify has a private address such as `192.168.1.10`.
   - **CA certificate**, when Coolify uses a certificate from a private CA.
4. Save. Termix checks the connection and shows what the token can do:
   - Coolify answers, and is 4.4 or newer (older versions are refused).
   - The team, or, for a token scoped to some projects, the team of its first project. A scoped token can't
     see servers, so it has no host sync, shells or keys, and can't set up notifications.
   - Whether it can read private keys and logs (`read:sensitive`) and instance settings (`root`).
     Write, deploy and delete can't be checked without changing something; they're checked on first use.

The token is stored encrypted and never shown again. When you edit a connection, leave the token empty to
keep the stored one. **Check again** reruns the checks. **Remove** forgets the connection and its token;
nothing changes in Coolify, and hosts made for its servers become ordinary hosts.

When a check fails, the connection says why: Coolify can't be reached, the token was refused, API access is
off in Coolify (Settings, Advanced), Coolify is behind Cloudflare Access, or the address isn't a Coolify API.

Connections are also actions, for the CLI, Automations and the phone app: `coolify.list-connections`,
`coolify.connection-probe`, `coolify.connection-create`, `coolify.connection-update` and
`coolify.connection-delete`. The token and Cloudflare Access fields are secret inputs: they never appear in
run history. Only the two reads are offered to the assistant and Termix's main MCP server; the plugin's own
MCP endpoint (below) offers all five.

Adding, changing and removing connections needs **Configure Coolify**; listing and checking them needs
**View Coolify**. Each person sees only their own connections.

## Overview and resources

The Coolify tab has three sections on the left (a select at the top on a phone): **Overview**, **Resources**
and **Connections**. With no connection yet it opens on Connections. With more than one, pick the connection
in the section's header.

**Overview** counts the connection's resources by status:

- **Running**: running, healthy or with no health check.
- **Degraded**: exited, restarting, or unhealthy.
- **Stopped**: stopped, paused or with no status.
- **Deploying**: starting or building.

Service parts aren't counted on their own; their service's status covers them. Choose a tile to open the
Resources list filtered to that status.

**Resources** lists every application, service and database, with each service's parts (its containers,
like n8n's worker or its Postgres) right under it. Each row shows the status, the Coolify server, the project
and environment, the domains and the last deploy. Search matches names, domains, projects, environments and
servers; filter by type and by status. Choose a row to open the resource's Overview; a service's Overview
lists its parts, and choosing one opens it.

The plugin reads Coolify's lists of applications, services and databases, never its heavier `/resources`
list, and keeps only what it shows: no environment values, private keys, tokens, passwords or compose files.
Statuses are cached for 20 seconds; **Refresh** fetches them again.

The same reads are actions, for the CLI, Automations, the assistant and MCP: `coolify.list-resources-all`
(optionally for one Coolify server) and `coolify.resource-get`. Both need **View Coolify**.

## Use with an MCP client

The plugin serves its own MCP endpoint at `/plugin-api/coolify/mcp`. The Connections view shows the address
and a client config under **Use with an MCP client**; put a Termix API key with the scope `operations:read`
(read tools only) or `operations:run` where the config says `<your Termix API key>`.

Every action is a tool, plus `list_connections`, `list_hosts` and `list_resources`. Each call runs as the
key's user through Termix's operations, so permissions, approvals and history apply. Read tools always work;
tools that change something answer "changes over MCP are turned off" until an admin turns on **Allow changes
over MCP**. Output never carries tokens, passwords, keys, env values or compose files, and long output is cut
at 8,000 characters. [API and MCP reference](api.md) lists every action with its route, run path, key scope,
MCP tool and a `curl` example.

## Permissions

Admins and users get all five by default. Admins can take any of them away per role.

- **View Coolify**: open the plugin and read the connections you own or were granted.
- **Operate Coolify resources**: lifecycle actions, deploys, tasks, backups, logs, and container shells and
  consoles.
- **Configure Coolify**: edits, variables, creates, imports, keys, sources, storage, DNS and notifications.
- **Administer Coolify**: deletes, server create, delete and transfer, cloud provisioning, instance settings
  and connection sharing.
- **Use the Coolify MCP endpoint**: each call still needs the permission of the action it runs.

## Coolify versions

The plugin is built against Coolify v4.7.5 and the `main` and `next` branches, and supports Coolify 4.4.0
and newer. [Coolify API coverage](coverage.md) lists every Coolify API operation and how the plugin uses it.
