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

| Operation                    | Plugin route                                              | REST run path                                | Key scope                             | MCP tool                      | Example                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------------- | ------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coolify.list-connections`   | `GET /plugin-api/coolify/connections`                     | `/operations/coolify.list-connections/run`   | `operations:read` or `operations:run` | `coolify__list_connections`   | `curl -X POST "$TERMIX/operations/coolify.list-connections/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                     |
| `coolify.connection-probe`   | `POST /plugin-api/coolify/connections/:id/probe`          | `/operations/coolify.connection-probe/run`   | `operations:read` or `operations:run` | `coolify__connection_probe`   | `curl -X POST "$TERMIX/operations/coolify.connection-probe/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                   |
| `coolify.connection-create`  | `POST /plugin-api/coolify/connections`                    | `/operations/coolify.connection-create/run`  | `operations:run`                      | `coolify__connection_create`  | `curl -X POST "$TERMIX/operations/coolify.connection-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"name":"Prod","baseUrl":"https://coolify.example.com","token":"<Coolify API token>"}}'` |
| `coolify.connection-update`  | `PATCH /plugin-api/coolify/connections/:id`               | `/operations/coolify.connection-update/run`  | `operations:run`                      | `coolify__connection_update`  | `curl -X POST "$TERMIX/operations/coolify.connection-update/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","name":"Production"}}'`                                              |
| `coolify.connection-delete`  | `DELETE /plugin-api/coolify/connections/:id`              | `/operations/coolify.connection-delete/run`  | `operations:run`                      | `coolify__connection_delete`  | `curl -X POST "$TERMIX/operations/coolify.connection-delete/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"},"confirmed":true}'`                                                 |
| `coolify.list-resources-all` | `GET /plugin-api/coolify/connections/:id/resources`       | `/operations/coolify.list-resources-all/run` | `operations:read` or `operations:run` | `coolify__list_resources_all` | `curl -X POST "$TERMIX/operations/coolify.list-resources-all/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1"}}'`                                                                 |
| `coolify.resource-get`       | `GET /plugin-api/coolify/connections/:id/resources/:uuid` | `/operations/coolify.resource-get/run`       | `operations:read` or `operations:run` | `coolify__resource_get`       | `curl -X POST "$TERMIX/operations/coolify.resource-get/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","uuid":"<resource uuid>"}}'`                                              |
| `coolify.status-page-list`   | `GET /plugin-api/coolify/connections/:id/status-pages`    | `/operations/coolify.status-page-list/run`   | `operations:read` or `operations:run` | `coolify__status_page_list`   | `curl -X POST "$TERMIX/operations/coolify.status-page-list/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{}}'`                                                                                     |
| `coolify.status-page-create` | `POST /plugin-api/coolify/connections/:id/status-pages`   | `/operations/coolify.status-page-create/run` | `operations:run`                      | `coolify__status_page_create` | `curl -X POST "$TERMIX/operations/coolify.status-page-create/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"connectionId":"1","title":"Shop status","resources":["<resource uuid>"]}}'`           |
| `coolify.status-page-rotate` | `POST /plugin-api/coolify/status-pages/:id/rotate`        | `/operations/coolify.status-page-rotate/run` | `operations:run`                      | `coolify__status_page_rotate` | `curl -X POST "$TERMIX/operations/coolify.status-page-rotate/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"id":"1"},"confirmed":true}'`                                                          |
| `coolify.status-page-revoke` | `DELETE /plugin-api/coolify/status-pages/:id`             | `/operations/coolify.status-page-revoke/run` | `operations:run`                      | `coolify__status_page_revoke` | `curl -X POST "$TERMIX/operations/coolify.status-page-revoke/run" -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" -d '{"input":{"id":"1"},"confirmed":true}'`                                                          |

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
  - `take_status_page_url`: takes a status page URL once, by the `handoffId` a create or rotate answered
    (see below).
- **Changes over MCP are off by default.** Read tools always work. Change and destructive tools answer
  `mcp-changes-off` until an admin turns on **Allow changes over MCP** in the plugin's settings. That switch
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

The page itself is `GET /plugin-api/coolify/status/<token>` (HTML) or `…/status/<token>.json`, with no
login.
