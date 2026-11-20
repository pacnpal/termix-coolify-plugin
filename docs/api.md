# API and MCP reference

Everything Coolify for Termix does works without the browser: through the plugin's own routes, through
Termix's operations API and through the plugin's MCP endpoint.

- **Plugin routes** live under `/plugin-api/coolify/` and take a Termix API key with no scope, acting as the
  key's user. Termix's API docs list each one.
- **Operations** run through Termix's `/operations/<id>/run` with the same checks, approvals and history as
  the UI. A key scoped to `operations:run` runs any of them; `operations:read` runs only reads.
- **MCP**: point an MCP client at `/plugin-api/coolify/mcp` (see below). Each operation is a tool.

In the examples, `$TERMIX` is your Termix address, like `https://termix.example.com`, and `$TERMIX_API_KEY`
is a Termix API key. Input fields marked secret (tokens, Cloudflare Access values) reach the action but never
appear in run history.

## Operations

| Operation                        | Plugin route                                                               | REST run path                                    | Key scope                             | MCP tool                          | Example                                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coolify.list-connections`       | `GET /plugin-api/coolify/connections`                                      | `/operations/coolify.list-connections/run`       | `operations:read` or `operations:run` | `coolify__list_connections`       | `curl -X POST "$TERMIX/operations/coolify.list-connections/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                            |
| `coolify.connection-probe`       | `POST /plugin-api/coolify/connections/:id/probe`                           | `/operations/coolify.connection-probe/run`       | `operations:read` or `operations:run` | `coolify__connection_probe`       | `curl -X POST "$TERMIX/operations/coolify.connection-probe/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                          |
| `coolify.list-resources-all`     | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.list-resources-all/run`     | `operations:read` or `operations:run` | `coolify__list_resources_all`     | `curl -X POST "$TERMIX/operations/coolify.list-resources-all/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                        |
| `coolify.resource-get`           | `GET /plugin-api/coolify/connections/:id/resources/:uuid`                  | `/operations/coolify.resource-get/run`           | `operations:read` or `operations:run` | `coolify__resource_get`           | `curl -X POST "$TERMIX/operations/coolify.resource-get/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>"}}'`                                                     |
| `coolify.sync-preview`           | `GET /plugin-api/coolify/connections/:id/servers`                          | `/operations/coolify.sync-preview/run`           | `operations:read` or `operations:run` | `coolify__sync_preview`           | `curl -X POST "$TERMIX/operations/coolify.sync-preview/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                              |
| `coolify.connection-create`      | `POST /plugin-api/coolify/connections`                                     | `/operations/coolify.connection-create/run`      | `operations:run`                      | `coolify__connection_create`      | `curl -X POST "$TERMIX/operations/coolify.connection-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"name":"Prod","baseUrl":"https://coolify.example.com","token":"<Coolify API token>"}}'`        |
| `coolify.connection-update`      | `PATCH /plugin-api/coolify/connections/:id`                                | `/operations/coolify.connection-update/run`      | `operations:run`                      | `coolify__connection_update`      | `curl -X POST "$TERMIX/operations/coolify.connection-update/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","name":"Production"}}'`                                                     |
| `coolify.connection-delete`      | `DELETE /plugin-api/coolify/connections/:id`                               | `/operations/coolify.connection-delete/run`      | `operations:run`                      | `coolify__connection_delete`      | `curl -X POST "$TERMIX/operations/coolify.connection-delete/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"},"confirmed":true}'`                                                        |
| `coolify.sync-apply`             | `POST /plugin-api/coolify/connections/:id/sync`                            | `/operations/coolify.sync-apply/run`             | `operations:run`                      | `coolify__sync_apply`             | `curl -X POST "$TERMIX/operations/coolify.sync-apply/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                |
| `coolify.unlink`                 | `POST /plugin-api/coolify/connections/:id/servers/:uuid/unlink`            | `/operations/coolify.unlink/run`                 | `operations:run`                      | `coolify__unlink`                 | `curl -X POST "$TERMIX/operations/coolify.unlink/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                                       |
| `coolify.list-resources`         | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.list-resources/run`         | `operations:read` or `operations:run` | `coolify__list_resources`         | `curl -X POST "$TERMIX/operations/coolify.list-resources/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                              |
| `coolify.deploy`                 | `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`          | `/operations/coolify.deploy/run`                 | `operations:run`                      | `coolify__deploy`                 | `curl -X POST "$TERMIX/operations/coolify.deploy/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{"force":false,"wait":true}}'`                                  |
| `coolify.start`                  | `POST /plugin-api/coolify/connections/:id/resources/:uuid/start`           | `/operations/coolify.start/run`                  | `operations:run`                      | `coolify__start`                  | `curl -X POST "$TERMIX/operations/coolify.start/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{}}'`                                                            |
| `coolify.restart`                | `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`         | `/operations/coolify.restart/run`                | `operations:run`                      | `coolify__restart`                | `curl -X POST "$TERMIX/operations/coolify.restart/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{}}'`                                                          |
| `coolify.stop`                   | `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`            | `/operations/coolify.stop/run`                   | `operations:run`                      | `coolify__stop`                   | `curl -X POST "$TERMIX/operations/coolify.stop/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{},"confirmed":true}'`                                            |
| `coolify.sync-host`              | `POST /plugin-api/coolify/connections/:id/sync`                            | `/operations/coolify.sync-host/run`              | `operations:run`                      | `coolify__sync_host`              | `curl -X POST "$TERMIX/operations/coolify.sync-host/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"input":{}}'`                                                                                        |
| `coolify.resource-deploy`        | `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`          | `/operations/coolify.resource-deploy/run`        | `operations:run`                      | `coolify__resource_deploy`        | `curl -X POST "$TERMIX/operations/coolify.resource-deploy/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","force":false}}'`                                    |
| `coolify.resource-restart`       | `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`         | `/operations/coolify.resource-restart/run`       | `operations:run`                      | `coolify__resource_restart`       | `curl -X POST "$TERMIX/operations/coolify.resource-restart/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>"}}'`                                                 |
| `coolify.resource-action`        | `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`            | `/operations/coolify.resource-action/run`        | `operations:run`                      | `coolify__resource_action`        | `curl -X POST "$TERMIX/operations/coolify.resource-action/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","action":"stop"},"confirmed":true}'`                 |
| `coolify.signal-degraded`        | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.signal-degraded/run`        | `operations:read` or `operations:run` | `coolify__signal_degraded`        | `curl -X POST "$TERMIX/operations/coolify.signal-degraded/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                             |
| `coolify.signal-server`          | `GET /plugin-api/coolify/connections/:id/servers`                          | `/operations/coolify.signal-server/run`          | `operations:read` or `operations:run` | `coolify__signal_server`          | `curl -X POST "$TERMIX/operations/coolify.signal-server/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                               |
| `coolify.signal-updates`         | `GET /plugin-api/coolify/connections/:id/servers`                          | `/operations/coolify.signal-updates/run`         | `operations:read` or `operations:run` | `coolify__signal_updates`         | `curl -X POST "$TERMIX/operations/coolify.signal-updates/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                              |
| `coolify.signal-deploying`       | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.signal-deploying/run`       | `operations:read` or `operations:run` | `coolify__signal_deploying`       | `curl -X POST "$TERMIX/operations/coolify.signal-deploying/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                            |
| `coolify.shell-command`          | `POST /plugin-api/coolify/connections/:id/resources/:uuid/shell`           | `/operations/coolify.shell-command/run`          | `operations:read` or `operations:run` | `coolify__shell_command`          | `curl -X POST "$TERMIX/operations/coolify.shell-command/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","console":"shell"}}'`                                  |
| `coolify.server-updates`         | `GET /plugin-api/coolify/connections/:id/servers/:uuid/updates`            | `/operations/coolify.server-updates/run`         | `operations:read` or `operations:run` | `coolify__server_updates`         | `curl -X POST "$TERMIX/operations/coolify.server-updates/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                               |
| `coolify.server-updates-check`   | `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/check`     | `/operations/coolify.server-updates-check/run`   | `operations:run`                      | `coolify__server_updates_check`   | `curl -X POST "$TERMIX/operations/coolify.server-updates-check/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                         |
| `coolify.server-updates-install` | `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/install`   | `/operations/coolify.server-updates-install/run` | `operations:run`                      | `coolify__server_updates_install` | `curl -X POST "$TERMIX/operations/coolify.server-updates-install/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirm":true},"confirmed":true}'`       |
| `coolify.server-reboot`          | `POST /plugin-api/coolify/connections/:id/servers/:uuid/reboot`            | `/operations/coolify.server-reboot/run`          | `operations:run`                      | `coolify__server_reboot`          | `curl -X POST "$TERMIX/operations/coolify.server-reboot/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirmName":"<server name>"},"confirmed":true}'` |
| `coolify.companion-read`         | `GET /plugin-api/coolify/connections/:id/servers/:uuid/security`           | `/operations/coolify.companion-read/run`         | `operations:read` or `operations:run` | `coolify__companion_read`         | `curl -X POST "$TERMIX/operations/coolify.companion-read/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","kind":"security","params":{"serverUuid":"<server uuid>"}}}'`                  |
| `coolify.companion`              | `POST /plugin-api/coolify/connections/:id/resources/:uuid/dns`             | `/operations/coolify.companion/run`              | `operations:run`                      | `coolify__companion`              | `curl -X POST "$TERMIX/operations/coolify.companion/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","kind":"dns","params":{"uuid":"<resource uuid>","fqdn":"app.example.com"}}}'`       |
| `coolify.companion-dns-remove`   | `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/dns/:recordId` | `/operations/coolify.companion-dns-remove/run`   | `operations:run`                      | `coolify__companion_dns_remove`   | `curl -X POST "$TERMIX/operations/coolify.companion-dns-remove/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","recordId":"1"},"confirmed":true}'`             |

### Lifecycle routes

`POST /plugin-api/coolify/connections/:id/resources/:uuid/{start|stop|restart|deploy}` (deploy takes
`{ "force": true|false }`) needs **Operate Coolify resources** and the owner or an operate or configure grant.
It answers `{ "deploymentUuid": "…" | null }`, or 202 `{ "status": "pending", "runId" }` while an approval
waits. With a Linked host it runs the resource-scope action on that host (`hostId`, `resourceKey` = the uuid),
so the run is in the host's history; without one it runs `coolify.resource-deploy`, `coolify.resource-restart`
or `coolify.resource-action`. A uuid that isn't one of the connection's resources is 404, a missing permission
or a view grant 403, and a Coolify refusal 502 with a `cause` such as `forbidden-ability`.

```bash
curl -X POST "$TERMIX/plugin-api/coolify/connections/1/resources/<resource uuid>/deploy" \
  -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"force":false}'
```

### Container shells

`POST /plugin-api/coolify/connections/:id/resources/:uuid/shell` answers the `docker exec` command that opens
a shell or database console in the container of a resource or service part, to run on its server's Linked
host. It is checked like the lifecycle routes (**Operate Coolify resources**, the owner or an operate or
configure grant, and a uuid that is one of the connection's own resources), and it also needs your own
`connect` access to the Linked host.

Body (all optional):

| Field       | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `part`      | The uuid of a part of the service in the path                          |
| `container` | A container name from an earlier `choices` answer; it must still match |
| `console`   | `shell` (the default) or `db` for the database's own client            |

Answers:

| Status | Body                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| 200    | `{ hostId, title, container, command, fingerprints, note? }`                                 |
| 300    | `{ choices: [{ name, running, part }] }` when several containers match                       |
| 400    | `invalid-input`, such as a container name outside `[A-Za-z0-9_.-]`                           |
| 403    | missing permission, a view grant, or `no-host-access` when you can't open the Linked host    |
| 404    | no such resource or connection, or `container-not-found`                                     |
| 409    | `not-linked`, `not-running`, `target-changed`, or `host-key` with `{ hostId, fingerprints }` |
| 502    | Coolify or SSH failed                                                                        |

`target-changed` means the connection's address, token, Access token or TLS settings changed while the shell
was being found; nothing from the old target is answered. `command` never holds a password: a database console
reads the container's own variables inside the container, for example `docker exec -it <c> sh -c
'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" "$POSTGRES_DB"'`. `note: "no-console"` means a
console was asked for an engine with none, so the command opens a shell. `fingerprints` are Coolify's host key
fingerprints for the server, when it has them.

The action `coolify.shell-command` is a read, offered to the assistant and MCP. Inputs: `connectionId`, `uuid`,
and optionally `part`, `container` and `console`, checked like the route. Its data is
`{ hostId, container, command }`, or `{ choices }` when several containers match.

## MCP

The endpoint is `POST /plugin-api/coolify/mcp`: stateless JSON-RPC 2.0 over HTTP with `initialize`, `ping`,
`tools/list` and `tools/call`, one message or a batch. `GET /plugin-api/coolify/mcp` answers the endpoint
address and a client config example. The Connections view shows the same under **Use with an MCP client**.

```json
{
  "mcpServers": {
    "termix-coolify": {
      "url": "https://termix.example.com/plugin-api/coolify/mcp",
      "headers": { "Authorization": "Bearer <your Termix API key>" }
    }
  }
}
```

- **Who can use it:** people with **Use the Coolify MCP endpoint**, signed in or with a Termix API key scoped
  to `operations:read` or `operations:run`. Each tool still needs the permission of the action it runs, and a
  `operations:read` key can call only read tools.
- **Tools:** one per operation above, named `coolify__<action>` with dots and dashes turned into `_`, plus:
  - `list_connections`: your connections, without any token.
  - `list_hosts`: the Termix hosts linked to Coolify servers. Empty until host sync arrives.
  - `list_resources`: the applications, services and databases of a connection, with each service's parts.
    It runs `coolify.list-resources-all`.
- **Changes over MCP are off by default.** Read tools always work, and so do deploy and restart in both
  scopes: `coolify__deploy`, `coolify__restart` (on a Linked host's resource) and `coolify__resource_deploy`,
  `coolify__resource_restart` (by connection and uuid, for resources with no Linked host). Every other change
  and destructive tool, start and stop included, answers `mcp-changes-off` until an admin turns on **Allow
  changes over MCP** in the plugin's settings. That switch
  covers this endpoint only; the operations API and plugin routes follow normal permissions, key scope and
  approvals. A destructive tool also needs `confirmed: true` in its arguments.
- **Approvals:** when a rule needs a person, the tool answers with the run id and waits; the action runs once
  someone approves it in Termix.
- **Output** is `{ status, summary, data }` as text. Tokens, passwords, keys, env values and compose files are
  masked at any depth, and `data` longer than 8,000 characters is cut with a note.
