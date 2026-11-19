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

| Operation                     | Plugin route                                                     | REST run path                                 | Key scope                             | MCP tool                       | Example                                                                                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coolify.list-connections`    | `GET /plugin-api/coolify/connections`                            | `/operations/coolify.list-connections/run`    | `operations:read` or `operations:run` | `coolify__list_connections`    | `curl -X POST "$TERMIX/operations/coolify.list-connections/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                                       |
| `coolify.connection-probe`    | `POST /plugin-api/coolify/connections/:id/probe`                 | `/operations/coolify.connection-probe/run`    | `operations:read` or `operations:run` | `coolify__connection_probe`    | `curl -X POST "$TERMIX/operations/coolify.connection-probe/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                     |
| `coolify.connection-create`   | `POST /plugin-api/coolify/connections`                           | `/operations/coolify.connection-create/run`   | `operations:run`                      | `coolify__connection_create`   | `curl -X POST "$TERMIX/operations/coolify.connection-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"name":"Prod","baseUrl":"https://coolify.example.com","token":"<Coolify API token>"}}'`                   |
| `coolify.connection-update`   | `PATCH /plugin-api/coolify/connections/:id`                      | `/operations/coolify.connection-update/run`   | `operations:run`                      | `coolify__connection_update`   | `curl -X POST "$TERMIX/operations/coolify.connection-update/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","name":"Production"}}'`                                                                |
| `coolify.connection-delete`   | `DELETE /plugin-api/coolify/connections/:id`                     | `/operations/coolify.connection-delete/run`   | `operations:run`                      | `coolify__connection_delete`   | `curl -X POST "$TERMIX/operations/coolify.connection-delete/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"},"confirmed":true}'`                                                                   |
| `coolify.list-api-reads`      | `GET /plugin-api/coolify/connections/:id/api/operations?reads=1` | `/operations/coolify.list-api-reads/run`      | `operations:read` or `operations:run` | `coolify__list_api_reads`      | `curl -X POST "$TERMIX/operations/coolify.list-api-reads/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                       |
| `coolify.list-api-operations` | `GET /plugin-api/coolify/connections/:id/api/operations`         | `/operations/coolify.list-api-operations/run` | `operations:read` or `operations:run` | `coolify__list_api_operations` | `curl -X POST "$TERMIX/operations/coolify.list-api-operations/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                                  |
| `coolify.api-read`            | `POST /plugin-api/coolify/connections/:id/api/call`              | `/operations/coolify.api-read/run`            | `operations:read` or `operations:run` | `coolify__api_read`            | `curl -X POST "$TERMIX/operations/coolify.api-read/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","operationId":"get-application-by-uuid","params":"{\"uuid\":\"<app uuid>\"}"}}'`                |
| `coolify.api-call`            | `POST /plugin-api/coolify/connections/:id/api/call`              | `/operations/coolify.api-call/run`            | `operations:run`                      | `coolify__api_call`            | `curl -X POST "$TERMIX/operations/coolify.api-call/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","operationId":"deploy-by-tag-or-uuid","params":"{\"uuid\":\"<app uuid>\"}"},"confirmed":true}'` |

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
- Over MCP, `coolify__api_read` is a read tool and `coolify__api_call` follows **Allow changes over MCP**.

The in-app **API console** (Coolify tab) draws a form for each operation. Reads run at once; anything else asks
for a confirm, and a DELETE asks you to type the operation id. Secrets in answers are masked. With
`coolify.configure`, configure access and a token with `read:sensitive`, you can reveal one value at a time;
each reveal is audited and nothing is kept.

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
  - `list_resources`: the applications, services and databases of a connection. Empty until resources
    arrive.
- **Changes over MCP are off by default.** Read tools always work. Change and destructive tools answer
  `mcp-changes-off` until an admin turns on **Allow changes over MCP** in the plugin's settings. That switch
  covers this endpoint only; the operations API and plugin routes follow normal permissions, key scope and
  approvals. A destructive tool also needs `confirmed: true` in its arguments.
- **Approvals:** when a rule needs a person, the tool answers with the run id and waits; the action runs once
  someone approves it in Termix.
- **Output** is `{ status, summary, data }` as text. Tokens, passwords, keys, env values and compose files are
  masked at any depth, and `data` longer than 8,000 characters is cut with a note.
