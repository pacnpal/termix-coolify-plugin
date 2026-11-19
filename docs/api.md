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

## Logs

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/logs`

Recent logs of the container of a resource or service part, labelled with where they came from. Needs
**Operate Coolify resources**.

- `source: "coolify"`: read through Coolify's `/logs` endpoints, when you own the connection or have an
  operate or configure Grant and the token has `read:sensitive`.
- `source: "ssh"`: `docker logs` over SSH on the server's Linked host otherwise. That needs your own
  `connect` access to the Linked host.

Query (all optional):

| Field        | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `lines`      | Lines from the end, 1 or more; default 100. Anything above 10,000 is 10,000      |
| `timestamps` | `true` to add each line's time (Coolify's service part endpoints don't offer it) |
| `part`       | The uuid of a part of the service in the path                                    |
| `container`  | A container name from an earlier `choices` answer; read over SSH                 |

Answers:

| Status | Body                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| 200    | `{ source, text, container? }`; `container` is the one read over SSH                |
| 300    | `{ choices: [{ name, running, part }] }` when several containers match              |
| 400    | `invalid-input`: a bad `lines`, `timestamps`, `part` or `container`                 |
| 403    | missing permission, or `no-host-access` when you can't open the Linked host         |
| 404    | no such resource or connection, or `container-not-found`                            |
| 409    | `not-linked` (link the server first), or `host-key` with `{ hostId, fingerprints }` |
| 502    | Coolify or SSH failed                                                               |

### Socket `/plugin-ws/coolify/logs`

Follows a container's logs live over SSH (`docker logs -f`, from now on). Send JSON messages:

- `{ "type": "subscribe", "connectionId": 1, "uuid": "…", "part"?: "…", "container"?: "…", "timestamps"?: true }`
- `{ "type": "unsubscribe" }` stops the follow and keeps the socket open
- anything else, like `{ "type": "ping" }`, only gets checked and answered with `pong`

It answers `started { source: "ssh", container }`, `lines { lines, dropped? }`, `choices`, `stopped`,
`ended` (the container's log stream ended) and `error { cause, error }`. Every message is checked first:
your session must be unlocked, and you must hold **Operate Coolify resources**, reach the connection and
have `connect` access to the Linked host. A refusal (`locked`, `forbidden`, `not-found`, `no-host-access`)
stops the follow and closes the socket with code 1008. Closing the socket stops `docker logs` on the server.

### Action `coolify.logs-tail`

A read, offered to the assistant and MCP. Inputs: `connectionId`, `uuid`, and optionally `part`,
`container`, `lines` (up to 10,000) and `timestamps`, checked like the route. Its data is
`{ source, text, container? }`, or `{ choices }` when several containers match. `text` is a sensitive
output: run history never keeps it. It needs **Operate Coolify resources**, and for logs over SSH your own
`connect` access to the Linked host.
