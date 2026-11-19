# API

Routes are under `/plugin-api/coolify/` on your Termix server and take Termix's sign in. Every route is also
described in the plugin's OpenAPI document. Actions run through Termix's operations API, the CLI, Automations,
the assistant and MCP.

## Container shells

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/shell`

Answers the `docker exec` command that opens a shell or database console in the container of a resource or
service part, to run on its server's Linked host. Needs **Operate Coolify resources** and your own `connect`
access to the Linked host.

Body (all optional):

| Field       | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `part`      | The uuid of a part of the service in the path                          |
| `container` | A container name from an earlier `choices` answer; it must still match |
| `console`   | `shell` (the default) or `db` for the database's own client            |

Answers:

| Status | Body                                                                        |
| ------ | --------------------------------------------------------------------------- |
| 200    | `{ hostId, title, container, command, fingerprints, note? }`                |
| 300    | `{ choices: [{ name, running, part }] }` when several containers match      |
| 400    | `invalid-input`, such as a container name outside `[A-Za-z0-9_.-]`          |
| 403    | missing permission, or `no-host-access` when you can't open the Linked host |
| 404    | no such resource or connection, or `container-not-found`                    |
| 409    | `not-linked`, `not-running`, or `host-key` with `{ hostId, fingerprints }`  |
| 502    | Coolify or SSH failed                                                       |

`command` never holds a password: a database console reads the container's own variables inside the
container, for example `docker exec -it <c> sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U
"$POSTGRES_USER" "$POSTGRES_DB"'`. `note: "no-console"` means a console was asked for an engine with none,
so the command opens a shell. `fingerprints` are Coolify's host key fingerprints for the server, when it has
them.

### Action `coolify.shell-command`

A read, offered to the assistant and MCP. Inputs: `connectionId`, `uuid`, and optionally `part`, `container`
and `console`, checked like the route. Its data is `{ hostId, container, command }`, or `{ choices }` when
several containers match. It needs **Operate Coolify resources** and `connect` access to the Linked host.

## Companion plugins on containers

Each route answers 404 `{ cause: "companion-missing", plugin }` while that plugin (`file-manager`,
`tunnels` or `reverse-proxy`) isn't running or doesn't offer the service the route needs. All of them need
**Operate Coolify resources** and your own `connect` access to the Linked host, and the resource must be one
of the connection's. A port is an integer from 1 to 65535. A companion plugin gets only the host id, the
container's internal address and the port, never the Coolify token.

### `GET /plugin-api/coolify/companions`

Which companion plugins run: `{ files, tunnels, reverseProxy, dns, uptime, logSearch, packageManager,
securityCenter, hostMetrics, databases, backups }`, each true or false, cached for 60 seconds. Needs **View
Coolify**.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/paths?part=`

Where the resource's files are on its Linked host, for File Manager: `{ hostId, dataDir, composeFile,
volumes }`. `dataDir` is `/data/coolify/applications/<uuid>`, `/data/coolify/services/<uuid>` (a part uses its
service's) or `/data/coolify/databases/<uuid>`. `volumes` lists each storage's place on the server: a bind
mount's or file's host path, or `/var/lib/docker/volumes/<name>/_data` for a Docker volume. File contents
are never read.

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/tunnel`

Body `{ port, part?, container? }`. Reads the container's address with `docker inspect` over SSH and asks
Tunnels to forward the port through the Linked host, listening on the Termix server's `127.0.0.1`.

| Status | Body                                                                                        |
| ------ | ------------------------------------------------------------------------------------------- |
| 200    | `{ name, hostId, targetPort, bindHost, bindPort }`; `name` is `web:<hostId>:coolify-<uuid>` |
| 300    | `{ choices: [{ name, running, part }] }` when several containers match                      |
| 400    | a bad port or body                                                                          |
| 403    | missing permission, or `no-host-access`                                                     |
| 404    | no such resource or connection, `container-not-found`, or `companion-missing`               |
| 409    | `not-linked`, `not-running` or `host-key`                                                   |
| 502    | SSH or Tunnels failed, or `bad-container-ip` when `docker inspect` gives no IP address      |

### `DELETE /plugin-api/coolify/connections/{id}/resources/{uuid}/tunnel/{port}?part=`

Stops the forward `web:<hostId>:coolify-<uuid>`. Answers `{ name, closed: true }`.

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/web-ui`

Body `{ port, scheme?, part?, container? }`, `scheme` `http` (the default) or `https`. Answers `{ url }`, a
one-time link that signs you in to the container's web UI through Reverse Proxy. Answers 409
`proxy-not-configured` while an admin hasn't set Reverse Proxy's Termix address and Web endpoint domain, and
otherwise like the tunnel route.

### Actions `coolify.companion-read` and `coolify.companion`

Inputs `connectionId`, `kind` and `params` (a JSON object).

- `coolify.companion-read` (a read, offered to the assistant and MCP): `companions` answers the map above;
  `files-paths` with `{ uuid, part? }` answers the paths route's data.
- `coolify.companion` (a change, not offered to the assistant or MCP; needs **Operate Coolify resources**):
  `tunnel-open` and `web-ui` with `{ uuid, port, part?, container?, scheme? }`, and `tunnel-close` with
  `{ uuid, port, part? }`, each answering like its route. The `url` of `web-ui` is a sensitive output: Termix
  drops it before the run is stored or shown, and the summary never holds it.
