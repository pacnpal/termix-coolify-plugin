---
title: Coolify API coverage
order: 90
---

# Coolify API coverage

Every operation in the vendored Coolify API descriptions (`vendor/coolify/`: v4.7.5, `main` and `next`) and
how the plugin uses it. Each row is `used`, naming the plan task in
`docs/superpowers/plans/2026-11-19-coolify-1.0.md` that uses it, or `skipped`, with the reason.

In 1.0 every operation that isn't skipped can be reached through the generic `coolify.api-read` and
`coolify.api-call` operations (Task 18A) and the API console (Task 23A), checked against the plugin's
permissions, the connection grant and the Coolify token. Operations with their own screens later name the
release planned for them.

`tests/backend/coverage.test.ts` fails when an operation in any vendored spec is missing here, when a row
has no reason, or when the generated `OPERATIONS` table is out of date with the specs. After updating a spec,
run `npm run gen:coolify` and add the new rows.

## Applications

| Operation                                       | Status | Where or why                                                                                                                                   |
| ----------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| add-application-destination                     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| clone-application-by-uuid                       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| create-dockerfile-application                   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| create-dockerimage-application                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| create-env-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).             |
| create-preview-deployment-by-application-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| create-private-deploy-key-application           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| create-private-gitea-app-application            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| create-private-github-app-application           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| create-public-application                       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| create-storage-by-application-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).              |
| create-tag-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                              |
| delete-application-by-uuid                      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| delete-application-storage-backup-schedule      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).              |
| delete-env-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).             |
| delete-preview-deployment-by-pull-request-id    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| delete-storage-by-application-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).              |
| delete-tag-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                              |
| get-application-by-uuid                         | used   | Task 4 `resource()`, Task 10 (resource detail).                                                                                                |
| get-application-logs-by-uuid                    | used   | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                                             |
| get-preview-application-logs-by-pull-request-id | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| get-preview-deployment-by-pull-request-id       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| list-application-destinations                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| list-application-rollback-images                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| list-applications                               | used   | Task 4 `applications()`, Task 10 (resource list); 1.1 `applicationsTagged()` (`?tag=`) for `coolify.deploy-by-tag`.                            |
| list-envs-by-application-uuid                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).             |
| list-preview-deployments-by-application-uuid    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| list-storages-by-application-uuid               | used   | #19 `files-paths`, 18A `coolify.api-read`, 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                    |
| list-tags-by-application-uuid                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                              |
| migrate-application-by-uuid                     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| move-application-by-uuid                        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| remove-application-destination                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete). |
| restart-application-by-uuid                     | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                              |
| rollback-application-by-uuid                    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| run-application-storage-backup                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).              |
| set-application-storage-backup-schedule         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).              |
| start-application-by-uuid                       | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                              |
| stop-application-by-uuid                        | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                              |
| update-application-by-uuid                      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings).                 |
| update-env-by-application-uuid                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).             |
| update-envs-by-application-uuid                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).             |
| update-preview-domains-by-pull-request-id       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.1 Observe (previews and rollback).               |
| update-storage-by-application-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).              |

## Audit Events

| Operation         | Status | Where or why                                                                                                                         |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| list-audit-events | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Security section). |

## Cloud Tokens

| Operation                    | Status | Where or why                                                                                                                         |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| create-cloud-token           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| delete-cloud-token-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| get-cloud-token-by-uuid      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| list-cloud-tokens            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| update-cloud-token-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| validate-cloud-token-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |

## Cloud-init Scripts

| Operation                        | Status | Where or why                                                                                                                         |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| create-cloud-init-script         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| delete-cloud-init-script-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| get-cloud-init-script-by-uuid    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| list-cloud-init-scripts          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |
| update-cloud-init-script-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud provisioning). |

## DNS

| Operation                      | Status | Where or why                                                                                                                 |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| create-application-dns-record  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| create-service-dns-record      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| get-application-dns            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| get-service-dns                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| list-dns-zones                 | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| release-application-dns-record | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| release-service-dns-record     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| replace-application-dns-record | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |
| replace-service-dns-record     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (domains and DNS). |

## Databases

| Operation                               | Status  | Where or why                                                                                                                                                              |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clone-database-by-uuid                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-backup                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| create-database-clickhouse              | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-dragonfly               | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-import                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (database imports).                                             |
| create-database-influxdb                | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-keydb                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-mariadb                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-mongodb                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-mysql                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-postgresql              | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-redis                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-database-sqlite                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| create-env-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                        |
| create-storage-by-database-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| create-tag-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                                                         |
| delete-backup-configuration-by-uuid     | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| delete-backup-execution-by-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| delete-database-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| delete-database-storage-backup-schedule | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| delete-env-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                        |
| delete-storage-by-database-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| delete-tag-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                                                         |
| get-database-backups-by-uuid            | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| get-database-by-uuid                    | used    | Task 4 `resource()`, Task 10 (resource detail).                                                                                                                           |
| get-database-import                     | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (database imports).                                             |
| get-database-logs-by-uuid               | used    | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                                                                        |
| list-backup-executions                  | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| list-databases                          | used    | Task 4 `databases()`, Task 10 (resource list).                                                                                                                            |
| list-envs-by-database-uuid              | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                        |
| list-storages-by-database-uuid          | used    | #19 `files-paths`, 18A `coolify.api-read`, 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                               |
| list-tags-by-database-uuid              | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                                                         |
| migrate-database-by-uuid                | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| move-database-by-uuid                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                            |
| restart-database-by-uuid                | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                         |
| run-database-storage-backup             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| set-database-storage-backup-schedule    | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| start-database-by-uuid                  | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                         |
| stop-database-by-uuid                   | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                         |
| update-database-backup                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| update-database-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings).                                            |
| update-env-by-database-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                        |
| update-envs-by-database-uuid            | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                        |
| update-storage-by-database-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                         |
| upload-database-import                  | skipped | `ctx.fetch` only sends string bodies, so the plugin can't stream a binary multipart upload. Imports use the `server` and `s3` sources instead (design: Database imports). |

## Deployments

| Operation                    | Status | Where or why                                                                                                                                                |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cancel-deployment-by-uuid    | used   | 1.1 `cancelDeployment()`: `coolify.deployment-cancel` and the resource Deployments tab.                                                                     |
| deploy-by-tag-or-uuid        | used   | Task 4 `deploy()`, Tasks 11 and 12 (deploy and force rebuild); 1.1 `deployUuids()`: `coolify.deploy-by-tag` (by uuid, with force, PR and Docker tag).       |
| get-deployment-by-uuid       | used   | Task 4 `deployment()`, Task 12 (deploy with `wait` reports finished or failed); 1.1 `deploymentWithLog()`: `coolify.deployment-get` and the live build log. |
| list-deployments             | used   | 1.1 `runningDeployments()`: `coolify.deployment-queue`, the Deployments section and the Overview.                                                           |
| list-deployments-by-app-uuid | used   | 1.1 `deploymentPage()`: `coolify.deployment-list` and the resource Deployments tab history.                                                                 |

## Destinations

| Operation                  | Status | Where or why                                                                                                                      |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| create-server-destination  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| delete-destination-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-destination-by-uuid    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| list-destinations          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| list-server-destinations   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-destination-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |

## DigitalOcean

| Operation                  | Status | Where or why                                                                                                                          |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| create-digitalocean-server | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-digitalocean-images    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-digitalocean-regions   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-digitalocean-sizes     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-digitalocean-ssh-keys  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |

## GitHub Apps

| Operation         | Status | Where or why                                                                                                      |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| create-github-app | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| deleteGithubApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| list-github-apps  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| load-branches     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| load-repositories | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| updateGithubApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |

## GitLab Apps

| Operation         | Status | Where or why                                                                                                      |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| create-gitlab-app | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| deleteGitlabApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| list-gitlab-apps  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |
| updateGitlabApp   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |

## Gitea Apps

| Operation       | Status | Where or why                                                                                                      |
| --------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| list-gitea-apps | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (Sources). |

## Hetzner

| Operation                | Status | Where or why                                                                                                                          |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| create-hetzner-server    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hetzner-firewalls    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hetzner-images       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hetzner-locations    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hetzner-networks     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hetzner-server-types | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hetzner-ssh-keys     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |

## Hostinger

| Operation                          | Status | Where or why                                                                                                                          |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| create-hostinger-server            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hostinger-catalog              | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hostinger-data-centers         | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hostinger-post-install-scripts | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hostinger-ssh-keys             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-hostinger-templates            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |

## Integration Tokens

| Operation                               | Status | Where or why                                                                                                                         |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| create-secret-manager-integration-token | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (integration tokens). |
| delete-integration-token-by-uuid        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (integration tokens). |
| get-integration-token-by-uuid           | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (integration tokens). |
| list-integration-tokens                 | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (integration tokens). |
| sync-integration-token-zones            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (integration tokens). |
| update-integration-token-by-uuid        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (integration tokens). |

## Notifications

| Operation                                  | Status | Where or why                                                                                                                                    |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| get-current-team-discord-notifications     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| get-current-team-email-notifications       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| get-current-team-pushover-notifications    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| get-current-team-slack-notifications       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| get-current-team-telegram-notifications    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| get-current-team-webhook-notifications     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| update-current-team-discord-notifications  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| update-current-team-email-notifications    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| update-current-team-pushover-notifications | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| update-current-team-slack-notifications    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| update-current-team-telegram-notifications | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |
| update-current-team-webhook-notifications  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.2 Alerts / 1.3 Configure (Notifications section). |

## Private Keys

| Operation                  | Status | Where or why                                                                                                                   |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| create-private-key         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Keys section). |
| delete-private-key-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Keys section). |
| get-private-key-by-uuid    | used   | Task 4 `key()`, Task 6 (probe: key material readable, then dropped), Task 9 (mode A key copy).                                 |
| list-private-keys          | used   | Task 4 `keys()`, Task 6 (probe: can the token read keys), Task 9 (mode A key copy).                                            |
| update-private-key         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Keys section). |

## Projects

| Operation                       | Status | Where or why                                                                                                                        |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| create-environment              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| create-project                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| delete-environment              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| delete-project-by-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| get-environment-by-name-or-uuid | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| get-environments                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| get-project-by-uuid             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| list-projects                   | used   | Task 4 `projects()`, Task 6 (probe reads the team id from projects when `/team` is refused).                                        |
| update-environment              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |
| update-project-by-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (projects and environments). |

## Resources

| Operation      | Status | Where or why                                                                                                                       |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| list-resources | used   | Task 18A generic `coolify.api-read` only. The UI and services use the per-type lists (Task 10), because `/resources` is too heavy. |

## S3 Storages

| Operation                   | Status | Where or why                                                                                                          |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| create-s3-storage           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (S3 storages). |
| delete-s3-storage-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (S3 storages). |
| get-s3-storage-by-uuid      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (S3 storages). |
| list-s3-storages            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.4 Create (S3 storages). |
| update-s3-storage-by-uuid   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (S3 storages). |
| validate-s3-storage-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (S3 storages). |

## Scheduled Tasks

| Operation                                          | Status | Where or why                                                                                                                 |
| -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| create-scheduled-task-by-application-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| create-scheduled-task-by-service-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| delete-scheduled-task-by-application-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| delete-scheduled-task-by-service-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| execute-scheduled-task-by-application-uuid         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| execute-scheduled-task-by-service-uuid             | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| list-scheduled-task-executions-by-application-uuid | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| list-scheduled-task-executions-by-service-uuid     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| list-scheduled-tasks-by-application-uuid           | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| list-scheduled-tasks-by-service-uuid               | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| update-scheduled-task-by-application-uuid          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |
| update-scheduled-task-by-service-uuid              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (scheduled tasks). |

## Secret Managers

| Operation                            | Status | Where or why                                                                                                                 |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| add-secret-manager-reference         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (secret managers). |
| configure-application-secret-manager | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (secret managers). |
| get-secret-manager-source            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (secret managers). |
| import-secret-manager-references     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (secret managers). |
| list-secret-manager-keys             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (secret managers). |
| remove-secret-manager-source         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (secret managers). |
| set-secret-manager-source            | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (secret managers). |

## Servers

| Operation                             | Status | Where or why                                                                                                                      |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| check-server-import                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| check-server-registry-login           | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| complete-server-transfer              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| create-server                         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| delete-server-by-uuid                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| disable-server-cloudflare-tunnel      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| enable-server-cloudflare-tunnel       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-domains-by-server-uuid            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-resources-by-server-uuid          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-server-by-uuid                    | used   | Task 4 `server()`, Task 9 (host sync), Task 16 (patch status for server updates).                                                 |
| get-server-cloudflare-tunnel          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-server-docker-cleanup             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-server-image-scanning             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-server-log-drains                 | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-server-proxy                      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-server-sentinel                   | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| get-server-transfer-status            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| import-server-transfer-bundle         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| list-server-docker-cleanup-executions | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| list-server-registries                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| list-servers                          | used   | Task 4 `servers()`, Task 9 (host sync preview and apply).                                                                         |
| login-server-registry                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| logout-server-registry                | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| migrate-server-between-instances      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| reset-server-host-key-by-uuid         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| restart-server-proxy                  | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| run-server-docker-cleanup             | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| save-server-proxy-configuration       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-server-by-uuid                 | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-server-cloudflare-tunnel       | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-server-docker-cleanup          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-server-image-scanning          | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-server-log-drains              | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-server-proxy                   | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |
| update-server-sentinel                | used   | Task 4 `patchSentinel()`, Task 15 (turn metrics on).                                                                              |
| validate-server-by-uuid               | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (Servers section). |

## Service applications

| Operation                                                | Status | Where or why                                                                                                                   |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| get-service-application-by-service-and-app-uuid          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings). |
| get-service-application-logs-by-service-and-app-uuid     | used   | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                             |
| list-service-applications-by-service-uuid                | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings). |
| patch-service-application-by-service-and-app-uuid        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings). |
| post-restart-service-application-by-service-and-app-uuid | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                           |
| post-service-application-logs-by-service-and-app-uuid    | used   | Task 18A generic `coolify.api-call` and the Task 23A API console. It answers like the GET, which Task 14 reads logs with.      |
| post-start-service-application-by-service-and-app-uuid   | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                           |
| post-stop-service-application-by-service-and-app-uuid    | used   | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                           |

## Service databases

| Operation                                              | Status  | Where or why                                                                                                                                                              |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create-service-database-import                         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (database imports).                                             |
| get-service-database-by-service-and-database-uuid      | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings).                                            |
| get-service-database-import                            | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (database imports).                                             |
| get-service-database-logs-by-service-and-database-uuid | used    | Task 4 `logs()`, Task 14 (logs read from Coolify).                                                                                                                        |
| list-service-databases-by-service-uuid                 | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings).                                            |
| patch-service-database-by-service-and-database-uuid    | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings).                                            |
| restart-service-database-by-service-and-database-uuid  | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                                                                      |
| start-service-database-by-service-and-database-uuid    | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                                                                      |
| stop-service-database-by-service-and-database-uuid     | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes), for service parts.                                                                      |
| upload-service-database-import                         | skipped | `ctx.fetch` only sends string bodies, so the plugin can't stream a binary multipart upload. Imports use the `server` and `s3` sources instead (design: Database imports). |

## Services

| Operation                              | Status  | Where or why                                                                                                                                                         |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clone-service-by-uuid                  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                       |
| create-env-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                   |
| create-service                         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                       |
| create-storage-by-service-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                    |
| create-tag-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                                                    |
| delete-env-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                   |
| delete-service-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                       |
| delete-service-storage-backup-schedule | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                    |
| delete-storage-by-service-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                    |
| delete-tag-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags).                                                    |
| get-service-by-uuid                    | used    | Task 4 `resource()`, Task 10 (resource detail).                                                                                                                      |
| get-service-logs-by-uuid               | skipped | Needs a `sub_service_name` selector and answers 400 without one; logs are read per Part through the service-application and service-database logs endpoints instead. |
| list-envs-by-service-uuid              | used    | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                   |
| list-services                          | used    | Task 4 `services()`, Task 10 (resource list, services with their parts).                                                                                             |
| list-storages-by-service-uuid          | used    | #19 `files-paths`, 18A `coolify.api-read`, 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                          |
| list-tags-by-service-uuid              | used    | 1.1 `tagsOf()`: which services `coolify.deploy-by-tag` hits; its own UI is planned for 1.3 Configure (tags).                                                         |
| migrate-service-by-uuid                | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                       |
| move-service-by-uuid                   | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.4 Create (create, clone, move, migrate, delete).                       |
| restart-service-by-uuid                | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                    |
| run-service-storage-backup             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                    |
| set-service-storage-backup-schedule    | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                    |
| start-service-by-uuid                  | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                    |
| stop-service-by-uuid                   | used    | Task 4 `lifecycle()`, Tasks 11 and 12 (lifecycle service, operations and routes).                                                                                    |
| update-env-by-service-uuid             | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                   |
| update-envs-by-service-uuid            | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (environment variables).                                   |
| update-service-by-uuid                 | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (resource settings).                                       |
| update-storage-by-service-uuid         | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (storages and backups).                                    |

## Settings

| Operation                      | Status | Where or why                                                                                                                                                                                                                   |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| get-instance-email-settings    | used   | Task 4 `rootCheck()`, Task 6 (probe: is the token root; the settings are dropped unread); Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Instance section). |
| update-instance-email-settings | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Instance section).                                                                                           |

## Shared Environment Variables

| Operation                     | Status | Where or why                                                                                                                  |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| create-environment-shared-env | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| create-project-shared-env     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| create-server-shared-env      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| create-team-shared-env        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| delete-environment-shared-env | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| delete-project-shared-env     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| delete-server-shared-env      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| delete-team-shared-env        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| list-environment-shared-envs  | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| list-project-shared-envs      | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| list-server-shared-envs       | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| list-team-shared-envs         | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| update-environment-shared-env | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| update-project-shared-env     | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| update-server-shared-env      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |
| update-team-shared-env        | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (shared variables). |

## Tags

| Operation          | Status | Where or why                                                                                                      |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| create-tag         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags). |
| delete-tag-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags). |
| list-tags          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags). |
| update-tag-by-uuid | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.3 Configure (tags). |

## Teams

| Operation              | Status | Where or why                                                                                                                     |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| get-members-by-team-id | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Team section). |
| get-team-by-id         | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Team section). |
| get-token-team         | used   | Task 4 `team()`, Task 6 (probe: team name and id; 403 means a scoped token).                                                     |
| get-token-team-members | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Team section). |
| list-teams             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Team section). |
| update-token-team      | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Team section). |

## Vulnerabilities

| Operation                       | Status | Where or why                                                                                                                         |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| get-application-vulnerabilities | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Security section). |
| get-database-vulnerabilities    | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Security section). |
| get-service-vulnerabilities     | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Security section). |
| list-vulnerabilities            | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Security section). |

## Vultr

| Operation                   | Status | Where or why                                                                                                                          |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| create-vultr-server         | used   | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-vultr-operating-systems | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-vultr-plans             | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-vultr-regions           | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |
| get-vultr-ssh-keys          | used   | Task 18A generic `coolify.api-read` and the Task 23A API console; its own UI is planned for 1.5 Infrastructure (cloud server wizard). |

## Instance

| Operation   | Status  | Where or why                                                                                                                         |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| disable-api | skipped | Locks the plugin out: it turns the API off for every token. Also in `EXCLUDED_OPERATIONS`, so no code path can call it.              |
| disable-mcp | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Instance section). |
| enable-mcp  | used    | Task 18A generic `coolify.api-call` and the Task 23A API console; its own UI is planned for 1.6 Team and sharing (Instance section). |
| healthcheck | used    | Task 6 (probe: reachability), shown in the connection header (Task 20).                                                              |
| version     | used    | Task 6 (probe: version and the 4.4.0 floor), shown in the connection header (Task 20).                                               |
