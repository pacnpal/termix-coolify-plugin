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

## Metrics and traffic

Reads from Sentinel run over SSH on the server's Linked host and need **Operate Coolify resources** and your
own `connect` access to it. `minutes` is a whole number from 1; larger than 43,200 (30 days) reads as
43,200. Every route answers `{ error, cause }` on failure:

| Status | Cause                                                                         |
| ------ | ----------------------------------------------------------------------------- |
| 400    | `invalid-input`: a bad minutes, view, dim, range, limit or uuid               |
| 403    | missing permission, `forbidden`, or `no-host-access`                          |
| 404    | no such resource, server or connection, or another user's                     |
| 409    | `metrics-off` with `{ canEnable }`, `traffic-off`, `not-linked` or `host-key` |
| 502    | Coolify, SSH or Sentinel failed (`sentinel-failed`, `ssh-failed`)             |

`canEnable` is true only when you hold **Configure Coolify** and own the connection or have a configure
Grant.

### `GET /plugin-api/coolify/connections/{id}/servers/{uuid}/metrics?minutes=`

`{ source: "mcp" | "sentinel", minutes, current, series }`. `current` holds `cpu_percent`,
`memory_used_bytes`, `memory_total_bytes`, `disk_used_percent`, `load1`, `network_rx_bytes_per_sec` and
`network_tx_bytes_per_sec` when known (null when the server is offline); `series` holds
`[timestamp ms, value]` pairs by the same names. From Coolify's MCP `get_server_metrics` when it answers
(needs **View Coolify** only), else from Sentinel over SSH.

### `POST /plugin-api/coolify/connections/{id}/servers/{uuid}/metrics/enable`

Turns metrics on in the server's Sentinel settings (`PATCH /servers/{uuid}/sentinel` in Coolify). Needs
**Configure Coolify** and owner or configure access to the connection. Answers `{ enabled: true }`.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/metrics?minutes=`

`{ source: "sentinel", minutes, cpu, memory }`: the container's CPU percent and memory used in bytes, as
`[timestamp ms, value]` pairs, from Sentinel's `/api/container/<uuid>/cpu/history` and `/memory/history`.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/traffic`

For applications. Query: `view` (`overview`, the default, `paths`, `series` or `breakdown`), `dim` (for a
breakdown: `status`, `method`, `country`, `city`, `referer`, `browser`, `os`, `device`, `protocol`,
`scheme`, `tls`, `cache`, `bot`, `agent`, `ip` or `useragent`), `range` (`24h`, the default, `7d` or `30d`)
and `limit` (1 to 1000, for paths and breakdowns). Answers `{ view, dim?, range, ipsHidden, data }`, where
`data` is Sentinel's answer. Unless Coolify's `traffic_ip_mode` is `full`, `ipsHidden` is true, an `ip`
breakdown answers no rows without asking Sentinel, and IP fields are left out of every other view.

### Socket `/plugin-ws/coolify/stats`

Send `{ connectionId, uuid, part?, container? }`. The socket answers
`{ type: "stats", container, cpu, memPct, memBytes, netRx, netTx, at }` every 3 seconds from
`docker stats --no-stream`, `{ type: "choices", choices }` when several containers match, or
`{ type: "error", error, cause }` and stops. Send `{ type: "unsubscribe" }` or close it to stop. Each tick
checks again that your session is unlocked, **Operate Coolify resources**, your access to the connection and
your `connect` access to the Linked host; a locked session closes the socket with 1008.

### Actions `coolify.resource-metrics`, `coolify.resource-traffic` and `coolify.server-metrics`

Reads, offered to the assistant and MCP, with the same data and checks as the routes. Inputs:
`connectionId` and `uuid` (or `serverUuid`), plus `minutes`, or `view`, `dim` and `range` for traffic.
`coolify.resource-metrics` and `coolify.resource-traffic` need **Operate Coolify resources**;
`coolify.server-metrics` needs **View Coolify**, and Operate as well when it falls back to Sentinel.
