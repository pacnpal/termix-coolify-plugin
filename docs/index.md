Coolify for Termix brings your Coolify servers, applications, services and databases into Termix.

So far you can connect Coolify instances, see what each API token can do, sync Coolify servers into
Termix hosts, and use other Termix plugins (DNS, Uptime, Log Search and more) with them. Resources, shells and the rest come with the rest of release 1.0.0.

## Turn it on

1. Install Coolify for Termix from the Plugins tab.
2. Open the Coolify tab from the sidebar, or use the "Connect Coolify" step in setup.

## Connect a Coolify instance

1. In Coolify, open Keys & Tokens, API tokens, and create a token with the abilities **read, read:sensitive,
   write and deploy**. Everything works with these except deletes and instance settings, and a leaked token
   can't wipe your resources. Add `delete`, or use `root`, only if you want those from Termix.
2. In the Coolify tab, choose **Add connection** and enter a name, the address you open Coolify at and the
   token.
3. Under **Advanced**, if you need them:
   - **Cloudflare Access client ID and secret**, when the Coolify dashboard sits behind Cloudflare Access.
   - **On my local network**, when Coolify has a private address such as `192.168.1.10`.
   - **CA certificate**, when Coolify uses a certificate from a private CA.
4. Save. Termix checks the connection and shows what the token can do:
   - Coolify answers, and is 4.4 or newer (older versions are refused).
   - The team, or, for a token scoped to some projects, the team of its first project. A scoped token can't
     see servers, so it has no host sync, shells or keys, and can't set up notifications.
   - Whether it can read private keys and logs (`read:sensitive`) and instance settings (`root`).
     Write, deploy and delete can't be checked without changing something; they're checked on first use.

The token is stored encrypted and never shown again. When you edit a connection, leave the token empty to
keep the stored one. **Check again** reruns the checks. **Remove** forgets the connection and its token;
nothing changes in Coolify, and hosts made for its servers become ordinary hosts.

When a check fails, the connection says why: Coolify can't be reached, the token was refused, API access is
off in Coolify (Settings, Advanced), Coolify is behind Cloudflare Access, or the address isn't a Coolify API.

Connections are also actions, for the CLI, Automations and the phone app: `coolify.list-connections`,
`coolify.connection-probe`, `coolify.connection-create`, `coolify.connection-update` and
`coolify.connection-delete`. The token and Cloudflare Access fields are secret inputs: they never appear in
run history. Only the two reads are offered to the assistant and MCP.

Adding, changing and removing connections needs **Configure Coolify**; listing and checking them needs
**View Coolify**. Each person sees only their own connections.

## Sync servers into hosts

Each Coolify server can become a **Linked host**: a Termix host that Coolify for Termix creates and keeps in
step with Coolify. Open it from **Sync servers** on a connection, **Import from Coolify** in the hosts import
menu, or **Sync from Coolify** on a Linked host.

1. The preview lists every server the token can see and what it becomes: name, address, port and user, in
   the **Coolify** folder (**Coolify / <connection>** when you have several connections), tagged `coolify`,
   with a note linking back to the server in Coolify. Nothing changes until you confirm.
2. Tick the servers to include and choose **Create and update hosts**. Servers that can't sync yet say why,
   and the others sync anyway:
   - **The server Coolify runs on** (Coolify calls it `host.docker.internal`, `localhost` or `127.x`): enter
     the address Termix should use. The connection's own host name is offered with one click. The address is
     kept for later syncs. You can set an address for any server the same way.
   - **No key to copy**: when the token can't read keys (it lacks `read:sensitive`) or an admin turned off
     **Allow copying Coolify SSH keys**, pick one of your Termix credentials for the server. Only your own credentials are accepted; a picked
     credential you no longer have blocks the server until you pick another.
   - **Behind a Cloudflare tunnel**: tunnelled servers are listed but can't be synced yet.
3. With keys readable, each Coolify key is copied once into a Termix credential named
   **Coolify: <connection> / <key>** and shared by every server that uses it. It is reused on later syncs
   and replaced only when the key's fingerprint changes. Every copy is written to the audit log. The key is
   never stored by the plugin, logged or sent back to the browser.

Syncing again updates the same hosts in place, so pins, shares and history stay. A server removed from
Coolify is shown as **Gone from Coolify** and is never deleted for you: choose **Keep as normal host** or
**Remove host**.

Linked hosts are read only while Coolify manages them. They show a **Coolify** badge, a status dot when
Coolify can't reach the server, and a Coolify card on the host page with **Resources**, **Sync from
Coolify** and **Unlink**, which are also in the host's menu. **Unlink** makes the host an ordinary, editable
host and keeps it. If you delete a Linked host yourself, the plugin forgets the link but keeps its address
and credential choice, so the next sync creates it again. Removing a connection unlinks its hosts, or
deletes them when you ask it to.

Syncing and unlinking need **Configure Coolify** and only the connection's owner can do them; the preview
needs **View Coolify**. They are also actions: `coolify.sync-preview` (offered to the assistant and MCP),
`coolify.sync-apply` (without a server list it syncs every server with its saved address and credential)
and `coolify.unlink`.

## Other Termix plugins

Built for DNS 1.1, Uptime 1.0.1, Log Search 1.1, Security Center 1.1, Host Metrics 1.4.1, Databases 1.3 and
Backups 1.1. When one of these Termix plugins is installed and running, its Coolify feature appears. When it isn't, that
feature hides and nothing else changes. The plugin checks every minute.

| Plugin          | What appears                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------- |
| DNS             | **Create DNS record** for one of a resource's domains                                        |
| Uptime          | The status of the Uptime monitors whose URL is on a resource's domains                       |
| Log Search      | **Search logs across servers**, over Docker logs, with the resource's uuid as the query      |
| Security Center | The score and critical findings of a Linked host, on its Coolify card                        |
| Host Metrics    | A **Coolify on this server** card on a Linked host: its applications, services and databases |
| Databases       | Whether a Coolify database already has a saved login there, with **Open Databases**          |
| Backups         | Failed Termix backup jobs on a Linked host                                                   |

- **DNS records.** The name must be one of the resource's domains. Leave **Points to** empty to use the
  Only records made here can be removed from here, after you confirm. The DNS plugin needs a zone for the
  name, and your own DNS permissions apply.
  Only records made here can be removed from here.
- **Uptime.** Uptime can't create HTTP monitors for another plugin, so **Create monitor in Uptime** opens the
  Uptime tab. A resource's monitors can be paused and resumed with the `coolify.companion` action.
- **Log Search** searches every server's Docker logs and can't filter by host. The results say where they
  came from.
- **Databases** only shows names: logins and database names, never a password.

Who may use them:

- Reading (Uptime, Security Center, Host Metrics, Databases, Backups, listing DNS records) needs **View
  Coolify** and the connection (yours, or a grant).
- **Search logs** needs **Operate Coolify resources** and an operate grant, because it shows log output.
- Creating and removing DNS records needs **Configure Coolify** and a configure grant.
- Anything about a Linked host also needs your own access to that host in Termix.

They are also actions: `coolify.companion-read` (offered to the assistant and MCP) reads any of them, and
`coolify.companion` creates or removes DNS records and pauses or resumes Uptime monitors. The plugin never
sends a Coolify token or any other secret to another plugin.

## Permissions

Admins and users get all five by default. Admins can take any of them away per role.

- **View Coolify**: open the plugin and read the connections you own or were granted.
- **Operate Coolify resources**: lifecycle actions, deploys, tasks, backups, logs, and container shells and
  consoles.
- **Configure Coolify**: edits, variables, creates, imports, keys, sources, storage, DNS and notifications.
- **Administer Coolify**: deletes, server create, delete and transfer, cloud provisioning, instance settings
  and connection sharing.
- **Use the Coolify MCP endpoint**: each call still needs the permission of the action it runs.

## Coolify versions

The plugin is built against Coolify v4.7.5 and the `main` and `next` branches, and supports Coolify 4.4.0
and newer. [Coolify API coverage](coverage.md) lists every Coolify API operation and how the plugin uses it.
