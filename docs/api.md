---
title: API and MCP reference
order: 80
---

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

| Operation                        | Plugin route                                                               | REST run path                                    | Key scope                             | MCP tool                          | Example                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coolify.list-connections`       | `GET /plugin-api/coolify/connections`                                      | `/operations/coolify.list-connections/run`       | `operations:read` or `operations:run` | `coolify__list_connections`       | `curl -X POST "$TERMIX/operations/coolify.list-connections/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                                        |
| `coolify.connection-probe`       | `POST /plugin-api/coolify/connections/:id/probe`                           | `/operations/coolify.connection-probe/run`       | `operations:read` or `operations:run` | `coolify__connection_probe`       | `curl -X POST "$TERMIX/operations/coolify.connection-probe/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                      |
| `coolify.list-resources-all`     | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.list-resources-all/run`     | `operations:read` or `operations:run` | `coolify__list_resources_all`     | `curl -X POST "$TERMIX/operations/coolify.list-resources-all/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                    |
| `coolify.resource-get`           | `GET /plugin-api/coolify/connections/:id/resources/:uuid`                  | `/operations/coolify.resource-get/run`           | `operations:read` or `operations:run` | `coolify__resource_get`           | `curl -X POST "$TERMIX/operations/coolify.resource-get/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>"}}'`                                                                 |
| `coolify.sync-preview`           | `GET /plugin-api/coolify/connections/:id/servers`                          | `/operations/coolify.sync-preview/run`           | `operations:read` or `operations:run` | `coolify__sync_preview`           | `curl -X POST "$TERMIX/operations/coolify.sync-preview/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                          |
| `coolify.connection-create`      | `POST /plugin-api/coolify/connections`                                     | `/operations/coolify.connection-create/run`      | `operations:run`                      | `coolify__connection_create`      | `curl -X POST "$TERMIX/operations/coolify.connection-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"name":"Prod","baseUrl":"https://coolify.example.com","token":"<Coolify API token>"}}'`                    |
| `coolify.connection-update`      | `PATCH /plugin-api/coolify/connections/:id`                                | `/operations/coolify.connection-update/run`      | `operations:run`                      | `coolify__connection_update`      | `curl -X POST "$TERMIX/operations/coolify.connection-update/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","name":"Production"}}'`                                                                 |
| `coolify.connection-delete`      | `DELETE /plugin-api/coolify/connections/:id`                               | `/operations/coolify.connection-delete/run`      | `operations:run`                      | `coolify__connection_delete`      | `curl -X POST "$TERMIX/operations/coolify.connection-delete/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"},"confirmed":true}'`                                                                    |
| `coolify.connection-set-exec`    | `PATCH /plugin-api/coolify/connections/:id` with `execEnabled`             | `/operations/coolify.connection-set-exec/run`    | `operations:run`                      | `coolify__connection_set_exec`    | `curl -X POST "$TERMIX/operations/coolify.connection-set-exec/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","execEnabled":true}}'`                                                                |
| `coolify.sync-apply`             | `POST /plugin-api/coolify/connections/:id/sync`                            | `/operations/coolify.sync-apply/run`             | `operations:run`                      | `coolify__sync_apply`             | `curl -X POST "$TERMIX/operations/coolify.sync-apply/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                            |
| `coolify.unlink`                 | `POST /plugin-api/coolify/connections/:id/servers/:uuid/unlink`            | `/operations/coolify.unlink/run`                 | `operations:run`                      | `coolify__unlink`                 | `curl -X POST "$TERMIX/operations/coolify.unlink/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                                                   |
| `coolify.list-resources`         | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.list-resources/run`         | `operations:read` or `operations:run` | `coolify__list_resources`         | `curl -X POST "$TERMIX/operations/coolify.list-resources/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                          |
| `coolify.deploy`                 | `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`          | `/operations/coolify.deploy/run`                 | `operations:run`                      | `coolify__deploy`                 | `curl -X POST "$TERMIX/operations/coolify.deploy/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{"force":false,"wait":true}}'`                                              |
| `coolify.start`                  | `POST /plugin-api/coolify/connections/:id/resources/:uuid/start`           | `/operations/coolify.start/run`                  | `operations:run`                      | `coolify__start`                  | `curl -X POST "$TERMIX/operations/coolify.start/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{}}'`                                                                        |
| `coolify.restart`                | `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`         | `/operations/coolify.restart/run`                | `operations:run`                      | `coolify__restart`                | `curl -X POST "$TERMIX/operations/coolify.restart/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{}}'`                                                                      |
| `coolify.stop`                   | `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`            | `/operations/coolify.stop/run`                   | `operations:run`                      | `coolify__stop`                   | `curl -X POST "$TERMIX/operations/coolify.stop/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{},"confirmed":true}'`                                                        |
| `coolify.sync-host`              | `POST /plugin-api/coolify/connections/:id/sync`                            | `/operations/coolify.sync-host/run`              | `operations:run`                      | `coolify__sync_host`              | `curl -X POST "$TERMIX/operations/coolify.sync-host/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"input":{}}'`                                                                                                    |
| `coolify.resource-deploy`        | `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`          | `/operations/coolify.resource-deploy/run`        | `operations:run`                      | `coolify__resource_deploy`        | `curl -X POST "$TERMIX/operations/coolify.resource-deploy/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","force":false}}'`                                                |
| `coolify.resource-restart`       | `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`         | `/operations/coolify.resource-restart/run`       | `operations:run`                      | `coolify__resource_restart`       | `curl -X POST "$TERMIX/operations/coolify.resource-restart/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>"}}'`                                                             |
| `coolify.resource-action`        | `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`            | `/operations/coolify.resource-action/run`        | `operations:run`                      | `coolify__resource_action`        | `curl -X POST "$TERMIX/operations/coolify.resource-action/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","action":"stop"},"confirmed":true}'`                             |
| `coolify.signal-degraded`        | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.signal-degraded/run`        | `operations:read` or `operations:run` | `coolify__signal_degraded`        | `curl -X POST "$TERMIX/operations/coolify.signal-degraded/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                         |
| `coolify.signal-server`          | `GET /plugin-api/coolify/connections/:id/servers`                          | `/operations/coolify.signal-server/run`          | `operations:read` or `operations:run` | `coolify__signal_server`          | `curl -X POST "$TERMIX/operations/coolify.signal-server/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                           |
| `coolify.signal-updates`         | `GET /plugin-api/coolify/connections/:id/servers`                          | `/operations/coolify.signal-updates/run`         | `operations:read` or `operations:run` | `coolify__signal_updates`         | `curl -X POST "$TERMIX/operations/coolify.signal-updates/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                          |
| `coolify.signal-deploying`       | `GET /plugin-api/coolify/connections/:id/resources`                        | `/operations/coolify.signal-deploying/run`       | `operations:read` or `operations:run` | `coolify__signal_deploying`       | `curl -X POST "$TERMIX/operations/coolify.signal-deploying/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                                        |
| `coolify.shell-command`          | `POST /plugin-api/coolify/connections/:id/resources/:uuid/shell`           | `/operations/coolify.shell-command/run`          | `operations:read` or `operations:run` | `coolify__shell_command`          | `curl -X POST "$TERMIX/operations/coolify.shell-command/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","console":"shell"}}'`                                              |
| `coolify.logs-tail`              | `GET /plugin-api/coolify/connections/:id/resources/:uuid/logs`             | `/operations/coolify.logs-tail/run`              | `operations:read` or `operations:run` | `coolify__logs_tail`              | `curl -X POST "$TERMIX/operations/coolify.logs-tail/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","lines":100,"confirm":true}}'`                                         |
| `coolify.exec`                   | none                                                                       | `/operations/coolify.exec/run`                   | `operations:run`                      | `coolify__exec`                   | `curl -X POST "$TERMIX/operations/coolify.exec/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","command":"php artisan migrate:status","timeoutSec":60},"confirmed":true}'` |
| `coolify.server-updates`         | `GET /plugin-api/coolify/connections/:id/servers/:uuid/updates`            | `/operations/coolify.server-updates/run`         | `operations:read` or `operations:run` | `coolify__server_updates`         | `curl -X POST "$TERMIX/operations/coolify.server-updates/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                                           |
| `coolify.server-updates-check`   | `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/check`     | `/operations/coolify.server-updates-check/run`   | `operations:run`                      | `coolify__server_updates_check`   | `curl -X POST "$TERMIX/operations/coolify.server-updates-check/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                                     |
| `coolify.server-updates-install` | `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/install`   | `/operations/coolify.server-updates-install/run` | `operations:run`                      | `coolify__server_updates_install` | `curl -X POST "$TERMIX/operations/coolify.server-updates-install/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirm":true},"confirmed":true}'`                   |
| `coolify.server-reboot`          | `POST /plugin-api/coolify/connections/:id/servers/:uuid/reboot`            | `/operations/coolify.server-reboot/run`          | `operations:run`                      | `coolify__server_reboot`          | `curl -X POST "$TERMIX/operations/coolify.server-reboot/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirmName":"<server name>"},"confirmed":true}'`             |
| `coolify.companion-read`         | `GET /plugin-api/coolify/connections/:id/servers/:uuid/security`           | `/operations/coolify.companion-read/run`         | `operations:read` or `operations:run` | `coolify__companion_read`         | `curl -X POST "$TERMIX/operations/coolify.companion-read/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","kind":"security","params":{"serverUuid":"<server uuid>"}}}'`                              |
| `coolify.companion`              | `POST /plugin-api/coolify/connections/:id/resources/:uuid/dns`             | `/operations/coolify.companion/run`              | `operations:run`                      | `coolify__companion`              | `curl -X POST "$TERMIX/operations/coolify.companion/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","kind":"dns","params":{"uuid":"<resource uuid>","fqdn":"app.example.com"}}}'`                   |
| `coolify.companion-dns-remove`   | `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/dns/:recordId` | `/operations/coolify.companion-dns-remove/run`   | `operations:run`                      | `coolify__companion_dns_remove`   | `curl -X POST "$TERMIX/operations/coolify.companion-dns-remove/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","recordId":"1"},"confirmed":true}'`                         |
| `coolify.resource-metrics`       | `GET /plugin-api/coolify/connections/:id/resources/:uuid/metrics`          | `/operations/coolify.resource-metrics/run`       | `operations:read` or `operations:run` | `coolify__resource_metrics`       | `curl -X POST "$TERMIX/operations/coolify.resource-metrics/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","minutes":60}}'`                                                |
| `coolify.resource-traffic`       | `GET /plugin-api/coolify/connections/:id/resources/:uuid/traffic`          | `/operations/coolify.resource-traffic/run`       | `operations:read` or `operations:run` | `coolify__resource_traffic`       | `curl -X POST "$TERMIX/operations/coolify.resource-traffic/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","view":"breakdown","dim":"country","range":"7d"}}'`             |
| `coolify.server-metrics`         | `GET /plugin-api/coolify/connections/:id/servers/:uuid/metrics`            | `/operations/coolify.server-metrics/run`         | `operations:read` or `operations:run` | `coolify__server_metrics`         | `curl -X POST "$TERMIX/operations/coolify.server-metrics/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","minutes":60}}'`                                              |
| `coolify.enable-metrics`         | `POST /plugin-api/coolify/connections/:id/servers/:uuid/metrics/enable`    | `/operations/coolify.enable-metrics/run`         | `operations:run`                      | `coolify__enable_metrics`         | `curl -X POST "$TERMIX/operations/coolify.enable-metrics/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirm":true}}'`                                            |

### Signals and cancelled runs

The `coolify.signal-*` reads answer `{ value, status, label }` for Operations Center's status tiles, from the
plugin's short caches: one Coolify request serves every Linked host of a connection. A host that isn't linked
answers `status: "unknown"` without asking Coolify. `coolify.signal-updates` gives the newer of Coolify's own
patch check and the plugin's last `coolify.server-updates-check`, with the source in `label`; it never runs a
check or SSH itself.

Every action stops before it calls Coolify, SSH or another plugin when its run is already cancelled, and a
deploy with `wait` stops following the deployment when the run is cancelled.

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
| `coolify.status-page-list` | `GET /plugin-api/coolify/connections/:id/status-pages` | `/operations/coolify.status-page-list/run` | `operations:read` or `operations:run` | `coolify__status_page_list` | `curl -X POST "$TERMIX/operations/coolify.status-page-list/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'` |
| `coolify.status-page-create` | `POST /plugin-api/coolify/connections/:id/status-pages` | `/operations/coolify.status-page-create/run` | `operations:run` | `coolify__status_page_create` | `curl -X POST "$TERMIX/operations/coolify.status-page-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","title":"Shop status","resources":["<resource uuid>"]}}'` |
| `coolify.status-page-rotate` | `POST /plugin-api/coolify/status-pages/:id/rotate` | `/operations/coolify.status-page-rotate/run` | `operations:run` | `coolify__status_page_rotate` | `curl -X POST "$TERMIX/operations/coolify.status-page-rotate/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"id":"1"},"confirmed":true}'` |
| `coolify.status-page-revoke` | `DELETE /plugin-api/coolify/status-pages/:id` | `/operations/coolify.status-page-revoke/run` | `operations:run` | `coolify__status_page_revoke` | `curl -X POST "$TERMIX/operations/coolify.status-page-revoke/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"id":"1"},"confirmed":true}'` |
| `coolify.list-api-reads` | `GET /plugin-api/coolify/connections/:id/api/operations?reads=1` | `/operations/coolify.list-api-reads/run` | `operations:read` or `operations:run` | `coolify__list_api_reads` | `curl -X POST "$TERMIX/operations/coolify.list-api-reads/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'` |
| `coolify.list-api-operations` | `GET /plugin-api/coolify/connections/:id/api/operations` | `/operations/coolify.list-api-operations/run` | `operations:read` or `operations:run` | `coolify__list_api_operations` | `curl -X POST "$TERMIX/operations/coolify.list-api-operations/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'` |
| `coolify.api-read` | `POST /plugin-api/coolify/connections/:id/api/call` | `/operations/coolify.api-read/run` | `operations:read` or `operations:run` | `coolify__api_read` | `curl -X POST "$TERMIX/operations/coolify.api-read/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","operationId":"get-application-by-uuid","params":"{\"uuid\":\"<app uuid>\"}"}}'` |
| `coolify.api-call` | `POST /plugin-api/coolify/connections/:id/api/call` | `/operations/coolify.api-call/run` | `operations:run` | `coolify__api_call` | `curl -X POST "$TERMIX/operations/coolify.api-call/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","operationId":"deploy-by-tag-or-uuid","params":"{\"uuid\":\"<app uuid>\"}"},"confirmed":true}'` |

## Route map

Every plugin route and socket, and the action that does the same through Termix's operations. A route with
no action says why. `tests/backend/route-parity.test.ts` checks this table against the routes the plugin
serves.

| Route                                                                      | Action                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /plugin-api/coolify/connections`                                      | `coolify.list-connections`                                                                                                                                           |
| `POST /plugin-api/coolify/connections`                                     | `coolify.connection-create`                                                                                                                                          |
| `GET /plugin-api/coolify/connections/:id`                                  | `coolify.list-connections` (one row of its list)                                                                                                                     |
| `PATCH /plugin-api/coolify/connections/:id`                                | `coolify.connection-update`, or `coolify.connection-set-exec` for `execEnabled`                                                                                      |
| `DELETE /plugin-api/coolify/connections/:id`                               | `coolify.connection-delete`                                                                                                                                          |
| `POST /plugin-api/coolify/connections/:id/probe`                           | `coolify.connection-probe`                                                                                                                                           |
| `GET /plugin-api/coolify/connections/:id/resources`                        | `coolify.list-resources-all`; on a Linked host `coolify.list-resources`, and the signals `coolify.signal-degraded` and `coolify.signal-deploying` read the same list |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid`                  | `coolify.resource-get`                                                                                                                                               |
| `GET /plugin-api/coolify/connections/:id/servers`                          | `coolify.sync-preview`; the signals `coolify.signal-server` and `coolify.signal-updates` read the same servers                                                       |
| `POST /plugin-api/coolify/connections/:id/sync`                            | `coolify.sync-apply`; `coolify.sync-host` for one Linked host                                                                                                        |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/unlink`            | `coolify.unlink`                                                                                                                                                     |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/start`           | `coolify.start` on a Linked host, else `coolify.resource-action`                                                                                                     |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`            | `coolify.stop` on a Linked host, else `coolify.resource-action`                                                                                                      |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`         | `coolify.restart` on a Linked host, else `coolify.resource-restart`                                                                                                  |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`          | `coolify.deploy` on a Linked host, else `coolify.resource-deploy`                                                                                                    |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/shell`           | `coolify.shell-command`                                                                                                                                              |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/logs`             | `coolify.logs-tail`                                                                                                                                                  |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/updates`            | `coolify.server-updates`                                                                                                                                             |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/check`     | `coolify.server-updates-check`                                                                                                                                       |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/install`   | `coolify.server-updates-install`                                                                                                                                     |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/reboot`            | `coolify.server-reboot`                                                                                                                                              |
| `GET /plugin-api/coolify/companions`                                       | `coolify.companion-read`, kind `companions`                                                                                                                          |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/dns`              | `coolify.companion-read`, kind `dns-list`                                                                                                                            |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/dns`             | `coolify.companion`, kind `dns`                                                                                                                                      |
| `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/dns/:recordId` | `coolify.companion-dns-remove`                                                                                                                                       |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/uptime`           | `coolify.companion-read`, kind `uptime`                                                                                                                              |
| `GET /plugin-api/coolify/connections/:id/log-search`                       | `coolify.companion-read`, kind `log-search`                                                                                                                          |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/security`           | `coolify.companion-read`, kind `security`                                                                                                                            |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/backups-failed`     | `coolify.companion-read`, kind `backups-failed`                                                                                                                      |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/host-metrics`       | `coolify.companion-read`, kind `host-metrics`                                                                                                                        |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/db-logins`          | `coolify.companion-read`, kind `db-logins`                                                                                                                           |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/db-login`         | `coolify.companion-read`, kind `db-login`                                                                                                                            |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/paths`            | `coolify.companion-read`, kind `files-paths`                                                                                                                         |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/tunnel`          | `coolify.companion`, kind `tunnel-open`                                                                                                                              |
| `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/tunnel/:port`  | `coolify.companion`, kind `tunnel-close`                                                                                                                             |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/web-ui`          | `coolify.companion`, kind `web-ui`                                                                                                                                   |
| `GET /plugin-api/coolify/connections/:id/status-pages`                     | `coolify.status-page-list`                                                                                                                                           |
| `POST /plugin-api/coolify/connections/:id/status-pages`                    | `coolify.status-page-create`                                                                                                                                         |
| `POST /plugin-api/coolify/status-pages/:id/rotate`                         | `coolify.status-page-rotate`                                                                                                                                         |
| `DELETE /plugin-api/coolify/status-pages/:id`                              | `coolify.status-page-revoke`                                                                                                                                         |
| `GET /plugin-api/coolify/connections/:id/api/operations`                   | `coolify.list-api-operations`; `?reads=1` is `coolify.list-api-reads`                                                                                                |
| `POST /plugin-api/coolify/connections/:id/api/call`                        | `coolify.api-read` for a GET, `coolify.api-call` for anything else                                                                                                   |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/metrics`            | `coolify.server-metrics`                                                                                                                                             |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/metrics/enable`    | `coolify.enable-metrics`                                                                                                                                             |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/metrics`          | `coolify.resource-metrics`                                                                                                                                           |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/traffic`          | `coolify.resource-traffic`                                                                                                                                           |
| `POST /plugin-api/coolify/connections/:id/api/reveal`                      | none: shows one masked value, audited and never cached; an action's run history would keep it                                                                        |
| `POST /plugin-api/coolify/mcp`                                             | none: the MCP endpoint itself; each `tools/call` runs one action through Termix's operations                                                                         |
| `GET /plugin-api/coolify/mcp`                                              | none: answers the endpoint address and a client config example, and runs nothing                                                                                     |
| `POST /plugin-api/coolify/status-pages/handoff/:handoffId`                 | none: hands a create or rotate's URL over once; over MCP that is `take_status_page_url`                                                                              |
| `GET /plugin-api/coolify/status/:token`                                    | none: the public status page, served with no signed-in user                                                                                                          |
| `GET /plugin-api/coolify/status/:token.json`                               | none: the public status page as JSON, served with no signed-in user                                                                                                  |
| `WS /plugin-ws/coolify/logs`                                               | none: a live follow of a container's logs; `coolify.logs-tail` reads a snapshot                                                                                      |
| `WS /plugin-ws/coolify/stats`                                              | none: a live stream of a container's stats; `coolify.resource-metrics` reads a window                                                                                |

## Logs

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/logs`

Recent logs of the container of a resource or service part, labelled with where they came from. Needs
**Operate Coolify resources** and the owner or an operate (or configure) grant on the connection, and the
uuid must be in that connection's own resource list, as for lifecycle actions. A view grant gets 403.

- `source: "coolify"`: read through Coolify's `/logs` endpoints, when the token has `read:sensitive`.
- `source: "ssh"`: `docker logs` over SSH on the server's Linked host otherwise. That needs your own
  `connect` access to the Linked host, and runs through the same host key checks as shells.

Every answer reads the connection once and checks, right before Coolify is asked or `docker logs` runs, that
its address, token, Access token and TLS settings are still the same; otherwise it ends with
`target-changed` (409). Before any line leaves the plugin, the connection's own token and Access secret are
masked wherever they appear, and so are passwords in URLs, credential query parameters, secret-named
fields (`DB_PASSWORD=…`, `"api_key": "…"`) and `Authorization` credentials.

Query (all optional):

| Field        | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `lines`      | Lines from the end, 1 or more; default 100. Anything above 10,000 is 10,000      |
| `timestamps` | `true` to add each line's time (Coolify's service part endpoints don't offer it) |
| `part`       | The uuid of a part of the service in the path                                    |
| `container`  | A container name from an earlier `choices` answer; read over SSH                 |

Answers:

| Status | Body                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 200    | `{ source, text, container? }`; `container` is the one read over SSH                                  |
| 300    | `{ choices: [{ name, running, part }] }` when several containers match                                |
| 400    | `invalid-input`: a bad `lines`, `timestamps`, `part` or `container`                                   |
| 403    | missing permission, a view grant, or `no-host-access` when you can't open the Linked host             |
| 404    | no such resource or connection, or `container-not-found`                                              |
| 409    | `not-linked` (link the server first), `target-changed`, or `host-key` with `{ hostId, fingerprints }` |
| 502    | Coolify or SSH failed                                                                                 |

### Socket `/plugin-ws/coolify/logs`

Follows a container's logs live over SSH (`docker logs -f`, from now on). Send JSON messages:

- `{ "type": "subscribe", "connectionId": 1, "uuid": "…", "part"?: "…", "container"?: "…", "timestamps"?: true }`
- `{ "type": "unsubscribe" }` stops the follow and keeps the socket open
- anything else, like `{ "type": "ping" }`, only gets checked and answered with `pong`

It answers `started { source: "ssh", container }`, `lines { lines, dropped? }`, `choices`, `stopped`,
`ended` (the container's log stream ended) and `error { cause, error }`. A socket runs one follow; a new
subscribe stops the old one. At most 2,000 lines a second reach the socket (older ones are dropped and
counted in `dropped`), and a line longer than 16 KiB is sent in pieces, cut only where no secret spans
the cut. Every line is masked as above, quoted values whole. When the log stream ends, every buffered
line is sent before `ended`. A `choices` answer means several containers match: subscribe again with
`container`.

Every message, and every 15 seconds while a follow runs, is checked: your session must be unlocked, and you
must hold **Operate Coolify resources**, still pass the same grant and resource checks as the route, and
have `connect` access to the Linked host, and the connection must still point at the same target. A
refusal (`locked`, `forbidden`, `not-found`, `no-host-access`) stops the follow and closes the socket with
code 1008; a changed target stops it with `target-changed`. Closing the socket stops `docker logs` on the
server and ends its SSH connection.

### Action `coolify.logs-tail`

A read, offered to the assistant and MCP. Inputs: `connectionId`, `uuid`, `confirm` (must be `true`: logs
can hold secrets), and optionally `part`, `container`, `lines` (up to 10,000) and `timestamps`, checked
like the route. Its data is `{ source, text, container? }`, or `{ choices }` when several containers
match. `text` is a sensitive output: run history never keeps it. Over MCP, `coolify__logs_tail` answers
the (redacted) text once to the caller, cut at 8,000 characters like any tool output; `handoffId` is
what it is taken by.

## Metrics and traffic

Reads from Sentinel run over SSH on the server's Linked host. They pass the same check as lifecycle actions
(**Operate Coolify resources**, the owner or an operate grant, and a uuid in that connection's own resource
list) and need your own `connect` access to the host. Each read is about one snapshot of the connection: if
its address, token or Access settings change before a Coolify call or an SSH command, it ends with
`target-changed`. `minutes` is a whole number from 1; larger than 43,200 (30 days) reads as 43,200. Every
route answers `{ error, cause }` on failure:

| Status | Cause                                                                            |
| ------ | -------------------------------------------------------------------------------- |
| 400    | `invalid-input` (a bad minutes, view, dim, range or limit) or `confirm-required` |
| 403    | missing permission, `forbidden`, or `no-host-access`                             |
| 404    | no such resource, server or connection, or another user's                        |
| 409    | `metrics-off` with `{ canEnable }`, `traffic-off`, `not-linked`, `host-key` or   |
|        | `target-changed`                                                                 |
| 502    | Coolify, SSH or Sentinel failed (`sentinel-failed`, `ssh-failed`)                |

`canEnable` is true only when you hold **Configure Coolify** and own the connection or have a configure
grant.

### `GET /plugin-api/coolify/connections/{id}/servers/{uuid}/metrics?minutes=`

`{ source: "mcp" | "sentinel", minutes, current, series }`. `current` holds `cpu_percent`,
`memory_used_bytes`, `memory_total_bytes`, `disk_used_percent`, `load1`, `network_rx_bytes_per_sec` and
`network_tx_bytes_per_sec` when known (null when the server is offline); `series` holds
`[timestamp ms, value]` pairs by the same names. From Coolify's MCP `get_server_metrics` when it answers
(needs **View Coolify** and access to the connection), else from Sentinel over SSH (needs **Operate Coolify
resources**, an operate grant and `connect` access to the Linked host).

### `POST /plugin-api/coolify/connections/{id}/servers/{uuid}/metrics/enable`

Body `{ "confirm": true }`. Turns metrics on in the server's Sentinel settings (`PATCH
/servers/{uuid}/sentinel` in Coolify). Needs **Configure Coolify** and owner or configure access to the
connection; without `confirm` it answers 400 `confirm-required` and changes nothing. Answers
`{ enabled: true }`.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/metrics?minutes=`

`{ source: "sentinel", minutes, cpu, memory }`: the container's CPU percent and memory used in bytes, as
`[timestamp ms, value]` pairs, from Sentinel's `/api/container/<uuid>/cpu/history` and `/memory/history`.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/traffic`

For applications. Query: `view` (`overview`, the default, `paths`, `series` or `breakdown`), `dim` (for a
breakdown, one of `status`, `method`, `country`, `city`, `referer`, `browser`, `os`, `device`, `protocol`,
`scheme`, `tls`, `cache`, `bot`, `agent`, `ip` or `useragent`), `range` (`24h`, the default, `7d` or `30d`)
and `limit` (paths and breakdowns; clamped to 1 to 200). Answers `{ view, dim?, range, ipsHidden, data }`,
where `data` is Sentinel's answer with credentials masked. IPs show only when Coolify's `traffic_ip_mode`
is `full` and you hold **Configure Coolify** with owner or configure access; otherwise `ipsHidden` is true,
an `ip` breakdown answers no rows without asking Sentinel, and IP fields are left out of every other view.

### Socket `/plugin-ws/coolify/stats`

Send `{ connectionId, uuid, part?, container? }`. The socket answers
`{ type: "stats", container, cpu, memPct, memBytes, netRx, netTx, at }` every 3 seconds from
`docker stats --no-stream`, `{ type: "choices", choices }` when several containers match, or
`{ type: "error", error, cause }` and stops. Send `{ type: "unsubscribe" }` or close it to stop. A socket
runs one stream (a new subscribe replaces it), takes at most one subscribe a second, and a person runs at
most 3 streams at once (`too-many-streams`). Every tick checks again, as the socket's own user: the session
is unlocked, lifecycle's check for the resource, `connect` access to the Linked host, and that the
connection still points at the same target. A refusal (`locked`, `forbidden`, `not-found`,
`no-host-access`, `target-changed`) closes the socket with 1008.

### Actions `coolify.resource-metrics`, `coolify.resource-traffic`, `coolify.server-metrics` and `coolify.enable-metrics`

The reads are offered to the assistant and MCP, with the same data and checks as the routes. Inputs:
`connectionId` and `uuid` (or `serverUuid`), plus `minutes`, or `view`, `dim` and `range` for traffic.
`coolify.enable-metrics` is a change: inputs `connectionId`, `serverUuid` and `confirm: true`. Over MCP it
also needs **Allow changes over MCP** and `confirmed: true`.

## Running commands in containers

### Action `coolify.exec`

Runs one command inside a resource's or part's container, over SSH on its server's Linked host, and returns
its output. It has no plugin route: it runs only through `/operations/coolify.exec/run`, the CLI,
Automations and the plugin's MCP endpoint, so Termix's confirm, approvals and run history always apply.

It is off unless both switches are on, and both are off by default:

1. the admin setting **Allow running commands in containers through the API and MCP** (`allowExec`);
2. the connection owner's opt-in, **Allow running commands in containers through the API and MCP** in the
   connection editor, or `coolify.connection-set-exec` (`execEnabled`).

Each run also needs **Operate Coolify resources**, the owner or an operate or configure Grant on the
connection, a resource in that connection's own list, your own `edit` access to the Linked host (a
connection Grant doesn't give it) and a confirm (`"confirmed": true`). Over the plugin's MCP endpoint it
also needs **Allow changes over MCP**, and `confirmed: true` in the tool call (`confirm-required`
otherwise). Each user can run one command per resource at a time, three at once in all, and twenty
a minute (`busy`, `rate-limited`); these limits are per user, not a lock on the resource, so two users can
run commands in the same resource at once. Every refusal happens before any SSH.

| Input        | Meaning                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uuid`       | The resource                                                                                                                                       |
| `part`       | Optional. A part of the service in `uuid`                                                                                                          |
| `container`  | Optional. A container name from an earlier `choices` answer                                                                                        |
| `command`    | One shell command, run with `sh` in the container; at most 16 KB. A `secret` input: send it as a string (over MCP too); run history never keeps it |
| `timeoutSec` | 1 to 120, default 30. A larger value is cut to 120                                                                                                 |

The command goes to `sh -s` on standard input (`docker exec -i <container> sh -s`), so it is never pasted
into another command line; the container name comes only from the resource and must match
`[A-Za-z0-9_.-]`. The run is about one read of the connection: if its address, token, Access token or TLS
settings change before the SSH connection opens or before the command is sent, it ends with
`target-changed` and sends nothing. The timeout, a cancel or the output cap kills the command over SSH, then
kills its process group inside the container, and closes the connection. That cleanup is best effort:
it runs even if the connection's target changed meanwhile, but when the container has no `setsid` only
the shell running the command is killed, and processes it started can keep running.

The data is `{ hostId, container, exitCode, timedOut, truncated, stdout, stderr }`, or `{ choices }` when
several containers match. Each line of stdout and stderr goes through the same masking as logs (the
connection's own token and Access secret, secret-named values, URL credentials, Authorization headers,
long lines cut the same way), and private key blocks are masked. Output is cut at 64 KB (stdout and stderr
together), with `truncated: true` and the command stopped; a line longer than 16 KB comes back in pieces.
`stdout` and `stderr` are sensitive outputs: run history never keeps them, and over MCP `coolify__exec`
answers them once to the caller. Each run is written to the audit log with the command's and the output's
lengths and the exit code, never their text. A run invalidates the connection's cached resources and
server statuses.

### Action `coolify.connection-set-exec`

A change, with inputs `connectionId` and `execEnabled`. It needs **Configure Coolify**, and only the
connection's owner can change it; a grantee at any level is refused, and so is
`PATCH /plugin-api/coolify/connections/:id` with `execEnabled` from a grantee (403). Each change is
audited. Connections show `execEnabled` to everyone who can read them.

## The full Coolify API

Every operation in Coolify's API (the vendored specs list them all) can be run through two operations:

- `coolify.api-read` runs a read (GET). `coolify.list-api-reads` lists the ones you may run.
- `coolify.api-call` runs any operation, after a confirm. `coolify.list-api-operations` lists the ones you may
  call.

`params` holds the path and query parameters as a JSON object, and `body` the request body as JSON. Both are
secret inputs, so request bodies that carry keys or env values never enter run history. The run records the
method, operation id and path, and the request and answer with secrets masked.

Each operation needs what the same action needs in the app, whatever key or tool calls it:

| Operations                                                                                                                                                                                                                                                         | Termix permission    | Grant               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------- |
| Every DELETE; creating a server; starting, completing or importing a server transfer or migration; cloud provisioning and cloud tokens (Hetzner, DigitalOcean, Vultr, Hostinger, cloud-init scripts); instance settings, including turning Coolify's MCP on or off | `coolify.administer` | configure, or owner |
| Start, stop, restart, deploy, rollback, cancel a deployment, run a scheduled task or a backup; reads that carry log or command output: `…/logs`, everything under `/deployments`, `…/executions`, a server transfer's status and a database import's status        | `coolify.operate`    | operate             |
| Any other GET                                                                                                                                                                                                                                                      | `coolify.view`       | view                |
| Everything else (edits, envs, creates, keys, storage, DNS, notifications)                                                                                                                                                                                          | `coolify.configure`  | configure           |

- `POST /disable`, which would turn Coolify's API off and lock the plugin out, is never run, even when its
  operation id is given directly.
- The two file upload imports (`upload-database-import`, `upload-service-database-import`) can't go through
  the plugin. Import from a path on the server or from S3 with `create-database-import` instead.
- Operations newer than the connection's Coolify are hidden and refused. When an older Coolify answers 404 or
  405 for an operation it doesn't have yet, the answer is `unsupported-by-instance` (409 from the routes).
- **Sensitive operations** run only through `coolify.api-call` (which asks for a confirm) or after a confirm
  in the console: every DELETE, and anything that reads or writes env values, private keys, cloud and
  integration tokens, secret-manager references, logs, notification and SMTP settings, S3 and registry
  credentials or GitHub and GitLab apps. `coolify.api-read` refuses them with `confirm-required`, and
  `coolify.list-api-reads` leaves them out.
- Over MCP, `coolify__api_read` is a read tool and `coolify__api_call` follows **Allow changes over MCP** and
  needs `confirmed`, so MCP never reaches a sensitive operation without both.
- `params` may hold only the operation's own path and query parameters (anything else is refused), and
  `body` is cut to the top-level fields the spec declares; an operation without a JSON body gets none.
- Each call reads the connection once and checks, right before asking Coolify, that its address, token,
  Access token and TLS settings are still the same; otherwise it ends with `target-changed` (409).
- Any string in an answer that holds the connection's token or Access secret is masked, as well as the
  usual secret fields, every field a Coolify spec describes as a password or secret, fields named
  `*_password`, `*_secret`, `*_key`, `*_token`, `*_db_url` and `dsn`, and, in any string at any depth, the
  password in a URL (`postgres://user:[redacted]@host`) and query parameters such as `password=`, `token=`
  or `key=`. A database's `internal_db_url` and `external_db_url` come back as URLs with the password
  masked. Fields a spec describes as raw config, Compose, a script, a Dockerfile, Nginx config, labels or
  env text (a proxy's `configuration`, `docker_compose_raw`, `cloud_init_script` and the like) are masked
  whole. Only **Reveal** in the console shows a masked value.
- Reads whose purpose is logs or command output (deployments, `/logs`, task, backup and cleanup
  executions, and import status, found from Coolify's API description) need **Operate Coolify resources**,
  an operate grant and a confirm, through `coolify.api-call` or the console. Any other answer that holds a
  log or output field (a server's or database's `validation_logs`) is an ordinary read: that field comes
  back masked unless the call is confirmed by someone with **Operate Coolify resources** and an operate
  grant.
- A token that can't read, or a logs read without `read:sensitive`, is refused before Coolify is asked
  (`token-ability`, 409). The connection is checked again right before each request is sent, after any
  wait for the request budget or a retry.
- Array query parameters (such as `system_github_apps[]` of `check-server-import`) take a JSON list and are
  sent as one `name=value` per item. Operations whose answer is text (`version`, `healthcheck`) answer the
  text. Errors carry fixed messages and a `cause`, never Coolify's own text.
- Every call that isn't a GET drops the plugin's cached resource list and server statuses, whether it
  worked or not, so the Coolify tab and status tiles read Coolify again.

The in-app **API console** (Coolify tab) draws a form for each operation. Plain reads run at once; sensitive
reads and anything else ask
for a confirm, and a DELETE asks you to type the operation id. Secrets in answers are masked. With
`coolify.configure`, configure access and a token with `read:sensitive`, you can reveal one value at a time;
each reveal is audited and nothing is kept.

## The `coolify.client` service

Other Termix plugins can use Coolify through the `coolify.client` service (version 1.1.0). Declare it in your
manifest's `requires` and get it as the acting user:

```json
"requires": [{ "service": "coolify.client", "versionRange": "^1.0.0", "optional": true }]
```

```ts
const coolify = await ctx.services.get<CoolifyClient>("coolify.client");
const { data } = await coolify.listResources("1");
```

Getting it needs **View Coolify**. Each method runs one action through Termix's operations as the calling
user, so that action's permission, approvals, confirms and run history apply, and is refused before any run
when the user lacks the action's permission (`forbidden`). Every answer is plain data
(`{ runId, status, summary?, data?, error?, errorCode?, approvalId? }`) with secrets masked; the service never
hands out a token, a Coolify client or raw Coolify access.

| Method                                                  | Action                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `listConnections()`                                     | `coolify.list-connections`                                                                 |
| `listResources(connectionId)`                           | `coolify.list-resources-all`                                                               |
| `deploy(connectionId, uuid, { force? })`                | `coolify.resource-deploy`                                                                  |
| `lifecycle(connectionId, uuid, action, { confirmed? })` | `coolify.resource-restart` for `restart`, `coolify.resource-action` for `start` and `stop` |
| `apiRead(connectionId, operationId, params?)`           | `coolify.api-read`                                                                         |
| `logsTail(connectionId, uuid, lines?, { confirmed? })`  | `coolify.logs-tail`; the redacted text comes back once, to the caller                      |

`start` and `stop` are destructive: without `{ confirmed: true }` they are refused with `confirm-required`
and nothing runs. Pass it only once a person agreed. `logsTail` sends your `confirmed` as the action's
`confirm`, which it needs.

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
  - `list_hosts`: the Termix hosts linked to a connection's Coolify servers (`connectionId`), with each
    host id, server uuid and name. It runs `coolify.sync-preview` and keeps the rows that have a Linked host.
  - `list_resources`: the applications, services and databases of a connection, with each service's parts.
    It runs `coolify.list-resources-all`.
  - `take_status_page_url`: takes a status page URL once, by the `handoffId` a create or rotate answered
    (see below).
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

## Status page URLs

A status page's URL carries its token, so run history never holds it. `coolify.status-page-create` and
`coolify.status-page-rotate` answer `{ id, handoffId }` as data and put the URL only in the `url` output,
which is marked sensitive, so Termix drops it before the run is stored or shown. The run's summary names the
page's title, never its URL. The URL waits in the plugin's memory for 5 minutes, for the same user only, and
can be taken once:

- **Over the plugin's MCP endpoint**, a create or rotate that finishes in the same `tools/call` answers with
  a second text item, `Status page URL (shown once, not stored): <url>`.
- **After an approval, or from `/operations/<id>/run`**, take it with the `handoffId` (the run id):
  - `POST /plugin-api/coolify/status-pages/handoff/<handoffId>` answers `{ url }`. It needs **Configure
    Coolify** and a signed-in session or an unscoped API key. A key scoped to `operations:*` is refused here.
  - The MCP tool `take_status_page_url` with `{ "handoffId": "<handoffId>" }`. A key scoped to
    `operations:run` with **Use the Coolify MCP endpoint** uses this one.

A second take, another user, another run's id or an expired entry gets nothing. Give the page a new link to
get a URL again.

**Which address a URL starts with.** Because the URL carries the token, it is only ever built from an address
the same user sent. The plugin routes (`POST …/status-pages`, `POST …/rotate`) use the address of that request.
An operation has no request, so it uses the address that user's own last signed-in request to the plugin came
in on; if that user has sent none, the URL is relative (`/plugin-api/coolify/status/<token>`), to be put after
your Termix address. Another user's address is never used, and an address that isn't `http` or `https` is
ignored.

The page itself is `GET /plugin-api/coolify/status/<token>` (HTML) or `…/status/<token>.json`, with no
login.

## Companion plugins on containers

Each route answers 404 `{ cause: "companion-missing", plugin }` while that plugin (`file-manager`,
`tunnels` or `reverse-proxy`) isn't running or doesn't offer the service the route needs, and 409
`companions-unknown` when Termix's plugin list can't be read. The resource must be one of the
connection's. A port is an integer from 1 to 65535. A companion plugin gets only the host id, the
container's internal address and the port, never a Coolify or Termix token. A target change while one
runs answers 409 `target-changed`, and nothing is opened.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/paths?part=`

Needs **View Coolify**, the connection (yours or a grant) and your own view access to the Linked host.
Where the resource's files are on its Linked host, for File Manager: `{ hostId, dataDir, composeFile,
volumes }`. `dataDir` is `/data/coolify/applications/<uuid>`, `/data/coolify/services/<uuid>` (a part uses its
service's) or `/data/coolify/databases/<uuid>`. `volumes` lists each storage's place on the server: a file
storage's path inside `dataDir`, a volume's normalized host path (never `/`), or
`/var/lib/docker/volumes/<name>/_data` for a Docker volume. Paths with `..` are left out. File contents are
never read.

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/tunnel`

Needs **Operate Coolify resources**, an operate grant and your own `connect` access to the Linked host.
Body `{ port, part?, container? }`. Reads the container's address with `docker inspect` over SSH and asks
Tunnels to forward the port through the Linked host, asking for a listener on the Termix server's
`127.0.0.1` (Tunnels decides; the answer says where).

| Status | Body                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 200    | `{ name, hostId, targetPort, bindHost, bindPort }`; `name` is `web:<hostId>:coolify-<uuid>`           |
| 300    | `{ choices: [{ name, running, part }] }` when several containers match                                |
| 400    | a bad port or body                                                                                    |
| 403    | missing permission, or `no-host-access`                                                               |
| 404    | no such resource or connection, `container-not-found`, or `companion-missing`                         |
| 409    | `not-linked`, `not-running`, `host-key`, `target-changed`, `tunnel-in-use` or `companions-unknown`    |
| 429    | `too-many-tunnels`: you have 5 forwards open                                                          |
| 502    | SSH or Tunnels failed, or `bad-container-ip` when `docker inspect` gives no private container address |

### `DELETE /plugin-api/coolify/connections/{id}/resources/{uuid}/tunnel/{port}?part=`

Stops the forward `web:<hostId>:coolify-<uuid>` when you opened it here on that port; anything else is 404
`tunnel-not-found`. Answers `{ name, closed: true }`.

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/web-ui`

Body `{ port, scheme?, part?, container? }`, `scheme` `http` (the default) or `https`. Answers `{ url }`, a
one-time link that signs you in to the container's web UI through Reverse Proxy. Answers 409
`proxy-not-configured` while an admin hasn't set Reverse Proxy's Termix address and Web endpoint domain, and
otherwise like the tunnel route.

### Routes, actions, key scopes and examples

The routes take a Termix API key with no scope, acting as the key's user. Through the operations API,
`coolify.companion-read` needs a key with `operations:read` or `operations:run`, and `coolify.companion`
needs `operations:run`. Both paths run the same checks. Over the plugin's MCP endpoint they are the tools
`coolify__companion_read` and `coolify__companion`; `tunnel-open` and `web-ui` also need **Allow changes over
MCP** and `"confirmed": true`.

| Capability    | Route                                                                     | Operation id and kind                   | Operation key scope                   |
| ------------- | ------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------- |
| Files paths   | `GET /plugin-api/coolify/connections/:id/resources/:uuid/paths`           | `coolify.companion-read`, `files-paths` | `operations:read` or `operations:run` |
| Open a tunnel | `POST /plugin-api/coolify/connections/:id/resources/:uuid/tunnel`         | `coolify.companion`, `tunnel-open`      | `operations:run`                      |
| Stop a tunnel | `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/tunnel/:port` | `coolify.companion`, `tunnel-close`     | `operations:run`                      |
| Open web UI   | `POST /plugin-api/coolify/connections/:id/resources/:uuid/web-ui`         | `coolify.companion`, `web-ui`           | `operations:run`                      |

```sh
# Where a resource's files are on its Linked host
curl -X POST "$TERMIX/operations/coolify.companion-read/run" -H "Authorization: Bearer $TERMIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"connectionId":"1","kind":"files-paths","params":{"uuid":"<resource uuid>"}}}'

# Forward a container port through Tunnels
curl -X POST "$TERMIX/operations/coolify.companion/run" -H "Authorization: Bearer $TERMIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"connectionId":"1","kind":"tunnel-open","params":{"uuid":"<resource uuid>","port":5432}}}'

# Stop that forward
curl -X POST "$TERMIX/operations/coolify.companion/run" -H "Authorization: Bearer $TERMIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"connectionId":"1","kind":"tunnel-close","params":{"uuid":"<resource uuid>","port":5432}}}'

# A one-time web UI link (a sensitive output: run history never keeps it)
curl -X POST "$TERMIX/operations/coolify.companion/run" -H "Authorization: Bearer $TERMIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"connectionId":"1","kind":"web-ui","params":{"uuid":"<resource uuid>","port":80,"scheme":"http"}}}'
```

### Kinds of `coolify.companion-read` and `coolify.companion`

- `coolify.companion-read` `files-paths` with `{ uuid, part? }` answers the paths route's data.
- `coolify.companion` `tunnel-open` and `web-ui` with `{ uuid, port, part?, container?, scheme? }`, and
  `tunnel-close` with `{ uuid, port, part? }`, each answer like their route. Over MCP, `tunnel-open` and
  `web-ui` need "Allow changes over MCP" and `confirmed: true`. The `url` of `web-ui` is a sensitive
  output: Termix drops it before the run is stored or shown, and the MCP answer carries it once.
