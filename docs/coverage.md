---
title: Coolify API coverage
order: 90
---

# Coolify API coverage

Every operation in the vendored Coolify API descriptions (`vendor/coolify/`: v4.7.5, `main` and `next`) and
how the plugin uses it. Each row is `used`, naming the plan task in
`docs/superpowers/plans/2026-11-19-coolify-1.0.md` that uses it, or `skipped`, with the reason.

Every operation that isn't skipped can be reached through the generic `coolify.api-read` and
`coolify.api-call` operations (Task 18A) and the API console (Task 23A), checked against the plugin's
permissions, the connection grant and the Coolify token. Rows that say "no dedicated UI yet" have no screen
of their own; use the API console for them.

`tests/backend/coverage.test.ts` fails when an operation in any vendored spec is missing here, when a row
has no reason, or when the generated `OPERATIONS` table is out of date with the specs. After updating a spec,
run `npm run gen:coolify` and add the new rows.

## Applications

| Operation                                       | Status | Where or why                                                                                                                                                  |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| add-application-destination                     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| clone-application-by-uuid                       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-dockerfile-application                   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-dockerimage-application                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-env-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-preview-deployment-by-application-uuid   | used   | `createPreview()`: `coolify.preview-create` and the resource Previews tab (deploy a preview).                                                                 |
| create-private-deploy-key-application           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-private-gitea-app-application            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-private-github-app-application           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-public-application                       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-storage-by-application-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| create-tag-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| delete-application-by-uuid                      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| delete-application-storage-backup-schedule      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| delete-env-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| delete-preview-deployment-by-pull-request-id    | used   | `deletePreview()`: `coolify.preview-delete` and the resource Previews tab.                                                                                    |
| delete-storage-by-application-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| delete-tag-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| get-application-by-uuid                         | used   | Task 4 `resource()`, Task 10 (resource detail).                                                                                                               |
| get-application-logs-by-uuid                    | used   | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                                                            |
| get-preview-application-logs-by-pull-request-id | used   | `previewLogs()`: `coolify.preview-logs` and the resource Previews tab (redacted container logs).                                                              |
| get-preview-deployment-by-pull-request-id       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; the Previews tab reads the list instead.                                                    |
| list-application-destinations                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                        |
| list-application-rollback-images                | used   | `rollbackImages()`: `coolify.rollback-images`, `coolify.resource-rollback-images`, the image list of the Deployments tab Rollback, and a deploy's undo input. |
| list-applications                               | used   | Task 4 `applications()`, Task 10 (resource list); `applicationsTagged()` (`?tag=`) for `coolify.deploy-by-tag`.                                               |
| list-envs-by-application-uuid                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                        |
| list-preview-deployments-by-application-uuid    | used   | `previews()`: `coolify.preview-list` and the resource Previews tab.                                                                                           |
| list-storages-by-application-uuid               | used   | #19 `files-paths`, 18A `coolify.api-read`, 23A API console; no dedicated UI yet.                                                                              |
| list-tags-by-application-uuid                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                        |
| migrate-application-by-uuid                     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| move-application-by-uuid                        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| remove-application-destination                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| restart-application-by-uuid                     | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                             |
| rollback-application-by-uuid                    | used   | `rollback()`: `coolify.rollback`, `coolify.resource-rollback` (deploy's undo) and the Deployments tab Rollback.                                               |
| run-application-storage-backup                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| set-application-storage-backup-schedule         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| start-application-by-uuid                       | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                             |
| stop-application-by-uuid                        | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                             |
| update-application-by-uuid                      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| update-env-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| update-envs-by-application-uuid                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |
| update-preview-domains-by-pull-request-id       | used   | `updatePreviewDomains()`: `coolify.preview-domains` and the resource Previews tab (domains checked first).                                                    |
| update-storage-by-application-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                        |

## Audit Events

| Operation         | Status | Where or why                                                                           |
| ----------------- | ------ | -------------------------------------------------------------------------------------- |
| list-audit-events | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |

## Cloud Tokens

| Operation                    | Status | Where or why                                                                           |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-cloud-token           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-cloud-token-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-cloud-token-by-uuid      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-cloud-tokens            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-cloud-token-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| validate-cloud-token-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Cloud-init Scripts

| Operation                        | Status | Where or why                                                                           |
| -------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-cloud-init-script         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-cloud-init-script-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-cloud-init-script-by-uuid    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-cloud-init-scripts          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-cloud-init-script-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## DNS

| Operation                      | Status | Where or why                                                                           |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------- |
| create-application-dns-record  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| create-service-dns-record      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-application-dns            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-service-dns                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-dns-zones                 | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| release-application-dns-record | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| release-service-dns-record     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| replace-application-dns-record | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| replace-service-dns-record     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Databases

| Operation                               | Status  | Where or why                                                                                                                                                                |
| --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clone-database-by-uuid                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-backup                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-clickhouse              | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-dragonfly               | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-import                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-influxdb                | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-keydb                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-mariadb                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-mongodb                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-mysql                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-postgresql              | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-redis                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-database-sqlite                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-env-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-storage-by-database-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| create-tag-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| delete-backup-configuration-by-uuid     | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| delete-backup-execution-by-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| delete-database-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| delete-database-storage-backup-schedule | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| delete-env-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| delete-storage-by-database-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| delete-tag-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| get-database-backups-by-uuid            | used    | poller `backupRuns()`: backup-succeeded and backup-failed events every five minutes; Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-database-by-uuid                    | used    | Task 4 `resource()`, Task 10 (resource detail).                                                                                                                             |
| get-database-import                     | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| get-database-logs-by-uuid               | used    | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                                                                          |
| list-backup-executions                  | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| list-databases                          | used    | Task 4 `databases()`, Task 10 (resource list).                                                                                                                              |
| list-envs-by-database-uuid              | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| list-storages-by-database-uuid          | used    | #19 `files-paths`, 18A `coolify.api-read`, 23A API console; no dedicated UI yet.                                                                                            |
| list-tags-by-database-uuid              | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| migrate-database-by-uuid                | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| move-database-by-uuid                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| restart-database-by-uuid                | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                           |
| run-database-storage-backup             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| set-database-storage-backup-schedule    | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| start-database-by-uuid                  | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                           |
| stop-database-by-uuid                   | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                           |
| update-database-backup                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| update-database-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| update-env-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| update-envs-by-database-uuid            | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| update-storage-by-database-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                      |
| upload-database-import                  | skipped | `ctx.fetch` only sends string bodies, so the plugin can't stream a binary multipart upload. Imports use the `server` and `s3` sources instead (design: Database imports).   |

## Deployments

| Operation                    | Status | Where or why                                                                                                                                                     |
| ---------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cancel-deployment-by-uuid    | used   | `cancelDeployment()`: `coolify.deployment-cancel` and the resource Deployments tab.                                                                              |
| deploy-by-tag-or-uuid        | used   | Task 4 `deploy()`, Tasks 11 and 12 (deploy and force rebuild); `deployUuids()`: `coolify.deploy-by-tag` (by uuid, with force, PR and Docker tag).                |
| get-deployment-by-uuid       | used   | Task 4 `deployment()`, Task 12 (deploy with `wait` reports finished, failed or skipped); `deploymentWithLog()`: `coolify.deployment-get` and the live build log. |
| list-deployments             | used   | `runningDeployments()`: `coolify.deployment-queue`, the Deployments section and the Overview.                                                                    |
| list-deployments-by-app-uuid | used   | `deploymentPage()`: `coolify.deployment-list` and the resource Deployments tab history.                                                                          |

## Destinations

| Operation                  | Status | Where or why                                                                           |
| -------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-server-destination  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-destination-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-destination-by-uuid    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-destinations          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-server-destinations   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-destination-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## DigitalOcean

| Operation                  | Status | Where or why                                                                           |
| -------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-digitalocean-server | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-digitalocean-images    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-digitalocean-regions   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-digitalocean-sizes     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-digitalocean-ssh-keys  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |

## GitHub Apps

| Operation         | Status | Where or why                                                                           |
| ----------------- | ------ | -------------------------------------------------------------------------------------- |
| create-github-app | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| deleteGithubApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| list-github-apps  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| load-branches     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| load-repositories | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| updateGithubApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## GitLab Apps

| Operation         | Status | Where or why                                                                           |
| ----------------- | ------ | -------------------------------------------------------------------------------------- |
| create-gitlab-app | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| deleteGitlabApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| list-gitlab-apps  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| updateGitlabApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Gitea Apps

| Operation       | Status | Where or why                                                                           |
| --------------- | ------ | -------------------------------------------------------------------------------------- |
| list-gitea-apps | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |

## Hetzner

| Operation                | Status | Where or why                                                                           |
| ------------------------ | ------ | -------------------------------------------------------------------------------------- |
| create-hetzner-server    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-hetzner-firewalls    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hetzner-images       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hetzner-locations    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hetzner-networks     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hetzner-server-types | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hetzner-ssh-keys     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |

## Hostinger

| Operation                          | Status | Where or why                                                                           |
| ---------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-hostinger-server            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-hostinger-catalog              | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hostinger-data-centers         | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hostinger-post-install-scripts | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hostinger-ssh-keys             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-hostinger-templates            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |

## Integration Tokens

| Operation                               | Status | Where or why                                                                           |
| --------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-secret-manager-integration-token | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-integration-token-by-uuid        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-integration-token-by-uuid           | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-integration-tokens                 | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| sync-integration-token-zones            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-integration-token-by-uuid        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Notifications

| Operation                                  | Status | Where or why                                                                                                                        |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| get-current-team-discord-notifications     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                              |
| get-current-team-email-notifications       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                              |
| get-current-team-pushover-notifications    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                              |
| get-current-team-slack-notifications       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                              |
| get-current-team-telegram-notifications    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                              |
| get-current-team-webhook-notifications     | used   | #92 webhook setup (`coolify.webhook-status`, `-setup`, `-replace`, `-disable`), the generic `coolify.api-read` and the API console. |
| update-current-team-discord-notifications  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                              |
| update-current-team-email-notifications    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                              |
| update-current-team-pushover-notifications | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                              |
| update-current-team-slack-notifications    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                              |
| update-current-team-telegram-notifications | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                              |
| update-current-team-webhook-notifications  | used   | #92 webhook setup (`coolify.webhook-setup`, `-replace`, `-disable`), the generic `coolify.api-call` and the API console.            |

## Private Keys

| Operation                  | Status | Where or why                                                                                   |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| create-private-key         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.         |
| delete-private-key-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.         |
| get-private-key-by-uuid    | used   | Task 4 `key()`, Task 6 (probe: key material readable, then dropped), Task 9 (mode A key copy). |
| list-private-keys          | used   | Task 4 `keys()`, Task 6 (probe: can the token read keys), Task 9 (mode A key copy).            |
| update-private-key         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.         |

## Projects

| Operation                       | Status | Where or why                                                                                 |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| create-environment              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.       |
| create-project                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.       |
| delete-environment              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.       |
| delete-project-by-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.       |
| get-environment-by-name-or-uuid | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.       |
| get-environments                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.       |
| get-project-by-uuid             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.       |
| list-projects                   | used   | Task 4 `projects()`, Task 6 (probe reads the team id from projects when `/team` is refused). |
| update-environment              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.       |
| update-project-by-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.       |

## Resources

| Operation      | Status | Where or why                                                                                                                       |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| list-resources | used   | Task 18A generic `coolify.api-read` only. The UI and services use the per-type lists (Task 10), because `/resources` is too heavy. |

## S3 Storages

| Operation                   | Status | Where or why                                                                           |
| --------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-s3-storage           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-s3-storage-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-s3-storage-by-uuid      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-s3-storages            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-s3-storage-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| validate-s3-storage-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Scheduled Tasks

| Operation                                          | Status | Where or why                                                                                                                                       |
| -------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| create-scheduled-task-by-application-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |
| create-scheduled-task-by-service-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |
| delete-scheduled-task-by-application-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |
| delete-scheduled-task-by-service-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |
| execute-scheduled-task-by-application-uuid         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |
| execute-scheduled-task-by-service-uuid             | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |
| list-scheduled-task-executions-by-application-uuid | used   | poller `taskRuns()`: task-succeeded and task-failed events; Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-scheduled-task-executions-by-service-uuid     | used   | poller `taskRuns()`: task-succeeded and task-failed events; Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-scheduled-tasks-by-application-uuid           | used   | poller `scheduledTasks()`: which tasks' runs to read; Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.       |
| list-scheduled-tasks-by-service-uuid               | used   | poller `scheduledTasks()`: which tasks' runs to read; Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.       |
| update-scheduled-task-by-application-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |
| update-scheduled-task-by-service-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                             |

## Secret Managers

| Operation                            | Status | Where or why                                                                           |
| ------------------------------------ | ------ | -------------------------------------------------------------------------------------- |
| add-secret-manager-reference         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| configure-application-secret-manager | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-secret-manager-source            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| import-secret-manager-references     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| list-secret-manager-keys             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| remove-secret-manager-source         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| set-secret-manager-source            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Servers

| Operation                             | Status | Where or why                                                                           |
| ------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| check-server-import                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| check-server-registry-login           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| complete-server-transfer              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| create-server                         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-server-by-uuid                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| disable-server-cloudflare-tunnel      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| enable-server-cloudflare-tunnel       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-domains-by-server-uuid            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-resources-by-server-uuid          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-server-by-uuid                    | used   | Task 4 `server()`, Task 9 (host sync), Task 16 (patch status for server updates).      |
| get-server-cloudflare-tunnel          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-server-docker-cleanup             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-server-image-scanning             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-server-log-drains                 | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-server-proxy                      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-server-sentinel                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-server-transfer-status            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| import-server-transfer-bundle         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| list-server-docker-cleanup-executions | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-server-registries                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-servers                          | used   | Task 4 `servers()`, Task 9 (host sync preview and apply).                              |
| login-server-registry                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| logout-server-registry                | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| migrate-server-between-instances      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| reset-server-host-key-by-uuid         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| restart-server-proxy                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| run-server-docker-cleanup             | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| save-server-proxy-configuration       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-by-uuid                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-cloudflare-tunnel       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-docker-cleanup          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-image-scanning          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-log-drains              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-proxy                   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-sentinel                | used   | Task 4 `patchSentinel()`, Task 15 (turn metrics on).                                   |
| validate-server-by-uuid               | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Service applications

| Operation                                                | Status | Where or why                                                                                                              |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| get-service-application-by-service-and-app-uuid          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                    |
| get-service-application-logs-by-service-and-app-uuid     | used   | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                        |
| list-service-applications-by-service-uuid                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                    |
| patch-service-application-by-service-and-app-uuid        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                    |
| post-restart-service-application-by-service-and-app-uuid | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                      |
| post-service-application-logs-by-service-and-app-uuid    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console. It answers like the GET, which Task 14 reads logs with. |
| post-start-service-application-by-service-and-app-uuid   | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                      |
| post-stop-service-application-by-service-and-app-uuid    | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                      |

## Service databases

| Operation                                              | Status  | Where or why                                                                                                                                                              |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create-service-database-import                         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                    |
| get-service-database-by-service-and-database-uuid      | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                    |
| get-service-database-import                            | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                    |
| get-service-database-logs-by-service-and-database-uuid | used    | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                                                                        |
| list-service-databases-by-service-uuid                 | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                    |
| patch-service-database-by-service-and-database-uuid    | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                    |
| restart-service-database-by-service-and-database-uuid  | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                                                                      |
| start-service-database-by-service-and-database-uuid    | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                                                                      |
| stop-service-database-by-service-and-database-uuid     | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                                                                      |
| upload-service-database-import                         | skipped | `ctx.fetch` only sends string bodies, so the plugin can't stream a binary multipart upload. Imports use the `server` and `s3` sources instead (design: Database imports). |

## Services

| Operation                              | Status  | Where or why                                                                                                                                                         |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clone-service-by-uuid                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| create-env-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| create-service                         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| create-storage-by-service-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| create-tag-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| delete-env-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| delete-service-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| delete-service-storage-backup-schedule | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| delete-storage-by-service-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| delete-tag-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| get-service-by-uuid                    | used    | Task 4 `resource()`, Task 10 (resource detail).                                                                                                                      |
| get-service-logs-by-uuid               | skipped | Needs a `sub_service_name` selector and answers 400 without one; logs are read per Part through the service-application and service-database logs endpoints instead. |
| list-envs-by-service-uuid              | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                               |
| list-services                          | used    | Task 4 `services()`, Task 10 (resource list, services with their parts).                                                                                             |
| list-storages-by-service-uuid          | used    | #19 `files-paths`, 18A `coolify.api-read`, 23A API console; no dedicated UI yet.                                                                                     |
| list-tags-by-service-uuid              | used    | `tagsOf()`: which services `coolify.deploy-by-tag` hits; no dedicated UI yet.                                                                                        |
| migrate-service-by-uuid                | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| move-service-by-uuid                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| restart-service-by-uuid                | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                    |
| run-service-storage-backup             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| set-service-storage-backup-schedule    | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| start-service-by-uuid                  | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                    |
| stop-service-by-uuid                   | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                    |
| update-env-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| update-envs-by-service-uuid            | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| update-service-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |
| update-storage-by-service-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                               |

## Settings

| Operation                      | Status | Where or why                                                                                                                                                                     |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| get-instance-email-settings    | used   | Task 4 `rootCheck()`, Task 6 (probe: is the token root; the settings are dropped unread); Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-instance-email-settings | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                                                                           |

## Shared Environment Variables

| Operation                     | Status | Where or why                                                                           |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-environment-shared-env | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| create-project-shared-env     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| create-server-shared-env      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| create-team-shared-env        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-environment-shared-env | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-project-shared-env     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-server-shared-env      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-team-shared-env        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| list-environment-shared-envs  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-project-shared-envs      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-server-shared-envs       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-team-shared-envs         | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-environment-shared-env | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-project-shared-env     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-server-shared-env      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| update-team-shared-env        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Tags

| Operation          | Status | Where or why                                                                           |
| ------------------ | ------ | -------------------------------------------------------------------------------------- |
| create-tag         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| delete-tag-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| list-tags          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-tag-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Teams

| Operation              | Status | Where or why                                                                           |
| ---------------------- | ------ | -------------------------------------------------------------------------------------- |
| get-members-by-team-id | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-team-by-id         | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-token-team         | used   | Task 4 `team()`, Task 6 (probe: team name and id; 403 means a scoped token).           |
| get-token-team-members | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| list-teams             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| update-token-team      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |

## Vulnerabilities

| Operation                       | Status | Where or why                                                                                                                                                          |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| get-application-vulnerabilities | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                |
| get-database-vulnerabilities    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                |
| get-service-vulnerabilities     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet.                                                                                |
| list-vulnerabilities            | used   | `vulnerabilities()`: `coolify.vulnerability-summary` and the vulnerabilities dashboard card and homepage widget (counts only); the full list has no dedicated UI yet. |

## Vultr

| Operation                   | Status | Where or why                                                                           |
| --------------------------- | ------ | -------------------------------------------------------------------------------------- |
| create-vultr-server         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet. |
| get-vultr-operating-systems | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-vultr-plans             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-vultr-regions           | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |
| get-vultr-ssh-keys          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; no dedicated UI yet. |

## Instance

| Operation   | Status  | Where or why                                                                                                            |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| disable-api | skipped | Locks the plugin out: it turns the API off for every token. Also in `EXCLUDED_OPERATIONS`, so no code path can call it. |
| disable-mcp | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                  |
| enable-mcp  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; no dedicated UI yet.                                  |
| healthcheck | used    | Task 6 (probe: reachability), shown in the connection header (Task 20).                                                 |
| version     | used    | Task 6 (probe: version and the 4.4.0 floor), shown in the connection header (Task 20).                                  |
