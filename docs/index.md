Coolify for Termix brings your Coolify servers, applications, services and databases into Termix.

So far you can connect Coolify instances, see what each API token can do, sync Coolify servers into
Termix hosts, browse each connection's applications, services and databases, deploy, start, stop and
restart them, check and install a Linked host's server updates, and open a shell or database console in
their containers. Logs and the rest come with the rest of release 1.0.0.

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

## Sync servers into hosts

Each Coolify server can become a **Linked host**: a Termix host that Coolify for Termix creates and keeps in
step with Coolify. Open it from **Sync servers** on a connection, **Import from Coolify** in the hosts import
menu, or **Sync from Coolify** on a Linked host.

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

## Deploy, start, stop and restart

A resource's header has **Deploy**, **Force rebuild**, **Restart**, and **Start** (when it is stopped or
exited) or **Stop**. **Stop** and **Force rebuild** ask first, naming the resource. Deploy calls Coolify's
`/deploy` for the resource; a force rebuild builds without Coolify's build cache. A service's parts restart one
by one from the **Restart** button on each part in the service's Overview; a part opened on its own has
Restart and Start or Stop, and deploys with its service. In the command palette, **Coolify: Deploy…** opens
the Resources list to pick from.

These need **Operate Coolify resources**, and the connection must be yours or shared with you at operate or
configure. They work whether or not the resource's server has a Linked host:

- With a Linked host, each press runs `coolify.deploy`, `coolify.start`, `coolify.restart` or `coolify.stop`
  on that host, so it shows in the host's history.
- Without one, it runs `coolify.resource-deploy`, `coolify.resource-restart`, or `coolify.resource-action`
  (start or stop, confirmed) with the connection and the resource's uuid.

A uuid is only accepted when it is one of that connection's own resources (and, for a Linked host, one on
that host's server). When the Coolify token lacks the ability, the answer says so (`forbidden-ability`).

The same actions work from the CLI, Automations and the phone app. `coolify.deploy` and
`coolify.resource-deploy` can **wait** for the deployment: the run then follows it to the end, fails when it
fails, and sends the `coolify.deployment-finished` or `coolify.deployment-failed` event. A dry run of a deploy
says what it would deploy, and on which server. Deploy and restart are offered to the assistant and MCP; start
and stop aren't.

Linked hosts also get:

- `coolify.list-resources`: the resources on the host's server, shown in Termix's resources table and on
  the host page. A host that isn't linked lists none, without asking Coolify.
- `coolify.sync-host`: updates this one host from its Coolify server (owner only, **Configure Coolify**).
- Status tiles: degraded resources (`coolify.degraded`), whether Coolify can reach the server
  (`coolify.server`) and security updates from Coolify's last update check (`coolify.updates`), plus
  `coolify.deploying`, the resources deploying now across your connections. They read the same short caches
  as the tab, so many hosts on one connection cost one Coolify request.

## Use with an MCP client

The plugin serves its own MCP endpoint at `/plugin-api/coolify/mcp`. The Connections view shows the address
and a client config under **Use with an MCP client**; put a Termix API key with the scope `operations:read`
(read tools only) or `operations:run` where the config says `<your Termix API key>`.

Every action is a tool, plus `list_connections`, `list_hosts` and `list_resources`. Each call runs as the
key's user through Termix's operations, so permissions, approvals and history apply. Read tools, deploy and
restart (`coolify__deploy`, `coolify__restart`, `coolify__resource_deploy`, `coolify__resource_restart`)
always work; other tools that change something, start and stop included, answer "changes over MCP are
turned off" until an admin turns on **Allow changes over MCP**. Output never carries tokens, passwords, keys, env values or compose files, and long output is cut
at 8,000 characters. [API and MCP reference](api.md) lists every action with its route, run path, key scope,
MCP tool and a `curl` example.

## Server updates

The Coolify card on a Linked host shows the server's pending package updates: how many, how many are
security updates, whether a reboot is required and when it was last checked. Updates that restart Docker
(`docker-ce`, `containerd.io`, `runc` and the like) are called out, because installing them stops and
starts every container on the server. Kernel and core system packages are labelled too.

The numbers come from Coolify's own patch check, which runs on Coolify's schedule. **Check now** re-reads
them at once; the card then says which check it shows ("Checked over SSH", "Checked through Package
Manager" or "Coolify's check") and keeps Coolify's own record beside it until Coolify catches up.

Coolify has no API to check, install or reboot, so the plugin does it on the Linked host:

- **With the Package Manager plugin running**, Check now runs its `package-manager.list-updates` and Install
  updates runs its `package-manager.upgrade-all` on the host, so that plugin's own rules apply (turn on
  Packages for the host there, and its read only setting is respected).
- **Without it**, the plugin uses SSH on the Linked host with fixed commands for apt, dnf, yum or pacman.
  The SSH login must be root or have passwordless sudo, as Coolify itself needs.

**Install updates** shows every package it would change, with the Docker restarts highlighted, and runs
only after you confirm. **Reboot** asks you to type the server's exact name and warns that every Coolify
application, service and database on it goes down until it is back.

Who may do what:

- Reading the updates needs **View Coolify**.
- **Check now** needs **Operate Coolify resources** and connect access to the Linked host.
- **Install updates** needs **Operate Coolify resources** and edit access to the Linked host.
- **Reboot** needs **Administer Coolify** and edit access to the Linked host.

Check, install and reboot need a Linked host; a server without one answers `409` with cause `not-linked`
(sync it first). When the plugin can't tell whether you may open the host, it refuses.

They are also actions: `coolify.server-updates` (offered to the assistant and MCP),
`coolify.server-updates-check`, `coolify.server-updates-install` (input `confirm` must be on) and
`coolify.server-reboot` (input `confirmName` must be the server's name). The routes are
`GET /plugin-api/coolify/connections/:id/servers/:uuid/updates`, `POST …/updates/check`,
`POST …/updates/install` with `{ "confirm": true }` and `POST …/reboot` with `{ "confirmName": "<name>" }`.

## Container shells and database consoles

A resource's or part's Overview has **Open shell**, and a database (or a service's database part) also has
**Open database console**. Each opens a **Coolify shell** tab with Termix's own terminal (SSH Terminal's)
on the server's Linked host, running `docker exec` into the container.

- The plugin finds the container over SSH by Coolify's labels: the resource's uuid label first, then the
  labels Coolify used before 4.4, which carry the numeric id. A service part is found by its own uuid label,
  then by its compose service name.
- `bash` is used when the container has it, otherwise `sh`. `sudo` is added when the SSH user isn't root and
  isn't in the `docker` group.
- **Database consoles** start the engine's own client: `psql`, `mysql` or `mariadb`, `mongosh`, `redis-cli`
  (Redis and Dragonfly), `keydb-cli`, `clickhouse-client` or `sqlite3`. The credentials are the ones Coolify
  set in the container's environment, and they are read inside the container when the console starts. No
  password is in the command, sent to the browser or logged. Consoles also keep passwords out of process
  arguments, which any user on the server can list with `ps`: each client gets its password from an
  environment variable (`mongosh` reads it in JavaScript from `process.env`). An engine with no known console opens a shell
  instead, with a note.
- **Several containers** (a service with parts, say): pick one from the list.
- **Not running**: start the resource first.
- **Link this server first**: the resource's server has no Linked host yet; sync it from Coolify.
- **Open a server terminal once to trust this host's key**: Termix hasn't trusted the server's SSH key yet.
  **Open server terminal** opens one, where you confirm the key. Coolify's fingerprint for the key is shown
  so you can compare.
- Without the SSH Terminal plugin the tab shows the command to copy and run in a terminal on the server.

Shells and consoles need **Operate Coolify resources** and your own **connect** access to the Linked host.
A connection Grant at any level doesn't give that; only server access to the host does, because a shell on a
server can read every container's secrets.

The action `coolify.shell-command` (offered to the assistant and MCP) answers the same `docker exec` command,
or the list of containers to choose from, for a client with its own SSH. It makes the same checks. See
[the API](api.md).

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
