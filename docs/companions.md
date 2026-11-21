---
title: Companion plugins
order: 40
---

# Companion plugins

Other Termix plugins add Coolify features while they run. Nothing about them is required.

## Plugins that read and change with Coolify

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
  `coolify.companion` action. Monitors already paused (or running) are left alone, and if one fails part
  way, each monitor already changed goes back to how it was.
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

## Plugins on containers

Built for File Manager 1.2.2, Tunnels 1.4 and Reverse Proxy 1.2.1. When one of these runs, a resource's or
part's Overview shows a **Companion plugins** group. Each button hides while its plugin isn't running.

| Button                | Plugin        | What it does                                                                                  |
| --------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| **Browse files**      | File Manager  | Opens the Linked host at the resource's data folder                                           |
| **Edit compose file** | File Manager  | Opens the compose file Coolify wrote there in the editor                                      |
| **Open** _path_       | File Manager  | Opens one of the resource's storages on the server                                            |
| **Reach from here**   | Tunnels       | Forwards a container port through the Linked host, listening on the Termix server             |
| **Open web UI**       | Reverse Proxy | A one-time signed-in link to the container's web port, with no tunnel or public domain needed |

- **Data folders** are Coolify's own: `/data/coolify/applications/<uuid>`, `/data/coolify/services/<uuid>`
  (a service's parts share it) and `/data/coolify/databases/<uuid>`. The compose file is
  `docker-compose.yaml` for an application and `docker-compose.yml` for a service or database. Storages come
  from Coolify's storages list. A file storage is offered only inside the resource's data folder. A volume
  is offered at the path on the server Coolify reports for it (a bind mount, anywhere but `/`), or else at
  its Docker folder `/var/lib/docker/volumes/<name>/_data`. Paths with `..` are refused and the rest are
  normalized. A storage's mount path inside the container isn't on the server, so it isn't offered.
- **Reach from here** reads the container's internal address with `docker inspect` over SSH and asks
  Tunnels to forward the port you enter to it. Only a private container address is used (10/8, 172.16/12,
  192.168/16 or IPv6 unique local, IPv4 first when a container has both); loopback, `0.0.0.0`, link-local addresses such as `169.254.169.254` and
  public addresses are refused (`bad-container-ip`). The plugin asks Tunnels to listen on the Termix
  server's `127.0.0.1`; Tunnels decides, and the answer shows where it listens. The forward is named
  `web:<hostId>:coolify-<uuid>` and isn't saved in your Tunnels list. **Stop** closes it, and only a
  forward you opened here on that port can be stopped from here. One forward runs per resource and Linked
  host (someone else's answers `tunnel-in-use`), and each person may have 5 open (`too-many-tunnels`).
  Forwarding to your own computer isn't possible: Tunnels offers that only from the desktop app's own
  tunnels.
- The **Tunnels tab** gets a **Coolify** view listing the resources of the host's Coolify server (or every
  connection's, on the hostless tab), each with a port to forward and stop. On a host that isn't a Linked
  host it says so and lists nothing.
- **Open web UI** needs Reverse Proxy's endpoint set up: an admin sets its **Termix address** and **Web
  endpoint domain** (a wildcard DNS name pointing at the proxy). Until then the button explains that. The
  link signs you in once; ask for a new one next time.
- When there are several containers (a service), pick one from the list.

Who may use them:

- **Browse files** needs **View Coolify**, the connection (yours, or a grant) and your own view access to
  the Linked host. File Manager checks its own access when it opens.
- **Reach from here** and **Open web UI** reach the server over SSH, so they need **Operate Coolify
  resources**, an operate grant and your own **connect** access to the Linked host, like shells.
- If the connection's address, token or Access settings change while one of these runs, it stops before
  the next SSH command or call to the other plugin, and after `docker inspect`, and answers
  `target-changed`: nothing is opened.
- The plugin never hands a companion plugin a Coolify or Termix token: only the host, the container's
  internal address and the port.

The actions `coolify.companion-read` (kind `files-paths`) and `coolify.companion` (kinds `tunnel-open`,
`tunnel-close` and `web-ui`) do the same from Termix's API, the CLI and Automations. Over MCP,
`tunnel-open` and `web-ui` need "Allow changes over MCP" and `confirmed: true`. The web UI link is a
sensitive output: it is never kept in run history, and an MCP call gets it once. See [the API](api.md).
