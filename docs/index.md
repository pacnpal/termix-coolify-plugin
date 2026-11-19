Coolify for Termix brings your Coolify servers, applications, services and databases into Termix.

So far you can connect Coolify instances, see what each API token can do, browse each connection's
applications, services and databases, and sync Coolify servers into Termix hosts. Shells, deploys and the
rest come with the rest of release 1.0.0.

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

   The address should use `https`. Plain `http` is accepted only for `localhost` (`127.0.0.0/8`, `::1`),
   and for a private or link-local IP address (such as `192.168.1.10` or `fd00::5`) when **On my local
   network** is on. Every other name needs `https`, even one like `coolify.lan`, because a name can point
   anywhere. Anything else is refused before Termix sends a request. With plain `http` to a private IP,
   the token and any Cloudflare Access secret do travel in the clear on your own network, so choose it only
   for a network you trust.
   - **CA certificate**, when Coolify uses a certificate from a private CA.

4. Save. Termix checks the connection and shows what the token can do:
   - Coolify answers, and is 4.4 or newer (older versions are refused).
   - The team, or, for a token scoped to some projects, the team of its first project. A scoped token can't
     see servers, so it has no host sync, shells or keys, and can't set up notifications.
   - Whether it can read private keys and logs (`read:sensitive`). Logs are tried on an application, a
     database or a service's part; when the token sees none of them, the check says "not checked" rather
     than "can't".
   - Whether it can read instance settings, which Coolify allows to any root team admin's token. This
     doesn't show the `root` ability, which, like write, deploy and delete, can't be checked without
     changing something; they're checked on first use.

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

The Coolify tab has its sections on the left (a select at the top on a phone): **Overview**, **Resources**,
**Servers** (with **Configure Coolify**, see below) and **Connections**. With no connection yet it opens on
Connections. With more than one, pick the connection in the section's header.

**Overview** counts the connection's resources by status:

- **Running**: running, healthy or with no health check.
- **Degraded**: restarting, dead, or unhealthy.
- **Stopped**: exited, stopped, paused or with no status. Coolify reports a resource you stopped
  yourself as exited, so exited counts as stopped, not degraded.
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

## Sync servers into hosts

Each Coolify server can become a **Linked host**: a Termix host that Coolify for Termix creates and keeps in
step with Coolify. Host sync is the Coolify tab's **Servers** section, for the connection picked in its
header. **Sync servers** on a connection, **Import from Coolify** in the hosts import menu and **Sync from
Coolify** on a Linked host all open it. Only the connection's owner can sync it, and a scoped token can't
see servers, so the section says so instead.

1. The preview lists every server the token can see and what it becomes: name, address, port and user, in
   the **Coolify** folder (**Coolify / <connection>** when you have several connections), tagged `coolify`,
   with a note linking back to the server in Coolify. Nothing changes until you confirm.
2. Tick the servers to include and choose **Create and update hosts**. Servers that can't sync yet say why,
   and the others sync anyway:
   - **The server Coolify runs on** (Coolify calls it `host.docker.internal`, `localhost` or `127.x`): enter
     the address Termix should use. The connection's own host name is offered with one click. The address is
     kept for later syncs. You can set an address for any server the same way.
   - **No key to copy**: when the token can't read keys (it lacks `read:sensitive`) or an admin turned off
     **Allow copying Coolify SSH keys**, pick one of your Termix credentials for the server. Only your own credentials are accepted; a picked
     credential you no longer have blocks the server until you pick another.
   - **Behind a Cloudflare tunnel**: tunnelled servers are listed but can't be synced yet.
3. With keys readable, each Coolify key is copied once into a Termix credential named
   **Coolify: <connection> / <key>** and shared by every server that uses it. It is reused on later syncs
   and replaced only when the key's fingerprint changes. Every copy is written to the audit log. The key is
   never stored by the plugin, logged or sent back to the browser.

Syncing again updates the same hosts in place, so pins, shares and history stay. A server removed from
Coolify is shown as **Gone from Coolify** and is never deleted for you: choose **Keep as normal host** or
**Remove host**.

Linked hosts are read only while Coolify manages them. They show a **Coolify** badge, a status dot when
Coolify can't reach the server, and a Coolify card on the host page with **Resources**, **Sync from
Coolify** and **Unlink**, which are also in the host's menu. **Unlink** makes the host an ordinary, editable
host and keeps it. If you delete a Linked host yourself, the plugin forgets the link but keeps its address
and credential choice, so the next sync creates it again. Removing a connection unlinks its hosts, or
deletes them when you ask it to.

Syncing and unlinking need **Configure Coolify** and only the connection's owner can do them; the preview
needs **View Coolify**. They are also actions: `coolify.sync-preview` (offered to the assistant and MCP),
`coolify.sync-apply` (without a server list it syncs every server with its saved address and credential)
and `coolify.unlink`.

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
