Coolify for Termix brings your Coolify servers, applications, services and databases into Termix.

So far you can connect Coolify instances, see what each API token can do, browse each connection's
applications, services and databases, deploy, start, stop and restart them, open a shell or database console
in their containers, sync Coolify servers into Termix hosts, and use other Termix plugins (DNS, Uptime, Log
Search and more) with them. Logs and the rest come with the rest of release 1.0.0.

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

## Container shells and database consoles

A resource's or part's **Shell** view has **Open shell**, and a database (or a service's database part) also
has **Open database console**. Each opens a **Coolify shell** tab with Termix's own terminal (SSH Terminal's)
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
  environment variable (`mongosh` reads it in JavaScript from `process.env`). An engine with no known console
  opens a shell instead, with a note.
- **Several containers** (a service with parts, say): pick one from the list.
- **Not running**: start the resource first.
- **Link this server first**: the resource's server has no Linked host yet; sync it from Coolify.
- **Open a server terminal once to trust this host's key**: Termix hasn't trusted the server's SSH key yet.
  **Open server terminal** opens one, where you confirm the key. Coolify's fingerprint for the key is shown
  so you can compare.
- If the connection's address, token or Access token changes while a shell is being opened, it stops and asks
  you to open it again, so a shell never reaches a container of another Coolify.
- Without the SSH Terminal plugin the tab shows the command to copy and run in a terminal on the server.

Shells and consoles are checked like deploys: **Operate Coolify resources**, and the connection's owner or an
operate or configure grant. They also need your own **connect** access to the Linked host, because a shell on
a server can read every container's secrets.

The action `coolify.shell-command` (offered to the assistant and MCP) answers the same `docker exec` command,
or the list of containers to choose from, for a client with its own SSH. It makes the same checks. See
[the API](api.md).

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
     kept for later syncs. Every server still in Coolify has the same **Address Termix uses** field, so
     you can give any of them another address; leave it empty to use the one Coolify has.
   - **No key to copy**: when the token can't read keys (it lacks `read:sensitive`) or an admin turned off
     **Allow copying Coolify SSH keys**, pick one of your Termix credentials for the server. Only your own
     credentials are accepted. A picked credential you no longer have blocks the server and shows the picker
     again until you pick another; one that couldn't be checked can be picked again or tried as it is.
     When copying a server's key fails (Coolify refuses to send it, or sends no key), the server asks for a
     credential the same way until you pick one or a later sync copies the key.
   - **Behind a Cloudflare tunnel**: see [Servers behind Cloudflare tunnels](#servers-behind-cloudflare-tunnels).
3. With keys readable, each Coolify key is copied once into a Termix credential named
   **Coolify: <connection> / <key>** and shared by every server that uses it. It is reused on later syncs
   and replaced when the key's fingerprint changes, or when you deleted that credential in Termix (the
   key is copied again). When your credentials can't be read to check, the server isn't synced and says
   so. Every copy is written to the audit log. The key is
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

Syncs, unlinks and removing a connection run one at a time for each connection, so two people (or two
tabs) syncing at once never make two hosts for one server. If a host was made but its link couldn't be
saved, the host is deleted again rather than left locked. A sync that was waiting while its connection
was removed finds the connection gone and creates nothing.

A sync works on one snapshot of the connection: the server list, the Coolify address in host notes and
the Cloudflare Access token written on tunnelled hosts all come from the same read. If someone changes
the connection's address, token, Access token or TLS settings while a sync runs, the sync stops at its
next step that would save, copy a key or change a host, with **The connection's address, token or
Cloudflare Access settings changed during the sync** (`target-changed`). No host gets the new settings,
and a host made just before the change is removed again. Sync again.

Syncing and unlinking need **Configure Coolify** and only the connection's owner can do them; the preview
needs **View Coolify**. They are also actions: `coolify.sync-preview` (offered to the assistant and MCP),
`coolify.sync-apply` (without a server list it syncs every server with its saved address and credential)
and `coolify.unlink`.

### Servers behind Cloudflare tunnels

When Coolify reaches a server through a Cloudflare tunnel, its Linked host uses the **SSH Terminal**
plugin's own Cloudflare tunnel, which then carries every SSH connection to that host: the terminal, files,
Docker and this plugin. Sync sets:

- the host address to the tunnel hostname (Coolify's address for the server), with Coolify's port and user;
- SSH Terminal's tunnel settings on the host: tunnel on, the tunnel hostname, and port 443;
- the connection's Cloudflare Access service token, when one is set, as SSH Terminal's service token ID and
  secret. The token is written only into those host settings. It never appears in the preview, sync
  results, run history, logs or the audit log.

Each sync writes these settings in full, so nothing stale stays behind: when you remove the connection's
Access token, the next sync clears it from tunnelled hosts. When a server is no longer behind a tunnel, the
next sync turns SSH Terminal's tunnel off on its host and clears the tunnel hostname and token. Termix only
takes SSH Terminal's settings while it is on, so until then that server says **This server is no longer
behind a Cloudflare tunnel, but its host still has SSH Terminal's tunnel settings**, with **Open Plugins**,
and its host is left as it is. Hosts that were never tunnelled don't need SSH Terminal.

Hosts linked before 1.0's database migration have no record of whether sync gave them tunnel settings, so
they count as possibly tunnelled: once their server is a plain one, they may need SSH Terminal on for one
sync to confirm their tunnel is off. After that they sync without it.

This needs **SSH Terminal 1.2.0 or newer**, turned on. Version 1.0.3 tunnelled only its own terminal tab.
Until then a tunnelled server can't sync and says why, with an **Open Plugins** button that opens Termix's
Plugins tab:

- **Turn on the SSH Terminal plugin to reach servers behind Cloudflare tunnels**: SSH Terminal isn't
  installed or is turned off. It is also shown when the plugin list can't be read, so a tunnelled host is
  never made without a tunnel.
- **Update SSH Terminal to 1.2.0 or newer; older versions tunnel only the terminal.**

When you add a connection and Coolify has tunnelled servers, the setup checklist shows the same check once.

A tunnelled Linked host's Coolify card says **Tunnel: through SSH Terminal (Cloudflare)** and has **Open
tunnel settings**, which opens the host editor. SSH Terminal's tunnel fields there stay read only while the
host is linked; unlink it to change them by hand.

## Server updates

The Coolify card on a Linked host shows the server's pending package updates: how many, how many are
security updates, whether a reboot is required and when it was last checked. Updates that restart Docker
(`docker-ce`, `containerd.io`, `runc` and the like) are called out, because installing them stops and
starts every container on the server. Kernel and core system packages are labelled too.

The numbers come from Coolify's own patch check, which runs on Coolify's schedule. **Check now** re-reads
them at once; the card then says which check it shows ("Checked over SSH", "Checked through Package
Manager" or "Coolify's check") and keeps Coolify's own record beside it until Coolify catches up. When a check failed, the card
says so with the error instead of a count or "Up to date", offers no Install, and the security updates tile
is unknown.

Coolify has no API to check, install or reboot, so the plugin does it on the Linked host:

- **With the Package Manager plugin running**, Check now runs its `package-manager.list-updates` and Install
  updates runs its `package-manager.upgrade-all` on the host, so that plugin's own rules apply (turn on
  Packages for the host there, and its read only setting is respected).
- **Without it**, the plugin uses SSH on the Linked host with fixed commands for apt, dnf, yum or pacman.
  The SSH login must be root or have passwordless sudo, as Coolify itself needs. Every check refreshes the
  package lists first; on Arch it uses `checkupdates` from pacman-contrib, which never touches the real
  package database, and without it the check fails rather than read stale lists.

**Install updates** shows every package it would change, with the Docker restarts highlighted, and runs
only after you confirm. **Reboot** asks you to type the server's exact name and warns that every Coolify
application, service and database on it goes down until it is back.

Who may do what:

- Reading the updates needs **View Coolify**.
- **Check now** needs **Operate Coolify resources** and connect access to the Linked host.
- **Install updates** needs **Operate Coolify resources** and edit access to the Linked host.
- **Reboot** needs **Administer Coolify** and edit access to the Linked host.

Check, install and reboot need a Linked host; a server without one answers `409` with cause `not-linked`
(sync it first). When the plugin can't tell whether you may open the host, it refuses. A server the
connection's Coolify no longer has answers `404`. If the connection's address, token or Cloudflare Access
settings change while an action runs, it stops before the next command with `409` and cause
`target-changed`, and a check kept from before the change is no longer shown. Installing and rebooting
refresh the resource list and the status tiles, and a check still running then is not kept. When Termix's
plugin list can't be read, Check now and Install updates refuse (`companions-unknown`) instead of guessing
that Package Manager is off. A check whose package lists can't be read answers `check-failed`, never "up
to date". The card shows whichever check is newest, the plugin's own or Coolify's.

They are also actions: `coolify.server-updates` (offered to the assistant and MCP),
`coolify.server-updates-check`, `coolify.server-updates-install` (input `confirm` must be on) and
`coolify.server-reboot` (input `confirmName` must be the server's name). The routes are
`GET /plugin-api/coolify/connections/:id/servers/:uuid/updates`, `POST …/updates/check`,
`POST …/updates/install` with `{ "confirm": true }` and `POST …/reboot` with `{ "confirmName": "<name>" }`.

## Other Termix plugins

Built for DNS 1.1, Uptime 1.0.1, Log Search 1.1, Security Center 1.1, Host Metrics 1.4.1, Databases 1.3 and
Backups 1.1. When one of these Termix plugins is installed and running, its Coolify feature appears. When it isn't, that
feature hides and nothing else changes. The plugin checks every minute. When Termix's plugin list can't be
read, every one of them hides and their routes and actions answer `companions-unknown` instead of acting.

| Plugin          | What appears                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------- |
| DNS             | **Create DNS record** for one of a resource's domains                                        |
| Uptime          | The status of the Uptime monitors at or under one of a resource's URLs                       |
| Log Search      | **Search logs across servers**, over Docker logs, with the resource's uuid as the query      |
| Security Center | The score and critical findings of a Linked host, on its Coolify card                        |
| Host Metrics    | A **Coolify on this server** card on a Linked host: its applications, services and databases |
| Databases       | Whether a Coolify database already has a saved login there, with **Open Databases**          |
| Backups         | Failed Termix backup jobs on a Linked host                                                   |

- **DNS records.** The name must be one of the resource's domains. Leave **Points to** empty to use the
  server's address. Only records made here can be removed from here, after you confirm, and only while
  the connection's Coolify still lists the resource. The route needs `{ "confirm": true }` (or
  `?confirm=true`). The record is saved before the DNS plugin is asked, so one it makes can always be
  removed. The DNS plugin needs a zone for the name, and your own DNS permissions apply.
- **Uptime.** Uptime can't create HTTP monitors for another plugin, so **Create monitor in Uptime** opens the
  Uptime tab. A monitor belongs to a resource when it checks the resource's host at or under its path
  (`/app` covers `/app/health`, not `/admin`). A resource's monitors can be paused and resumed with the
  `coolify.companion` action; if one fails part way, the ones already changed are set back.
- **Log Search** searches every server's Docker logs and can't filter by host. The results say where they
  came from.
- **Databases** only shows names: logins and database names, never a password. A login matches a database
  by its uuid, or by its name only when no other database on that server has the same name.

Who may use them:

- Reading (Uptime, Security Center, Host Metrics, Databases, Backups, listing DNS records) needs **View
  Coolify** and the connection (yours, or a grant).
- **Search logs** needs **Operate Coolify resources** and an operate grant, because it shows log output.
- Creating and removing DNS records needs **Configure Coolify** and a configure grant.
- Anything about a Linked host also needs your own access to that host in Termix, and the server must still
  be in that connection's Coolify.
- If the connection's address, token or Access settings change while one of these runs, it stops before
  the next call to the other plugin and answers `target-changed`.

They are also actions: `coolify.companion-read` (offered to the assistant and MCP) reads any of them, and
`coolify.companion` creates DNS records and pauses or resumes Uptime monitors. Removing a DNS record is
its own action, `coolify.companion-dns-remove`: it is marked destructive, so Termix asks for a confirm, and
it is never offered to the assistant or MCP. The plugin never
sends a Coolify token or any other secret to another plugin.

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
