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
