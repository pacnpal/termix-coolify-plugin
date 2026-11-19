Coolify for Termix brings your Coolify servers, applications, services and databases into Termix.

So far you can connect Coolify instances and see what each API token can do. Servers, resources, shells and
the rest come with the rest of release 1.0.0.

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
