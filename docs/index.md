Coolify for Termix brings your Coolify servers, applications, services and databases into Termix.

Connect Coolify instances, see what each API token can do, browse each connection's applications, services
and databases, deploy, start, stop and restart them, open a shell or database console in their containers,
read or follow their logs, see metrics and traffic, sync Coolify servers into Termix hosts, check and install
server updates, publish status pages, reach the whole Coolify API, and use other Termix plugins (DNS, Uptime,
Log Search and more) with them. Everything also works through Termix's operations API, the CLI, Automations,
the plugin's MCP endpoint and the `coolify.client` service for other plugins.

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
**Deployments**, **Servers** (with **Configure Coolify**, see below) and **Connections**. With no connection yet it opens on
Connections. With more than one, pick the connection in the section's header.

**Overview** counts the connection's resources by status:

- **Running**: running, healthy or with no health check.
- **Degraded**: restarting, dead, or unhealthy.
- **Stopped**: exited, stopped, paused or with no status. Coolify reports a resource you stopped
  yourself as exited, so exited counts as stopped, not degraded.
- **Deploying**: starting or building.

Service parts aren't counted on their own; their service's status covers them. Choose a tile to open the
Resources list filtered to that status. Below the tiles, **Deployments in progress** lists what Coolify has
queued or running on the connection, from the same read as the Deployments section.

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
the Resources list to pick from (see [Command palette](#command-palette)).

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
  (`coolify.server`) and security updates (`coolify.updates`), plus `coolify.deploying`, the resources
  deploying now across your connections. They read the same short caches as the tab, so many hosts on one
  connection cost one Coolify request. The security updates tile shows the newer of Coolify's own update
  check and the last **Check now** on the host card (see [Server updates](#server-updates)), and says which
  one; reading the tile never runs a check or connects over SSH.

Cancelling a run stops any of these actions before it reaches Coolify, and a deploy that waits stops
waiting.

## Beside a terminal

A terminal on a Linked host gets a **Coolify** panel in its panel bar. It lists the resources on that host's
Coolify server, each service followed by its parts, with their status. Each row has:

- **Shell**: opens a container shell in a new **Coolify shell** tab (see
  [Container shells](#container-shells-and-database-consoles)).
- **Logs**: shows the resource's logs in the panel (see [Logs](#logs)); **Back to resources** returns.
- **Restart** and **Deploy** (not on a part, which deploys with its service): each asks first, naming the
  resource, then runs the same action as the resource's header (see
  [Deploy, start, stop and restart](#deploy-start-stop-and-restart)).

The panel reads the same short resource cache as the Coolify tab. The buttons need **Operate Coolify
resources** and the connection's owner or an operate or configure grant; without them the panel lists the
resources only. When the terminal moves to another host, the panel starts empty and shows only the new
host's resources. A terminal on a host that isn't linked has no Coolify panel, and nothing is asked of
Coolify.

**Refresh resources** in the panel's header reads the list again, past the cache, which also recovers
from a failed read. Showing the panel again (back from a background tab, or opened again) reads it too. A
**Restart** or **Deploy** you confirm after the terminal moved to another host, or after the panel closed,
runs nothing.

## Command palette

The **Coolify** group in the command palette has:

- **Coolify: Deploy…** opens the Resources list. Pick a resource and deploy from its header.
- **Coolify: Open shell in…** opens the Resources list; the resource you pick opens in a **Coolify shell**
  tab (see [Container shells](#container-shells-and-database-consoles)). Without **Operate Coolify
  resources**, or on a connection shared with you only to view, the pick opens the resource instead.
- **Coolify: Logs of…** opens the Resources list; the resource you pick opens on its **Logs** view (see
  [Logs](#logs)). When you can't read its logs, it opens on the resource's Overview.
- **Coolify: Sync servers** opens the Servers section (see [Sync servers into hosts](#sync-servers-into-hosts)).

Running one while the Coolify tab is already open applies it to that tab.

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

## Running commands in containers through the API and MCP

The action `coolify.exec` runs one command inside a resource's or part's container and returns its output,
so an API key, the CLI, an Automation or an MCP client can do container work without a terminal. It is off
until two switches are both on:

1. An admin turns on **Allow running commands in containers through the API and MCP** in the plugin's
   settings.
2. The connection's owner turns on **Allow running commands in containers through the API and MCP** in the
   connection editor (Connections, edit). Only the owner sees and changes it, with **Configure Coolify**; a
   grantee can't, at any level. The action `coolify.connection-set-exec` does the same.

Each run then needs what logs need (**Operate Coolify resources**, and a connection you own or a Grant at
operate or configure), your own **edit** access to the Linked host (a connection Grant doesn't give it) and
a confirm. Over the plugin's MCP endpoint it also needs **Allow changes over MCP** and `confirmed: true`.
When any of these is missing, or can't be checked, the run is refused before anything reaches the server.

- The command runs with `sh` in the container. It is sent on standard input, never pasted into another
  command line.
- The timeout is at most 120 seconds (30 by default). The timeout, or cancelling the run, stops the command
  and closes the SSH connection. Stopping what the command started in the container is best effort: it
  needs `setsid` in the container (busybox and util-linux have it); without it only the command's own shell
  is killed, so don't assume background work has stopped.
- Limits are per user, not per resource: each user can run one command per resource at a time, three at
  once in all, and twenty a minute. Two users can still run commands in the same resource at once.
- Output (stdout and stderr together) is cut at 64 KB and masked the same way as logs, private key blocks
  included. Run history never keeps it; an MCP client gets it once in the answer.
- If the connection's address, token or Access settings change while a run starts, nothing is sent.
- Several matching containers answer with the list to choose from, as for shells.
- Every run is written to Termix's audit log with the host, the container and the lengths of the command
  and its output and the exit code, never the command or output itself.

Turning it on lets anyone with edit access to a Linked host and Operate Coolify resources run any command
in its containers, which can read their secrets. See [the API](api.md#running-commands-in-containers).

## Logs

A resource's or part's **Logs** view shows the container's recent logs. Pick how many lines (100 up to
10,000), turn **Timestamps** on, search the lines, or **Download** them as a text file.

Logs can hold secrets, so they need what lifecycle actions need: **Operate Coolify resources** and a
connection you own or a Grant at operate or configure. A view Grant can't read them, and the Logs view is
hidden without them. Each read is labelled with where it came from:

- **from Coolify**: read through Coolify's API, when the API token has `read:sensitive`.
- **from the server over SSH**: `docker logs` on the server's Linked host, used whenever Coolify can't be
  asked (a token without `read:sensitive`, a whole service, or a container picked from a list). That also
  needs your own **connect** access to the Linked host. The container is found the same way as for a shell,
  stopped ones included, and when several match you pick one. A server with no Linked host answers **Link
  this server first**.

Before any line reaches you, the connection's own token and Cloudflare Access secret are masked wherever
they appear, and so are passwords in URLs, credential query parameters, fields named like a password,
token or key (`DB_PASSWORD=…`) and `Authorization` credentials. If the connection's address, token or
Access settings change while logs are read, the read stops with `target-changed` and shows nothing from the
old target.

**Follow** streams new lines live over SSH while the view is shown. It stops when you turn it off, switch to
another view or resource, hide the tab or close it, and the `docker logs` process on the server is stopped
with it. Every message on the follow's socket, and a check every 15 seconds, confirms again that your
session is unlocked, that you still hold the permission, the Grant and the connection's same target, and
that you can still open the Linked host. Very busy logs are thinned to about 2,000 lines a second.
If the connection drops, the view says **Follow lost its connection** and tries again up to 3 times;
**Reconnect** starts it again by hand. When your access or the connection changed, it says why and
waits for **Reconnect**.

The action `coolify.logs-tail` (offered to the assistant and MCP) answers the same snapshot with its source,
only with `confirm: true`. Its text is a sensitive output, so run history never keeps it; over MCP the
caller gets the masked text in the answer. See
[the API](api.md).

## Deployments

An application's **Deployments** view lists its deployments, newest first, ten at a time, with their status,
commit message, commit, server and time, and whether one is a pull request preview or a rollback. Services
and databases have no Deployments view: Coolify deploys only applications on their own. Anyone who can view
the connection sees the history.

Opening a deployment shows its build log. Build logs can hold secrets, so opening one needs what container
logs need: **Operate Coolify resources** and a connection you own or a Grant at operate or configure. The
connection's token also needs `read:sensitive`; without it the view says Coolify keeps the log to itself.

- While the deployment runs, the log is read again every 2 seconds, only while the view is shown. It stops
  once the deployment finished, failed, was cancelled or skipped, and when you hide or close the view.
- Coolify marks some lines hidden, like the commands it ran. They stay hidden until you turn on **Show
  hidden lines**.
- Every line is masked as container logs are, and only the last 5,000 lines are shown.
- Moving to another deployment starts empty: a line from the one you left is never shown.
- **Cancel deployment** stops a queued or running deployment, after a confirm.

The actions `coolify.deployment-list`, `coolify.deployment-get` (the build log, with `confirm: true`) and
`coolify.deployment-cancel` do the same from Operations Center, Automations, the CLI, the Termix API and
MCP. See [the API](api.md).

### The Deployments section

The tab's **Deployments** section shows the whole connection: what Coolify has **queued and running** now,
and the **recent** ended deployments of its ten most recently deployed applications. Only deployments of the
connection's own applications are shown; one of another application in the same Coolify team never is. The
list is one read, kept 10 seconds and shared with the Overview, and read again every 10 seconds only while
the tab shows the Overview or this section. With **Operate Coolify resources** and operate access, a row
opens its build log, with **Cancel deployment** while it runs, as above.

**Deploy by tag** deploys every application and service on the connection that carries a Coolify tag. It
takes the tag, **Force rebuild**, and optionally a **Pull request** (that pull request's preview; services
have no previews and are left out) with its **Docker tag** (for a Docker image preview). **Review and
deploy** lists the resources it will deploy and asks first; only those are deployed, and if the tag hits
other resources by then nothing is deployed and you're asked to review again. It needs **Operate Coolify
resources** and operate access. The action `coolify.deploy-by-tag` does the same (a dry run lists the
resources), and `coolify.deployment-queue` reads the queue.

### The activity panel and the rail badge

The **Coolify activity** panel opens from its own sidebar button. It lists, across every connection you can
view:

- **Deploying now**: queued and running deployments.
- **Needs attention**: recent failed deployments, degraded resources and servers Coolify can't reach. A
  failed deployment stays here for 24 hours, or until a later deployment of the same application finishes.
  A resource you stopped (Coolify reports it as exited) is not degraded.

A deployment opens the Deployments section on its connection, with its build log when you have **Operate
Coolify resources** and operate access. A resource opens its detail. A server opens **Servers** when you own
the connection and have **Configure Coolify**, and the Overview otherwise. The panel reads again every 15
seconds while it is shown and stops when it is hidden.

The **Coolify** sidebar button shows a badge with the number of running deployments plus recent failures,
read once a minute. It is hidden at zero and without **View Coolify**. The panel, the badge, the tab and
the action `coolify.attention` share one cached read per connection, so they add no Coolify requests.

### Rollback

**Roll back** in the Deployments view lists the images Coolify can roll the application back to (on its
server, and in the registry when a registry image is set), marks the one running now, and rolls back to the
one you pick after a confirm that names its image tag. Coolify then queues a rollback deployment, which shows
in the history, the Deployments section and the activity panel. It needs **Operate Coolify resources** and a connection you own or a Grant at operate or
configure; services and databases have no rollback.

- The image must still be in Coolify's list when you confirm; the connection and your Grant are checked
  again right before Coolify is asked.
- Moving to another application, or closing the view, while the confirm is open sends nothing.

`coolify.rollback` (on a Linked host's application) and `coolify.resource-rollback` (by connection and uuid)
do the same from Operations Center, Automations, the CLI, the Termix API and MCP, with the image picked from
`coolify.rollback-images` or `coolify.resource-rollback-images`. They are destructive, so Termix confirms
them, and the confirm names the tag. A rollback is also the **undo** of a deploy: deploying an application
records the image it ran before, and undoing the run in Operations Center rolls back to it.

## Pull request previews

An application's **Previews** view lists its pull request previews: each one's status, domains, pull
request link and newest build. Services and databases have no Previews view. Anyone who can view the
connection sees the list; everything else needs **Operate Coolify resources** and a connection you own or a
Grant at operate or configure.

- **Deploy a preview** opens the preview of a pull request number, or redeploys it, after a confirm, and
  shows its build log. The Git provider is needed unless the application uses a GitHub or GitLab App
  source. A new Bitbucket preview also needs the commit to deploy, and a new preview of a Docker image
  application its image tag; both are checked before anything is sent, and a redeploy needs neither. Coolify needs a token with `write`
  and `deploy`.
- **Domains** replaces a preview's domains after a confirm. The list is checked before it is sent: comma
  separated `http://` or `https://` URLs with a DNS host name, an optional port and path, and no user name,
  password, query or repeats. A port you give is kept, `:80` and `:443` included, since Coolify uses it
  for routing, and the editor starts from the preview's domains with Coolify's ports put back, so
  saving unchanged keeps them. A bad list says what is wrong, next to the field, and sends nothing. A Docker Compose preview has one field per
  service Coolify lists, an empty one clearing that service's domains; while Coolify lists none, the
  preview's domains can't be edited here.
- **Delete** removes a preview (its containers, volumes and networks) after a destructive confirm.
- **Build log** opens the preview's newest build in the same live view as Deployments; **Logs** shows its
  container logs, masked as container logs are, with private keys masked across lines.
- Moving to another application starts empty: a preview of the one you left is never shown, and a confirm
  answered after you moved on, or closed the view, sends nothing.
- Coolify documents its preview API from 4.7.5. An older Coolify that lacks it gets a message to update
  Coolify instead of an error.

The actions `coolify.preview-list`, `coolify.preview-create`, `coolify.preview-domains`,
`coolify.preview-delete` and `coolify.preview-logs` (with `confirm: true`) do the same from Operations
Center, Automations, the CLI, the Termix API and MCP. Over MCP, deploying a preview and changing its domains
need `confirmed: true`. See [the API](api.md).

## Metrics and traffic

Coolify keeps no metric history itself: Sentinel, its agent on each server, does. The plugin reads it the way
Coolify does, plus through Coolify's own MCP endpoint when that is turned on for the instance.

- **Stats** (a tab on a resource or part): the container's CPU and memory history from Sentinel, for 1 hour,
  24 hours, 7 days or 30 days, and a **Live** readout from `docker stats` every 3 seconds while the tab is
  open. Leaving the tab stops it. You can have at most 3 live readouts open at once. If the connection
  drops, the readout says so, marks the last reading as not live and tries again up to 3 times;
  **Reconnect** starts it again by hand. When your access or the connection changed, it says why
  and waits for **Reconnect**.
- **Traffic** (a tab on applications): requests over time, top paths, and breakdowns by status code,
  country, browser and bot, for 24 hours, 7 or 30 days. It needs Coolify's traffic analytics on for the
  server; Coolify's API can't turn that on, so the tab says where to do it in Coolify. Client IPs show only
  when Coolify's **traffic IP mode** is `full` and you have **Configure Coolify** with owner or configure
  access to the connection; otherwise they never reach your screen.
- **Server metrics** (on a Linked host's Coolify card): CPU, memory, disk and load now, and the last hour of
  CPU. They come from Coolify's MCP `get_server_metrics` when it answers, which needs no SSH, and otherwise
  from Sentinel over SSH on the Linked host. The card says which.
- **Metrics are off for this server**: Coolify isn't collecting them. **Turn on metrics** changes the
  server's Sentinel settings in Coolify, after you confirm. It shows only to someone with **Configure
  Coolify** who owns the connection (or has a configure grant), and the token needs write in Coolify.

Reads from Sentinel run `docker exec coolify-sentinel curl` on the Linked host. The path comes from a fixed
template, the resource's uuid must be one plain path segment, and the URL is one quoted argument. Sentinel's
own token stays in its container and reaches curl on stdin, never on a command line. These reads pass the
same check as deploys (**Operate Coolify resources**, and the owner or an operate grant) and need your own
**connect** access to the Linked host, like shells; a server without a Linked host answers **Link this
server first**. If the connection's address, token or Access settings change while a read or a live readout
runs, it stops. Reads through Coolify's MCP need only **View Coolify** and access to the connection. History
reaches back at most 30 days (43,200 minutes), and only as far as Coolify keeps it.

The reads are also actions, offered to the assistant and MCP: `coolify.resource-metrics`,
`coolify.resource-traffic` and `coolify.server-metrics`. `coolify.enable-metrics` turns metrics on; over MCP
it needs **Allow changes over MCP** and `confirmed: true`. See [the API](api.md).

## Use with an MCP client

The plugin serves its own MCP endpoint at `/plugin-api/coolify/mcp`. The Connections view shows the address
and a client config under **Use with an MCP client**; put a Termix API key with the scope `operations:read`
(read tools only) or `operations:run` where the config says `<your Termix API key>`.

Every action is a tool, plus `list_connections`, `list_hosts` (a connection's Linked hosts),
`list_resources` and
`take_status_page_url`. Each call runs as the
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

Servers Coolify reaches through a Cloudflare tunnel sync into hosts that use SSH Terminal's own tunnel. See
[Cloudflare tunnels](tunnels.md).

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

DNS, Uptime, Log Search, Security Center, Host Metrics, Databases, Backups, File Manager, Tunnels and
Reverse Proxy each add a Coolify feature while they run. See [Companion plugins](companions.md).

## Public status pages

A status page is a public, read-only web page for the resources you pick, for people with no Termix account.
In **Connections**, choose **Status pages** on a connection you own, give the page a title, tick the
resources and choose **Publish**.

- **The link is shown once.** Copy it straight away: it carries the page's secret token, which the plugin
  doesn't store (it keeps only a hash). To get a link again, choose **New link**; the old link stops working
  at once. **Revoke** takes the page down.
- **What it shows:** each chosen resource's name, its status (running, degraded, stopped or deploying) and
  when it was last deployed, and "Updated" with the time of the last check. Never uuids, servers, domains,
  logs or anything secret.
- **How fresh it is:** a page view never calls Coolify. While a page is published the plugin checks Coolify
  every minute in the background, with the connection's own token; after errors it waits 1, 2, 5, then 15
  minutes. When the status is more than 5 minutes old the page says "Status may be out of date". The page
  reloads itself every 30 seconds, with no script.
- **Turning it off:** an admin can turn off **Allow public status pages**. New pages are then refused and
  every existing page answers "not found" until it is turned on again.
- **Addresses:** the page is `/plugin-api/coolify/status/<token>`, and `…/status/<token>.json` gives the same
  as JSON.

The same is available as actions: `coolify.status-page-list`, `coolify.status-page-create`,
`coolify.status-page-rotate` and `coolify.status-page-revoke`. Run history never holds a page's link: create
and rotate answer a `handoffId`, and the link is taken once with it. See [Status page URLs](api.md#status-page-urls).
Listing needs **View Coolify**; the rest need **Configure Coolify**.

## The full Coolify API

Everything in Coolify's API is reachable from Termix, checked against your permissions:

- The **API console** in the Coolify tab lists every operation you may call on a connection, with a form for
  its parameters and body. Plain reads run at once; reads of secrets or logs and anything that changes
  Coolify ask first, and a delete asks you
  to type the operation id. Secrets in answers are masked. With **Configure Coolify**, configure access and a
  token with `read:sensitive`, **Reveal** shows one value; each reveal is recorded in the audit log and
  nothing is kept.
- The actions `coolify.api-read` (reads) and `coolify.api-call` (anything, after a confirm) do the same from
  the CLI, Automations, the operations API and the plugin's MCP endpoint, where `coolify__api_call` follows
  **Allow changes over MCP**.

Each operation needs what the same thing needs in the app: reads need **View Coolify**, logs, deployments
and lifecycle need **Operate Coolify resources**, deletes, server transfers, cloud provisioning and instance settings
need **Administer Coolify**, and everything else **Configure Coolify**. Coolify's own "turn the API off" is
never run. See the [API and MCP reference](api.md#the-full-coolify-api) for the full rules.

## Permissions

Five Termix permissions, per-connection grants, **Allow changes over MCP** and confirms decide who may do
what. See [Permissions](permissions.md).

## More pages

- [Cloudflare tunnels](tunnels.md)
- [Permissions](permissions.md)
- [Companion plugins](companions.md)
- [Troubleshooting](troubleshooting.md)
- [API and MCP reference](api.md)
- [Coolify API coverage](coverage.md)

## Coolify versions

The plugin is built against Coolify v4.7.5 and the `main` and `next` branches, and supports Coolify 4.4.0
and newer. [Coolify API coverage](coverage.md) lists every Coolify API operation and how the plugin uses it.
