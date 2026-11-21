# Read-only smoke test for 1.0.0

Run this yourself against your own Termix and Coolify. Nothing here changes Coolify or Termix hosts: every
step is a `read` action, and each one sends Coolify only `GET` requests. The container lookup runs
`docker ps` over SSH, which only reads.

## 0. Make writes impossible first

Set these up so that even a mistake can't write anything:

1. **A read-only Coolify token.** In Coolify, Keys & Tokens, API tokens, create a token with only `read` and
   `read:sensitive`. No `write`, `deploy` or `delete`: Coolify itself refuses any change from it with 403.
2. **A connection that uses it.** In the Coolify tab, choose **Add connection** with that token (or edit an
   existing connection and paste it). This stores a row in Termix only; it sends Coolify nothing but reads.
3. **A read-only Termix key.** In Termix, create an API key scoped to `operations:read` only. Termix's
   operations gate refuses every `change` and `destructive` action for it before the plugin runs.

```sh
export TERMIX="https://termix.example.com"   # your Termix address
export TERMIX_API_KEY="tmx_..."              # the operations:read key
export COOLIFY="https://coolify.example.com" # your Coolify address
export COOLIFY_TOKEN="..."                   # the read-only Coolify token
```

Don't paste either token into the PR or an issue.

## 1. Before: record what is there

```sh
# Coolify's deployments queue and its server list, straight from Coolify with the read-only token
curl -s "$COOLIFY/api/v1/deployments" -H "Authorization: Bearer $COOLIFY_TOKEN" | tee before-deployments.json
curl -s "$COOLIFY/api/v1/servers" -H "Authorization: Bearer $COOLIFY_TOKEN" | tee before-servers.json
```

Also note the number of hosts in Termix's Hosts list, and the time.

## 2. Find the connection id

```sh
curl -s -X POST "$TERMIX/operations/coolify.list-connections/run" \
  -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" \
  -d '{"input":{}}'
export CONN="1"   # the id of the read-only connection from the answer
```

Expected: `status: "success"` and rows with `id`, `name`, `baseUrl`; no token anywhere in the answer.

## 3. Probe

```sh
curl -s -X POST "$TERMIX/operations/coolify.connection-probe/run" \
  -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" \
  -d "{\"input\":{\"connectionId\":\"$CONN\"}}"
```

Expected: the Coolify version (4.4 or newer), the team, `abilities.read: true`, `abilities.sensitive: true`,
and a checklist of steps. Record the version and the steps.

## 4. Sync preview

```sh
curl -s -X POST "$TERMIX/operations/coolify.sync-preview/run" \
  -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" \
  -d "{\"input\":{\"connectionId\":\"$CONN\"}}"
```

Expected: one row per Coolify server with its `status` (`new`, `linked`, `gone` or `blocked`) and any
`cause`. No host is created: the preview only reads. Record the row count and statuses.

## 5. Resources list

```sh
curl -s -X POST "$TERMIX/operations/coolify.list-resources-all/run" \
  -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" \
  -d "{\"input\":{\"connectionId\":\"$CONN\"}}"
export UUID="..."   # one application uuid from the answer, on a server that is already a Linked host
```

Expected: applications, services (each followed by its parts) and databases, with `status`; no env values,
passwords or compose files. Record the counts.

## 6. One container lookup

Needs a resource whose server is already a Linked host, and a Termix user with **Operate Coolify resources**
and `connect` access to that host.

```sh
curl -s -X POST "$TERMIX/operations/coolify.shell-command/run" \
  -H "Authorization: Bearer $TERMIX_API_KEY" -H "Content-Type: application/json" \
  -d "{\"input\":{\"connectionId\":\"$CONN\",\"uuid\":\"$UUID\",\"console\":\"shell\"}}"
```

Expected: the Linked host id, the container name `docker ps` found, and the `docker exec` line, which is
only returned, never run. `not-linked` means the server has no Linked host yet: pick another resource rather
than syncing (a sync writes hosts).

## 7. After: confirm nothing was written

```sh
curl -s "$COOLIFY/api/v1/deployments" -H "Authorization: Bearer $COOLIFY_TOKEN" | diff before-deployments.json -
curl -s "$COOLIFY/api/v1/servers" -H "Authorization: Bearer $COOLIFY_TOKEN" | diff before-servers.json -
```

- Both diffs are empty (servers can differ only in live fields such as `updated_at` or a status Coolify
  refreshed by itself).
- Termix's Hosts list has the same number of hosts.
- Termix's run history (Operations Center) since the time you noted shows only the five reads above, all
  `read`, run by the `operations:read` key.
- The Coolify token's abilities never allowed a write, and the `operations:read` key could not have started
  one.

Paste the version, the step results and the counts from 3 to 6 into the PR description.
