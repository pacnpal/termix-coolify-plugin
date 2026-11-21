---
title: Cloudflare tunnels
order: 20
---

# Cloudflare tunnels

Cloudflare comes up in two places: the Coolify dashboard itself behind Cloudflare Access, and servers that
Coolify reaches through a Cloudflare tunnel.

## Coolify behind Cloudflare Access

When the Coolify address sits behind Cloudflare Access, the check says **Coolify is behind Cloudflare
Access**. Create a service token in Cloudflare Zero Trust, allow it in the Access application's policy, and
enter its client ID and secret under **Advanced** on the connection. Both are stored encrypted, sent only to
the Coolify address, and never shown again or kept in run history.

## Servers behind a tunnel

When Coolify reaches a server through a Cloudflare tunnel, its Linked host uses the **SSH Terminal**
plugin's own Cloudflare tunnel, which then carries every SSH connection to that host: the terminal, files,
Docker and this plugin. Sync sets:

- the host address to the tunnel hostname (Coolify's address for the server), with Coolify's port and user;
- SSH Terminal's tunnel settings on the host: tunnel on, the tunnel hostname, and port 443;
- the connection's Cloudflare Access service token, when one is set, as SSH Terminal's service token ID and
  secret. The token is written only into those host settings. It never appears in the preview, sync
  results, run history, logs or the audit log.

Each sync writes these settings in full, so nothing stale stays behind: when you remove the connection's
Access token, the next sync clears it from tunnelled hosts. When a server is no longer behind a tunnel, the
next sync turns SSH Terminal's tunnel off on its host and clears the tunnel hostname and token. Termix only
takes SSH Terminal's settings while it is on, so until then that server says **This server is no longer
behind a Cloudflare tunnel, but its host still has SSH Terminal's tunnel settings**, with **Open Plugins**,
and its host is left as it is. Hosts that were never tunnelled don't need SSH Terminal.

Hosts linked before 1.0's database migration have no record of whether sync gave them tunnel settings, so
they count as possibly tunnelled: once their server is a plain one, they may need SSH Terminal on for one
sync to confirm their tunnel is off. After that they sync without it.

This needs **SSH Terminal 1.2.0 or newer**, turned on. Version 1.0.3 tunnelled only its own terminal tab.
Until then a tunnelled server can't sync and says why, with an **Open Plugins** button that opens Termix's
Plugins tab:

- **Turn on the SSH Terminal plugin to reach servers behind Cloudflare tunnels**: SSH Terminal isn't
  installed or is turned off. It is also shown when the plugin list can't be read, so a tunnelled host is
  never made without a tunnel.
- **Update SSH Terminal to 1.2.0 or newer; older versions tunnel only the terminal.**

When you add a connection and Coolify has tunnelled servers, the setup checklist shows the same check once.

A tunnelled Linked host's Coolify card says **Tunnel: through SSH Terminal (Cloudflare)** and has **Open
tunnel settings**, which opens the host editor. SSH Terminal's tunnel fields there stay read only while the
host is linked; unlink it to change them by hand.
