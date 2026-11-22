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

| Operation                          | Plugin route                                                                                  | REST run path                                      | Key scope                             | MCP tool                            | Example                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coolify.list-connections`         | `GET /plugin-api/coolify/connections`                                                         | `/operations/coolify.list-connections/run`         | `operations:read` or `operations:run` | `coolify__list_connections`         | `curl -X POST "$TERMIX/operations/coolify.list-connections/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                                        |
| `coolify.connection-probe`         | `POST /plugin-api/coolify/connections/:id/probe`                                              | `/operations/coolify.connection-probe/run`         | `operations:read` or `operations:run` | `coolify__connection_probe`         | `curl -X POST "$TERMIX/operations/coolify.connection-probe/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                      |
| `coolify.list-resources-all`       | `GET /plugin-api/coolify/connections/:id/resources`                                           | `/operations/coolify.list-resources-all/run`       | `operations:read` or `operations:run` | `coolify__list_resources_all`       | `curl -X POST "$TERMIX/operations/coolify.list-resources-all/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                    |
| `coolify.resource-get`             | `GET /plugin-api/coolify/connections/:id/resources/:uuid`                                     | `/operations/coolify.resource-get/run`             | `operations:read` or `operations:run` | `coolify__resource_get`             | `curl -X POST "$TERMIX/operations/coolify.resource-get/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>"}}'`                                                                 |
| `coolify.sync-preview`             | `GET /plugin-api/coolify/connections/:id/servers`                                             | `/operations/coolify.sync-preview/run`             | `operations:read` or `operations:run` | `coolify__sync_preview`             | `curl -X POST "$TERMIX/operations/coolify.sync-preview/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                          |
| `coolify.connection-create`        | `POST /plugin-api/coolify/connections`                                                        | `/operations/coolify.connection-create/run`        | `operations:run`                      | `coolify__connection_create`        | `curl -X POST "$TERMIX/operations/coolify.connection-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"name":"Prod","baseUrl":"https://coolify.example.com","token":"<Coolify API token>"}}'`                    |
| `coolify.connection-update`        | `PATCH /plugin-api/coolify/connections/:id`                                                   | `/operations/coolify.connection-update/run`        | `operations:run`                      | `coolify__connection_update`        | `curl -X POST "$TERMIX/operations/coolify.connection-update/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","name":"Production"}}'`                                                                 |
| `coolify.connection-delete`        | `DELETE /plugin-api/coolify/connections/:id`                                                  | `/operations/coolify.connection-delete/run`        | `operations:run`                      | `coolify__connection_delete`        | `curl -X POST "$TERMIX/operations/coolify.connection-delete/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"},"confirmed":true}'`                                                                    |
| `coolify.connection-set-exec`      | `PATCH /plugin-api/coolify/connections/:id` with `execEnabled`                                | `/operations/coolify.connection-set-exec/run`      | `operations:run`                      | `coolify__connection_set_exec`      | `curl -X POST "$TERMIX/operations/coolify.connection-set-exec/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","execEnabled":true}}'`                                                                |
| `coolify.sync-apply`               | `POST /plugin-api/coolify/connections/:id/sync`                                               | `/operations/coolify.sync-apply/run`               | `operations:run`                      | `coolify__sync_apply`               | `curl -X POST "$TERMIX/operations/coolify.sync-apply/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                            |
| `coolify.unlink`                   | `POST /plugin-api/coolify/connections/:id/servers/:uuid/unlink`                               | `/operations/coolify.unlink/run`                   | `operations:run`                      | `coolify__unlink`                   | `curl -X POST "$TERMIX/operations/coolify.unlink/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                                                   |
| `coolify.list-resources`           | `GET /plugin-api/coolify/connections/:id/resources`                                           | `/operations/coolify.list-resources/run`           | `operations:read` or `operations:run` | `coolify__list_resources`           | `curl -X POST "$TERMIX/operations/coolify.list-resources/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                          |
| `coolify.deploy`                   | `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`                             | `/operations/coolify.deploy/run`                   | `operations:run`                      | `coolify__deploy`                   | `curl -X POST "$TERMIX/operations/coolify.deploy/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{"force":false,"wait":true}}'`                                              |
| `coolify.start`                    | `POST /plugin-api/coolify/connections/:id/resources/:uuid/start`                              | `/operations/coolify.start/run`                    | `operations:run`                      | `coolify__start`                    | `curl -X POST "$TERMIX/operations/coolify.start/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{}}'`                                                                        |
| `coolify.restart`                  | `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`                            | `/operations/coolify.restart/run`                  | `operations:run`                      | `coolify__restart`                  | `curl -X POST "$TERMIX/operations/coolify.restart/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{}}'`                                                                      |
| `coolify.stop`                     | `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`                               | `/operations/coolify.stop/run`                     | `operations:run`                      | `coolify__stop`                     | `curl -X POST "$TERMIX/operations/coolify.stop/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<resource uuid>","input":{},"confirmed":true}'`                                                        |
| `coolify.sync-host`                | `POST /plugin-api/coolify/connections/:id/sync`                                               | `/operations/coolify.sync-host/run`                | `operations:run`                      | `coolify__sync_host`                | `curl -X POST "$TERMIX/operations/coolify.sync-host/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"input":{}}'`                                                                                                    |
| `coolify.resource-deploy`          | `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`                             | `/operations/coolify.resource-deploy/run`          | `operations:run`                      | `coolify__resource_deploy`          | `curl -X POST "$TERMIX/operations/coolify.resource-deploy/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","force":false}}'`                                                |
| `coolify.resource-restart`         | `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`                            | `/operations/coolify.resource-restart/run`         | `operations:run`                      | `coolify__resource_restart`         | `curl -X POST "$TERMIX/operations/coolify.resource-restart/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>"}}'`                                                             |
| `coolify.resource-action`          | `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`                               | `/operations/coolify.resource-action/run`          | `operations:run`                      | `coolify__resource_action`          | `curl -X POST "$TERMIX/operations/coolify.resource-action/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","action":"stop"},"confirmed":true}'`                             |
| `coolify.deployment-list`          | `GET /plugin-api/coolify/connections/:id/resources/:uuid/deployments`                         | `/operations/coolify.deployment-list/run`          | `operations:read` or `operations:run` | `coolify__deployment_list`          | `curl -X POST "$TERMIX/operations/coolify.deployment-list/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>","skip":0,"take":10}}'`                                        |
| `coolify.deployment-get`           | `GET /plugin-api/coolify/connections/:id/resources/:uuid/deployments/:deploymentUuid`         | `/operations/coolify.deployment-get/run`           | `operations:read` or `operations:run` | `coolify__deployment_get`           | `curl -X POST "$TERMIX/operations/coolify.deployment-get/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","deploymentUuid":"<deployment uuid>","confirm":true}}'`                                    |
| `coolify.deployment-cancel`        | `POST /plugin-api/coolify/connections/:id/resources/:uuid/deployments/:deploymentUuid/cancel` | `/operations/coolify.deployment-cancel/run`        | `operations:run`                      | `coolify__deployment_cancel`        | `curl -X POST "$TERMIX/operations/coolify.deployment-cancel/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","deploymentUuid":"<deployment uuid>"},"confirmed":true}'`                               |
| `coolify.preview-list`             | `GET /plugin-api/coolify/connections/:id/resources/:uuid/previews`                            | `/operations/coolify.preview-list/run`             | `operations:read` or `operations:run` | `coolify__preview_list`             | `curl -X POST "$TERMIX/operations/coolify.preview-list/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>"}}'`                                                              |
| `coolify.preview-create`           | `POST /plugin-api/coolify/connections/:id/resources/:uuid/previews`                           | `/operations/coolify.preview-create/run`           | `operations:run`                      | `coolify__preview_create`           | `curl -X POST "$TERMIX/operations/coolify.preview-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>","pullRequestId":42,"gitType":"github"}}'`                      |
| `coolify.preview-domains`          | `PATCH /plugin-api/coolify/connections/:id/resources/:uuid/previews/:pullRequestId`           | `/operations/coolify.preview-domains/run`          | `operations:run`                      | `coolify__preview_domains`          | `curl -X POST "$TERMIX/operations/coolify.preview-domains/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>","pullRequestId":42,"domains":"https://pr-42.example.com"}}'`  |
| `coolify.preview-delete`           | `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/previews/:pullRequestId`          | `/operations/coolify.preview-delete/run`           | `operations:run`                      | `coolify__preview_delete`           | `curl -X POST "$TERMIX/operations/coolify.preview-delete/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>","pullRequestId":42},"confirmed":true}'`                        |
| `coolify.preview-logs`             | `GET /plugin-api/coolify/connections/:id/resources/:uuid/previews/:pullRequestId/logs`        | `/operations/coolify.preview-logs/run`             | `operations:read` or `operations:run` | `coolify__preview_logs`             | `curl -X POST "$TERMIX/operations/coolify.preview-logs/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>","pullRequestId":42,"confirm":true}}'`                            |
| `coolify.rollback-images`          | `GET /plugin-api/coolify/connections/:id/resources/:uuid/rollback-images`                     | `/operations/coolify.rollback-images/run`          | `operations:read` or `operations:run` | `coolify__rollback_images`          | `curl -X POST "$TERMIX/operations/coolify.rollback-images/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<application uuid>","input":{}}'`                                                           |
| `coolify.rollback`                 | `POST /plugin-api/coolify/connections/:id/resources/:uuid/rollback`                           | `/operations/coolify.rollback/run`                 | `operations:run`                      | `coolify__rollback`                 | `curl -X POST "$TERMIX/operations/coolify.rollback/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7,"resourceKey":"<application uuid>","input":{"image":"<image tag>"},"confirmed":true}'`                            |
| `coolify.resource-rollback-images` | `GET /plugin-api/coolify/connections/:id/resources/:uuid/rollback-images`                     | `/operations/coolify.resource-rollback-images/run` | `operations:read` or `operations:run` | `coolify__resource_rollback_images` | `curl -X POST "$TERMIX/operations/coolify.resource-rollback-images/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>"}}'`                                                  |
| `coolify.resource-rollback`        | `POST /plugin-api/coolify/connections/:id/resources/:uuid/rollback`                           | `/operations/coolify.resource-rollback/run`        | `operations:run`                      | `coolify__resource_rollback`        | `curl -X POST "$TERMIX/operations/coolify.resource-rollback/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<application uuid>","image":"<image tag>"},"confirmed":true}'`                  |
| `coolify.deployment-queue`         | `GET /plugin-api/coolify/connections/:id/deployments`                                         | `/operations/coolify.deployment-queue/run`         | `operations:read` or `operations:run` | `coolify__deployment_queue`         | `curl -X POST "$TERMIX/operations/coolify.deployment-queue/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                      |
| `coolify.attention`                | `GET /plugin-api/coolify/attention`                                                           | `/operations/coolify.attention/run`                | `operations:read` or `operations:run` | `coolify__attention`                | `curl -X POST "$TERMIX/operations/coolify.attention/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                                               |
| `coolify.deploy-by-tag`            | `POST /plugin-api/coolify/connections/:id/deploy-by-tag`                                      | `/operations/coolify.deploy-by-tag/run`            | `operations:run`                      | `coolify__deploy_by_tag`            | `curl -X POST "$TERMIX/operations/coolify.deploy-by-tag/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","tag":"prod","force":false}}'`                                                              |
| `coolify.signal-degraded`          | `GET /plugin-api/coolify/connections/:id/resources`                                           | `/operations/coolify.signal-degraded/run`          | `operations:read` or `operations:run` | `coolify__signal_degraded`          | `curl -X POST "$TERMIX/operations/coolify.signal-degraded/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                         |
| `coolify.signal-server`            | `GET /plugin-api/coolify/connections/:id/servers`                                             | `/operations/coolify.signal-server/run`            | `operations:read` or `operations:run` | `coolify__signal_server`            | `curl -X POST "$TERMIX/operations/coolify.signal-server/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                           |
| `coolify.signal-updates`           | `GET /plugin-api/coolify/connections/:id/servers`                                             | `/operations/coolify.signal-updates/run`           | `operations:read` or `operations:run` | `coolify__signal_updates`           | `curl -X POST "$TERMIX/operations/coolify.signal-updates/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                          |
| `coolify.host-summary`             | `GET /plugin-api/coolify/connections/:id/server-health`                                       | `/operations/coolify.host-summary/run`             | `operations:read` or `operations:run` | `coolify__host_summary`             | `curl -X POST "$TERMIX/operations/coolify.host-summary/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                            |
| `coolify.host-metrics`             | `GET /plugin-api/coolify/connections/:id/host-metrics`                                        | `/operations/coolify.host-metrics/run`             | `operations:read` or `operations:run` | `coolify__host_metrics`             | `curl -X POST "$TERMIX/operations/coolify.host-metrics/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"hostId":7}'`                                                                                                            |
| `coolify.signal-deploying`         | `GET /plugin-api/coolify/connections/:id/resources`                                           | `/operations/coolify.signal-deploying/run`         | `operations:read` or `operations:run` | `coolify__signal_deploying`         | `curl -X POST "$TERMIX/operations/coolify.signal-deploying/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                                        |
| `coolify.shell-command`            | `POST /plugin-api/coolify/connections/:id/resources/:uuid/shell`                              | `/operations/coolify.shell-command/run`            | `operations:read` or `operations:run` | `coolify__shell_command`            | `curl -X POST "$TERMIX/operations/coolify.shell-command/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","console":"shell"}}'`                                              |
| `coolify.logs-tail`                | `GET /plugin-api/coolify/connections/:id/resources/:uuid/logs`                                | `/operations/coolify.logs-tail/run`                | `operations:read` or `operations:run` | `coolify__logs_tail`                | `curl -X POST "$TERMIX/operations/coolify.logs-tail/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","lines":100,"confirm":true}}'`                                         |
| `coolify.exec`                     | none                                                                                          | `/operations/coolify.exec/run`                     | `operations:run`                      | `coolify__exec`                     | `curl -X POST "$TERMIX/operations/coolify.exec/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","command":"php artisan migrate:status","timeoutSec":60},"confirmed":true}'` |
| `coolify.server-updates`           | `GET /plugin-api/coolify/connections/:id/servers/:uuid/updates`                               | `/operations/coolify.server-updates/run`           | `operations:read` or `operations:run` | `coolify__server_updates`           | `curl -X POST "$TERMIX/operations/coolify.server-updates/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                                           |
| `coolify.server-updates-check`     | `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/check`                        | `/operations/coolify.server-updates-check/run`     | `operations:run`                      | `coolify__server_updates_check`     | `curl -X POST "$TERMIX/operations/coolify.server-updates-check/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>"}}'`                                                     |
| `coolify.server-updates-install`   | `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/install`                      | `/operations/coolify.server-updates-install/run`   | `operations:run`                      | `coolify__server_updates_install`   | `curl -X POST "$TERMIX/operations/coolify.server-updates-install/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirm":true},"confirmed":true}'`                   |
| `coolify.server-reboot`            | `POST /plugin-api/coolify/connections/:id/servers/:uuid/reboot`                               | `/operations/coolify.server-reboot/run`            | `operations:run`                      | `coolify__server_reboot`            | `curl -X POST "$TERMIX/operations/coolify.server-reboot/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirmName":"<server name>"},"confirmed":true}'`             |
| `coolify.companion-read`           | `GET /plugin-api/coolify/connections/:id/servers/:uuid/security`                              | `/operations/coolify.companion-read/run`           | `operations:read` or `operations:run` | `coolify__companion_read`           | `curl -X POST "$TERMIX/operations/coolify.companion-read/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","kind":"security","params":{"serverUuid":"<server uuid>"}}}'`                              |
| `coolify.companion`                | `POST /plugin-api/coolify/connections/:id/resources/:uuid/dns`                                | `/operations/coolify.companion/run`                | `operations:run`                      | `coolify__companion`                | `curl -X POST "$TERMIX/operations/coolify.companion/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","kind":"dns","params":{"uuid":"<resource uuid>","fqdn":"app.example.com"}}}'`                   |
| `coolify.companion-dns-remove`     | `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/dns/:recordId`                    | `/operations/coolify.companion-dns-remove/run`     | `operations:run`                      | `coolify__companion_dns_remove`     | `curl -X POST "$TERMIX/operations/coolify.companion-dns-remove/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","recordId":"1"},"confirmed":true}'`                         |
| `coolify.resource-metrics`         | `GET /plugin-api/coolify/connections/:id/resources/:uuid/metrics`                             | `/operations/coolify.resource-metrics/run`         | `operations:read` or `operations:run` | `coolify__resource_metrics`         | `curl -X POST "$TERMIX/operations/coolify.resource-metrics/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","minutes":60}}'`                                                |
| `coolify.resource-traffic`         | `GET /plugin-api/coolify/connections/:id/resources/:uuid/traffic`                             | `/operations/coolify.resource-traffic/run`         | `operations:read` or `operations:run` | `coolify__resource_traffic`         | `curl -X POST "$TERMIX/operations/coolify.resource-traffic/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>","view":"breakdown","dim":"country","range":"7d"}}'`             |
| `coolify.server-metrics`           | `GET /plugin-api/coolify/connections/:id/servers/:uuid/metrics`                               | `/operations/coolify.server-metrics/run`           | `operations:read` or `operations:run` | `coolify__server_metrics`           | `curl -X POST "$TERMIX/operations/coolify.server-metrics/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","minutes":60}}'`                                              |
| `coolify.enable-metrics`           | `POST /plugin-api/coolify/connections/:id/servers/:uuid/metrics/enable`                       | `/operations/coolify.enable-metrics/run`           | `operations:run`                      | `coolify__enable_metrics`           | `curl -X POST "$TERMIX/operations/coolify.enable-metrics/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","serverUuid":"<server uuid>","confirm":true}}'`                                            |

### Signals and cancelled runs

The `coolify.signal-*` reads answer `{ value, status, label }` for Operations Center's status tiles, from the
plugin's short caches: one Coolify request serves every Linked host of a connection. A host that isn't linked
answers `status: "unknown"` without asking Coolify. `coolify.signal-updates` gives the newer of Coolify's own
patch check and the plugin's last `coolify.server-updates-check`, with the source in `label`; it never runs a
check or SSH itself.

Every action stops before it calls Coolify, SSH or another plugin when its run is already cancelled, and a
deploy with `wait` stops following the deployment when the run is cancelled.

### Waited deploys

`coolify.deploy` and `coolify.resource-deploy` with `"wait": true` follow the deployment, polling every 5
seconds, until it reaches a final status or the wait reaches its limit of 30 minutes:

- **finished**: the run succeeds and sends `coolify.deployment-finished`.
- **failed** or **cancelled**: the run fails with the cause `deployment-failed` and sends
  `coolify.deployment-failed`.
- **skipped**: the run fails at once with the cause `skipped` and sends `coolify.deployment-failed`.
- **still running after 30 minutes**: the run fails with the cause `wait-timeout` and sends **no** event,
  since the deployment itself hasn't ended. The error gives its last status in words and a link to it,
  the plugin's own deployment route, which answers its status and build log (for an application). Over
  MCP the tool result is an error with `"errorCode": "wait-timeout"`; on the operations API the run fails
  with that error code. Read the deployment later with `coolify.deployment-get` or that route.

The error for a timed-out wait reads like this:

```text
The deployment of web was still in progress after 30 minutes, so the run stopped waiting; the deployment
has not ended. Follow it at /plugin-api/coolify/connections/1/resources/<app uuid>/deployments/<deployment uuid>
```

Every outcome refreshes the resource list once the wait ends.

### Lifecycle routes

`POST /plugin-api/coolify/connections/:id/resources/:uuid/{start|stop|restart|deploy}` (deploy takes
`{ "force": true|false }`) needs **Operate Coolify resources** and the owner or an operate or configure grant.
It answers `{ "deploymentUuid": "…" | null }`, or 202 `{ "status": "pending", "runId" }` while an approval
waits. With a Linked host it runs the resource-scope action on that host (`hostId`, `resourceKey` = the uuid),
so the run is in the host's history; without one it runs `coolify.resource-deploy`, `coolify.resource-restart`
or `coolify.resource-action`. A uuid that isn't one of the connection's resources is 404, a missing permission
or a view grant 403, and a Coolify refusal 502 with a `cause` such as `forbidden-ability`. A run that waited
on its deployment past the 30 minute limit is 504 with the cause `wait-timeout` (the route itself doesn't
wait; see [Waited deploys](#waited-deploys)).

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

| Route                                                                                         | Action                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /plugin-api/coolify/connections`                                                         | `coolify.list-connections`                                                                                                                                           |
| `POST /plugin-api/coolify/connections`                                                        | `coolify.connection-create`                                                                                                                                          |
| `GET /plugin-api/coolify/connections/:id`                                                     | `coolify.list-connections` (one row of its list)                                                                                                                     |
| `PATCH /plugin-api/coolify/connections/:id`                                                   | `coolify.connection-update`, or `coolify.connection-set-exec` for `execEnabled`                                                                                      |
| `DELETE /plugin-api/coolify/connections/:id`                                                  | `coolify.connection-delete`                                                                                                                                          |
| `POST /plugin-api/coolify/connections/:id/probe`                                              | `coolify.connection-probe`                                                                                                                                           |
| `GET /plugin-api/coolify/connections/:id/resources`                                           | `coolify.list-resources-all`; on a Linked host `coolify.list-resources`, and the signals `coolify.signal-degraded` and `coolify.signal-deploying` read the same list |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid`                                     | `coolify.resource-get`                                                                                                                                               |
| `GET /plugin-api/coolify/connections/:id/server-health`                                       | `coolify.host-summary` for one Linked host; the signals `coolify.signal-server` and `coolify.signal-degraded` read the same cached servers and resources             |
| `GET /plugin-api/coolify/connections/:id/servers`                                             | `coolify.sync-preview`; the signals `coolify.signal-server` and `coolify.signal-updates` read the same servers                                                       |
| `POST /plugin-api/coolify/connections/:id/sync`                                               | `coolify.sync-apply`; `coolify.sync-host` for one Linked host                                                                                                        |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/unlink`                               | `coolify.unlink`                                                                                                                                                     |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/start`                              | `coolify.start` on a Linked host, else `coolify.resource-action`                                                                                                     |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/stop`                               | `coolify.stop` on a Linked host, else `coolify.resource-action`                                                                                                      |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/restart`                            | `coolify.restart` on a Linked host, else `coolify.resource-restart`                                                                                                  |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/deploy`                             | `coolify.deploy` on a Linked host, else `coolify.resource-deploy`                                                                                                    |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/deployments`                         | `coolify.deployment-list`                                                                                                                                            |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/deployments/:deploymentUuid`         | `coolify.deployment-get`                                                                                                                                             |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/deployments/:deploymentUuid/cancel` | `coolify.deployment-cancel`                                                                                                                                          |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/previews`                            | `coolify.preview-list`                                                                                                                                               |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/previews`                           | `coolify.preview-create`                                                                                                                                             |
| `PATCH /plugin-api/coolify/connections/:id/resources/:uuid/previews/:pullRequestId`           | `coolify.preview-domains`                                                                                                                                            |
| `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/previews/:pullRequestId`          | `coolify.preview-delete`                                                                                                                                             |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/previews/:pullRequestId/logs`        | `coolify.preview-logs`                                                                                                                                               |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/rollback-images`                     | `coolify.resource-rollback-images`; `coolify.rollback-images` on a Linked host                                                                                       |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/rollback`                           | `coolify.resource-rollback`; `coolify.rollback` on a Linked host                                                                                                     |
| `GET /plugin-api/coolify/connections/:id/deployments`                                         | `coolify.deployment-queue`                                                                                                                                           |
| `GET /plugin-api/coolify/attention`                                                           | `coolify.attention`                                                                                                                                                  |
| `GET /plugin-api/coolify/connections/:id/deploy-by-tag`                                       | `coolify.deploy-by-tag` (its dry run lists the same resources)                                                                                                       |
| `POST /plugin-api/coolify/connections/:id/deploy-by-tag`                                      | `coolify.deploy-by-tag`                                                                                                                                              |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/shell`                              | `coolify.shell-command`                                                                                                                                              |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/logs`                                | `coolify.logs-tail`                                                                                                                                                  |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/updates`                               | `coolify.server-updates`                                                                                                                                             |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/check`                        | `coolify.server-updates-check`                                                                                                                                       |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/updates/install`                      | `coolify.server-updates-install`                                                                                                                                     |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/reboot`                               | `coolify.server-reboot`                                                                                                                                              |
| `GET /plugin-api/coolify/companions`                                                          | `coolify.companion-read`, kind `companions`                                                                                                                          |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/dns`                                 | `coolify.companion-read`, kind `dns-list`                                                                                                                            |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/dns`                                | `coolify.companion`, kind `dns`                                                                                                                                      |
| `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/dns/:recordId`                    | `coolify.companion-dns-remove`                                                                                                                                       |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/uptime`                              | `coolify.companion-read`, kind `uptime`                                                                                                                              |
| `GET /plugin-api/coolify/connections/:id/log-search`                                          | `coolify.companion-read`, kind `log-search`                                                                                                                          |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/security`                              | `coolify.companion-read`, kind `security`                                                                                                                            |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/backups-failed`                        | `coolify.companion-read`, kind `backups-failed`                                                                                                                      |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/host-metrics`                          | `coolify.companion-read`, kind `host-metrics`                                                                                                                        |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/db-logins`                             | `coolify.companion-read`, kind `db-logins`                                                                                                                           |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/db-login`                            | `coolify.companion-read`, kind `db-login`                                                                                                                            |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/paths`                               | `coolify.companion-read`, kind `files-paths`                                                                                                                         |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/tunnel`                             | `coolify.companion`, kind `tunnel-open`                                                                                                                              |
| `DELETE /plugin-api/coolify/connections/:id/resources/:uuid/tunnel/:port`                     | `coolify.companion`, kind `tunnel-close`                                                                                                                             |
| `POST /plugin-api/coolify/connections/:id/resources/:uuid/web-ui`                             | `coolify.companion`, kind `web-ui`                                                                                                                                   |
| `GET /plugin-api/coolify/connections/:id/status-pages`                                        | `coolify.status-page-list`                                                                                                                                           |
| `POST /plugin-api/coolify/connections/:id/status-pages`                                       | `coolify.status-page-create`                                                                                                                                         |
| `POST /plugin-api/coolify/status-pages/:id/rotate`                                            | `coolify.status-page-rotate`                                                                                                                                         |
| `DELETE /plugin-api/coolify/status-pages/:id`                                                 | `coolify.status-page-revoke`                                                                                                                                         |
| `GET /plugin-api/coolify/connections/:id/api/operations`                                      | `coolify.list-api-operations`; `?reads=1` is `coolify.list-api-reads`                                                                                                |
| `POST /plugin-api/coolify/connections/:id/api/call`                                           | `coolify.api-read` for a GET, `coolify.api-call` for anything else                                                                                                   |
| `GET /plugin-api/coolify/connections/:id/servers/:uuid/metrics`                               | `coolify.server-metrics`                                                                                                                                             |
| `GET /plugin-api/coolify/connections/:id/host-metrics`                                        | `coolify.host-metrics` for one Linked host                                                                                                                           |
| `POST /plugin-api/coolify/connections/:id/servers/:uuid/metrics/enable`                       | `coolify.enable-metrics`                                                                                                                                             |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/metrics`                             | `coolify.resource-metrics`                                                                                                                                           |
| `GET /plugin-api/coolify/connections/:id/resources/:uuid/traffic`                             | `coolify.resource-traffic`                                                                                                                                           |
| `POST /plugin-api/coolify/connections/:id/api/reveal`                                         | none: shows one masked value, audited and never cached; an action's run history would keep it                                                                        |
| `POST /plugin-api/coolify/mcp`                                                                | none: the MCP endpoint itself; each `tools/call` runs one action through Termix's operations                                                                         |
| `GET /plugin-api/coolify/mcp`                                                                 | none: answers the endpoint address and a client config example, and runs nothing                                                                                     |
| `POST /plugin-api/coolify/status-pages/handoff/:handoffId`                                    | none: hands a create or rotate's URL over once; over MCP that is `take_status_page_url`                                                                              |
| `GET /plugin-api/coolify/status/:token`                                                       | none: the public status page, served with no signed-in user                                                                                                          |
| `GET /plugin-api/coolify/status/:token.json`                                                  | none: the public status page as JSON, served with no signed-in user                                                                                                  |
| `WS /plugin-ws/coolify/logs`                                                                  | none: a live follow of a container's logs; `coolify.logs-tail` reads a snapshot                                                                                      |
| `WS /plugin-ws/coolify/stats`                                                                 | none: a live stream of a container's stats; `coolify.resource-metrics` reads a window                                                                                |

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
fields (`DB_PASSWORD=…`, `"api_key": "…"`) and `Authorization` credentials. A private key's body is
masked; a snapshot that starts inside a key (a key's END line with no BEGIN before it) is masked from its
start through that END line, and the lines after it are left as they are.

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

## Deployments

An application's deployment history, one deployment with its build log, and cancel. Services and databases
have no deployments in Coolify, so a uuid that isn't one of the connection's own applications is 404.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/deployments?skip=&take=`

A page of the application's deployments, newest first, from Coolify's per-application list. Needs **View
Coolify** and any access to the connection. `skip` (default 0) and `take` (1 to 50, default 10) page through
it; anything else is 400 `invalid-input`. It answers `{ rows, count, skip, take }`, where `count` is
Coolify's total for the application (null when Coolify doesn't send one). Each row is
`{ uuid, resourceUuid, status, commit, commitMessage, pullRequestId, rollback, serverName, createdAt,
updatedAt, finishedAt }`; `pullRequestId` is 0 unless it is a preview deployment. Rows never carry the build
log Coolify sends with them.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/deployments/{deploymentUuid}`

One deployment with its build log. Needs **Operate Coolify resources** and the owner or an operate (or
configure) grant, since build logs can hold secrets; a view grant gets 403. The deployment must belong to the
application in the path, by the link Coolify gives it; any other deployment, even one of the same Coolify
team, is 404.

It answers `{ deployment, log, final, cancellable }`. `log` is `{ lines, truncated }`, or null when the
connection's token can't read build logs (Coolify needs `read:sensitive` for them). Each line is
`{ order, timestamp, stream, hidden, command, output }`, oldest first, at most 5,000 (the last ones, with
`truncated` set). `hidden` is Coolify's own flag for lines its UI hides unless debugging, like the commands
it ran; the Deployments view hides them until you turn them on. Before any line leaves the plugin, its
output and command are masked as container logs are: the connection's own token and Access secret, passwords
in URLs, credential query parameters, secret-named fields and `Authorization` credentials. A private key is
masked across lines, and a log that starts inside one (its END with no BEGIN before it) is masked from the
start through that END. `final` turns true
once the deployment ended (finished, failed, cancelled or skipped); the Deployments view polls this route
every 2 seconds while it is shown and stops then.

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/deployments/{deploymentUuid}/cancel`

Cancels a queued or running deployment of the application. Needs **Operate Coolify resources** and the owner
or an operate grant, and runs `coolify.deployment-cancel` confirmed (the Deployments view asks first). It
answers `{ deploymentUuid, status }`, or 202 `{ "status": "pending", "runId" }` while an approval waits. A
deployment that already ended is 409 `deployment-ended`.

Every deployment read and cancel reads the connection once. After every step, and right before each request
to Coolify, it checks that the connection still points at the same address, token, Access token and TLS
settings and that your grant still reaches the level the call needs; otherwise it ends with
`target-changed` (409) or `forbidden` (403) and Coolify isn't asked. Cancel also stops before Coolify is
asked once its run is cancelled.

### Actions `coolify.deployment-list`, `coolify.deployment-get` and `coolify.deployment-cancel`

`coolify.deployment-list` is a read offered to the assistant and MCP: `connectionId`, `uuid` (the
application) and optionally `skip` and `take`; its data is the route's answer plus `options` for pickers.

`coolify.deployment-get` is a read offered to the assistant and MCP, and needs **Operate Coolify resources**.
Inputs: `connectionId`, `deploymentUuid`, `confirm` (must be `true`: build logs can hold secrets), and
optionally `uuid` (the application; without it the deployment must belong to one of the connection's own
applications) and `showHidden` (default false, so hidden lines are left out). Its data is
`{ deployment, final, cancellable, logAvailable, lineCount, hiddenCount, truncated, text, handoffId }`.
`text` is the redacted log, one line per output, and a sensitive output: run history never keeps it. Over
MCP, `coolify__deployment_get` answers it once to the caller, cut at 8,000 characters like any tool output.

`coolify.deployment-cancel` is destructive, so Termix confirms it first (`confirmed: true` over the API and
MCP), and over MCP it also needs **Allow changes over MCP**. Inputs: `connectionId`, `deploymentUuid` and
optionally `uuid`, checked as for `coolify.deployment-get`.

### `GET /plugin-api/coolify/connections/{id}/deployments`

The connection's deployment queue and recent history, as the Deployments section and the Overview show
it. Needs **View Coolify** and any access to the connection. It answers `{ running, recent, fetchedAt }`.
`running` is Coolify's queue (`GET /deployments`: queued and in progress, oldest first). `recent` is the
latest ended deployments of the connection's ten most recently deployed applications (five each, newest
first, at most 25). Each row is a deployment as above plus `resourceName`. Only deployments whose link names
one of the connection's own applications are in it: a row of another application of the same Coolify team,
or one that names none, is left out. Rows never carry a build log.

It is one cached read, kept 10 seconds and shared by every reader (the section, the Overview and
`coolify.deployment-queue`); `?refresh=1` skips the cache. A cancel or deploy from the plugin drops it, and
rows read before the connection's address, token or Access settings changed are never served.

### `GET /plugin-api/coolify/connections/{id}/deploy-by-tag?tag=&pullRequestId=`

What deploy by tag would deploy, for its confirm. Needs **Operate Coolify resources** and the owner or an
operate grant. It answers `{ tag, targets, skippedServices }`: the connection's own applications Coolify
lists for the tag, then its services that carry it, each `{ uuid, name, kind, serverName }`. With a
`pullRequestId`, services are left out (they have no previews) and counted in `skippedServices`. It changes
nothing.

### `POST /plugin-api/coolify/connections/{id}/deploy-by-tag`

Runs `coolify.deploy-by-tag` with `{ tag, force, pullRequestId, dockerTag, targets }`. Only `tag` is
required; `dockerTag` needs `pullRequestId`. The tag's targets are found as above and deployed by uuid in one
Coolify request, so exactly the resources listed are deployed and the pull request and Docker tag options
work (Coolify's own `tag` parameter refuses them). `targets` is the list of uuids the person confirmed: when
given, nothing is deployed unless the tag still hits exactly those (409 `targets-changed`). It answers
`{ tag, targets, skippedServices, deployments }`, where each deployment is Coolify's
`{ resourceUuid, deploymentUuid, message }` (`deploymentUuid` null when it queued none). No resource with
the tag is 404.

### Actions `coolify.deployment-queue` and `coolify.deploy-by-tag`

`coolify.deployment-queue` is a read offered to the assistant and MCP: `connectionId` and optionally
`refresh`. Its data is the route's answer.

`coolify.deploy-by-tag` is a change for **Operate Coolify resources**: `connectionId`, `tag` and optionally
`force`, `pullRequestId`, `dockerTag` and `targets` (comma separated uuids). A dry run lists the resources it
would deploy. Over MCP it needs `confirmed: true` and **Allow changes over MCP**. Like cancel, it checks the
connection and your grant after every step and right before Coolify is asked, and stops before Coolify is
asked once its run is cancelled.

### `GET /plugin-api/coolify/attention?refresh=`

What the sidebar panel lists and the rail badge counts, across every connection you can view. Needs **View
Coolify**; another user's connection is never in it, and one whose grant went away meanwhile is left out. It
answers `{ connections, counts, badge, fetchedAt }`. Each connection is `{ id, name, access, scoped,
running, failed, degraded, unreachable, error }`:

- `running`: the connection's queue, as `GET /connections/{id}/deployments` answers it.
- `failed`: recent failed deployments. A failure counts while it is still its application's latest ended
  deployment (per pull request) and ended within the last 24 hours, so a later successful deploy clears it.
- `degraded`: resources whose status reads as degraded (restarting, dead or unhealthy); Parts are left out
  and exited counts as stopped. Each is `{ uuid, name, kind, status, serverName, projectName,
environmentName }`.
- `unreachable`: servers Coolify can't reach, as `{ uuid, name }` only.
- `error`: `{ error, cause }` when one of the connection's reads failed; the parts that were read stay.

`counts` sums each list, and `badge` is `running` plus `failed`. It asks Coolify nothing of its own: it is put
together from the deployment queue (10 seconds), resource (20 seconds) and server status (a minute) caches the
tab reads through, so the panel, the badge and the tab together cost one read per connection.
`?refresh=1` skips the queue and resource caches.

### Action `coolify.attention`

A read offered to the assistant and MCP, with an optional `refresh`. Its data is the route's answer and its
summary counts each kind, like "2 deployments in progress, 1 recent failure, 2 degraded resources, 1
unreachable server".

## Rollback

Rolling an application back to an earlier image, from the Deployments view or any operation surface.
Services and databases have no rollback images in Coolify, so a uuid that isn't one of the connection's own
applications is 404, and the Deployments view (applications only) is the only place the UI offers it.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/rollback-images`

The images Coolify can roll the application back to: images on its server (`local`) and, when a registry
image name is set, those of recent successful deployments in the registry (`registry`). Needs **View
Coolify** and any access to the connection. It answers `{ uuid, name, current, images }`, where `current` is
the tag the application runs now (null when nothing runs) and each image is
`{ tag, createdAt, current, source }`. Coolify answers an empty list when it can't inspect the server.

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/rollback`

Body `{ "image": "<tag>" }`. Rolls the application back to that image: Coolify queues a rollback
deployment, which shows in the history with the Rollback mark; the cached connection queue is dropped, so the Deployments section, the activity panel and the rail badge show it on their next read. Needs **Operate Coolify resources** and the
owner or an operate (or configure) grant, and runs `coolify.resource-rollback` confirmed: the Deployments
view asks first, naming the image tag. The image must be in the application's rollback images as Coolify
lists them at that moment; anything else is 400 `invalid-input`. It answers `{ uuid, image, deploymentUuid }`,
or 202 `{ "status": "pending", "runId" }` while an approval waits.

Like cancel, a rollback reads the connection once and checks, after every step and right before Coolify is
asked, that the connection still points at the same target and that your grant still reaches operate;
otherwise it ends with `target-changed` (409) or `forbidden` (403) and Coolify isn't asked. It also stops
before Coolify is asked once its run is cancelled.

### Actions `coolify.rollback`, `coolify.resource-rollback` and their image reads

`coolify.rollback-images` (resource scope, on `coolify.resource`) and `coolify.resource-rollback-images`
(server scope: `connectionId` and `uuid`) are reads offered to the assistant and MCP. Their data is the
route's answer plus `options` for pickers: every image but the one running now.

`coolify.rollback` (resource scope, on a Linked host's application) and `coolify.resource-rollback`
(server scope: `connectionId` and `uuid`) take `image`, whose choices come from the matching read
(`optionsFrom`). Both are destructive and need **Operate Coolify resources**; on a Linked host,
`coolify.rollback` needs the host shared at `edit`. Termix confirms them first, and their dry run (the
confirm text) names the image tag: "Would roll back web to image 0ld3r00". Over MCP they need
`confirmed: true` (the plugin refuses with `confirm-required` before core is asked) and **Allow changes over
MCP**; they are off for the assistant. Each declares its image read as `check`.

**Undo for deploy.** `coolify.deploy` declares `coolify.rollback` as its undo, and `coolify.resource-deploy`
declares `coolify.resource-rollback`. Before deploying an application, the deploy reads its rollback images,
and when an image runs now and is listed, the run records it as `undoInput` (`{ image }`, or
`{ connectionId, uuid, image }` for the server scope). Undoing the run rolls back to that image, after the
same checks as any rollback, including that the image is still listed. A deploy of a service, a database or
a Part, or of an application with nothing running, or one whose list can't be read, records no undo; the
deploy itself goes ahead either way.

## Pull request previews

An application's pull request previews: list, deploy, change domains, delete and container logs. Services
and databases have no previews, so a uuid that isn't one of the connection's own applications is 404 and
Coolify isn't asked. Coolify documents its preview API from 4.7.5 (the oldest spec the plugin vendors); an
older instance that answers 404 gets 409 `unsupported-by-instance` ("This Coolify instance does not have
this feature; update Coolify"), and the Previews tab says so.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/previews`

The application's previews. Needs **View Coolify** and any access to the connection. It answers `{ rows }`,
each `{ pullRequestId, uuid, pullRequestUrl, gitType, status, domains, composeDomains, dockerTag,
lastOnlineAt, createdAt, updatedAt, deploymentUuid, deploymentStatus, portOverrides }`. `domains` are the
public, portless ones; `portOverrides` maps each portless domain URL to Coolify's internal port for it. A
save replaces Coolify's overrides with the ports it sends, so an editor puts them back first (the Previews
tab does). `deploymentUuid` and
`deploymentStatus` are the newest build of that pull request among the application's latest 50
deployments, or null; its build log opens with the deployment routes above.

### `POST /plugin-api/coolify/connections/{id}/resources/{uuid}/previews`

Deploys the preview of a pull request: Coolify opens it, or redeploys it when it exists, and queues its
deployment. Needs **Operate Coolify resources** and the owner or an operate grant, and runs
`coolify.preview-create` confirmed (the Previews tab asks first). Body: `pullRequestId` (1 to 2147483647) and optionally `pullRequestUrl` (http or https), `gitType` (`github`, `gitlab`, `gitea` or
`bitbucket`; Coolify needs it unless the application uses a GitHub or GitLab App source), `commit` (a
SHA of 7 to 40 hex characters; a new Bitbucket preview needs it), `dockerTag` (a Docker image
tag; a new preview of a Docker image application needs it) and `force` (rebuild
without cache). A bad value is 400 `invalid-input` before Coolify is asked. A new preview (a pull request
the application has no preview for yet) of a Bitbucket pull request without `commit`, or of a Docker image
application without `dockerTag`, is 400 `invalid-input` too, before anything is created; a redeploy needs
neither. It answers
`{ pullRequestId, deploymentUuid }`, or 202 `{ "status": "pending", "runId" }` while an approval waits.
Coolify needs a token with `write` and `deploy` to open a preview.

### `PATCH /plugin-api/coolify/connections/{id}/resources/{uuid}/previews/{pullRequestId}`

Replaces a preview's domains. Needs **Operate Coolify resources** and an operate grant, and runs
`coolify.preview-domains` confirmed (the Previews tab asks first). Send `domains` for an ordinary
application, or `composeDomains` (`[{ name, domain }]`, an empty domain clearing that service's) for a
Docker Compose one. Each list is checked before Coolify is asked, by the same rules in the tab and the
backend: comma separated `http://` or `https://` URLs with a DNS host name (no IP address or single
label), an optional port and path, no user name or password, query or fragment, no repeats, at most 20.
Hosts are lowercased and a trailing slash dropped. A port you give is kept as written, `:80` and `:443`
included: Coolify keeps a preview's ports as internal routing overrides, so dropping one would change what it
does. `pullRequestUrl` is also sent as given. A list that fails is 400 `invalid-input` saying what is
wrong. It answers `{ pullRequestId, domains }` or `{ pullRequestId, composeDomains }`.

### `DELETE /plugin-api/coolify/connections/{id}/resources/{uuid}/previews/{pullRequestId}`

Deletes a preview: Coolify cancels its deployments, stops its containers and removes its volumes and
networks. Needs **Operate Coolify resources** and an operate grant, and runs `coolify.preview-delete`
(destructive) confirmed; the Previews tab asks first. It answers `{ pullRequestId }`, or 202 while an
approval waits. Coolify needs a token with `write` and `deploy`.

### `GET /plugin-api/coolify/connections/{id}/resources/{uuid}/previews/{pullRequestId}/logs?lines=&timestamps=`

The preview's container logs through Coolify (`lines` 1 to 10,000, default 100). Needs **Operate Coolify
resources** and an operate grant, and a token with `read:sensitive`. It answers `{ pullRequestId, text }`.
The text is redacted as one stream before it leaves the plugin, so a private key whose lines are split
still has its body masked, and logs that start inside a key are masked from their start through its END
line, as are the connection's own token and Access secret, passwords in URLs,
credential query parameters, secret-named fields and `Authorization` credentials.

Every preview call reads the connection once. After every step, and right before each request to Coolify,
it checks that the connection still points at the same target and that your grant still reaches the level
the call needs; otherwise it ends with `target-changed` (409) or `forbidden` (403) and Coolify isn't
asked. Changes also stop before Coolify is asked once their run is cancelled.

### Actions `coolify.preview-list`, `coolify.preview-create`, `coolify.preview-domains`, `coolify.preview-delete` and `coolify.preview-logs`

`coolify.preview-list` is a read offered to the assistant and MCP: `connectionId` and `uuid` (the
application); its data is the route's answer plus `options` for pickers.

`coolify.preview-create` and `coolify.preview-domains` are changes with the route's inputs plus
`connectionId`, `uuid` and `pullRequestId` (`composeDomains` as JSON). Over MCP each needs **Allow
changes over MCP** and `confirmed: true`, or it is refused before core is asked.

`coolify.preview-delete` is destructive, so Termix confirms it first (`confirmed: true` over the API and
MCP), and over MCP it also needs **Allow changes over MCP**.

`coolify.preview-logs` is a read offered to the assistant and MCP, and needs **Operate Coolify resources**.
Inputs: `connectionId`, `uuid`, `pullRequestId`, `confirm` (must be `true`: logs can hold secrets),
and optionally `lines` and `timestamps`. Its data is `{ pullRequestId, lineCount, text, handoffId }`;
`text` is the redacted log and a sensitive output, so run history never keeps it. Over MCP,
`coolify__preview_logs` answers it once to the caller.

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

## Linked host rows and host metrics

What Termix's dashboard host rows and the homepage's host metrics show for a Linked host. Each answers for
every Linked host of a connection in one request, so a list of hosts costs one request per connection.

### `GET /plugin-api/coolify/connections/{id}/server-health`

`{ servers, degraded, counts, deploying }`, by server uuid. `servers` lists `{ uuid, reachable, usable }`, or
is null when the token can't read servers. `counts` holds `{ running, degraded, stopped, deploying }` (Parts
left out, `exited` is stopped, bare `unhealthy` is degraded) and `deploying` the resources with a queued or
running deployment in Coolify's queue or a deploying status; both, and `degraded`, are null when the
resources can't be read. Everything comes from the shared caches (servers a minute, resources 20 seconds,
the queue 10 seconds). Needs **View Coolify**; another user's connection is 404, and a change of the
connection's address, token or Access settings while it reads answers 409 `target-changed`.

### `GET /plugin-api/coolify/connections/{id}/host-metrics?servers=`

`servers` is 1 to 20 comma separated server uuids. Answers `{ servers: { uuid: { containers, cpuPercent,
memoryBytes, cpus, memoryTotalBytes, at } }, errors: { uuid: cause } }`: the running containers' CPU
(`cpuPercent`, where 100 is one CPU) and memory summed from one `docker stats --no-stream` over SSH on the
server's Linked host, with the host's CPUs and memory from `docker info`. No container names. Each server is
read at most once every 30 seconds per connection target, however many people or rows ask, which is
never more often than the live stats socket. Needs **Operate Coolify resources** and the owner or an operate
grant (the Stats tab's rule), checked before anything runs: 403 otherwise. A server without a summary gets
its cause in `errors`: `not-linked`, `no-host-access` (no `connect` access to its host), `not-found`,
`host-key` or `ssh-failed`. 400 for a bad `servers`, 409 `target-changed` as above.

### Actions `coolify.host-summary` and `coolify.host-metrics`

Host actions for one Linked host (send `hostId`), offered to the assistant and MCP with the same data and
checks as the routes. Both answer `{ linked: false }` on a host that isn't linked. `coolify.host-summary`
answers `{ linked, connectionId, serverUuid, server, counts, deploying }` for that host's server and needs
your own `connect` access to the host. `coolify.host-metrics` answers `{ linked, connectionId, serverUuid,
stats }` and fails with the cause when the summary can't be read.

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
  grant. When a log or output field does come back, it is masked as container logs are: private keys
  (a log that starts inside one is masked from its start through the key's END), the connection's own
  token and Access secret, passwords in URLs, credential query parameters, secret-named fields and
  `Authorization` credentials.
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
