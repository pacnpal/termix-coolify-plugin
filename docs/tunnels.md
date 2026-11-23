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

## The server Coolify runs on

Coolify reaches the server it runs on directly (as `host.docker.internal`), so it never tunnels it and its
dashboard has no tunnel setting for it. Don't turn on Coolify's own tunnel setting for that server: Coolify
would then try to reach itself through Cloudflare. Instead, publish the server's SSH on a tunnel yourself
and tell Termix to use it. Coolify keeps reaching its host directly; only the Termix host goes through
Cloudflare. That lets you close the server's SSH port to the internet.

You need Coolify for Termix 1.0.2 or newer and SSH Terminal 1.2.0 or newer. The examples use
`ssh-coolify.example.com`; use a name in one of your own Cloudflare zones.

### 1. Create a tunnel on the server

1. In Cloudflare, open **Networking → Tunnels** and choose **Create Tunnel**, type **Cloudflared**.
2. Pick the server's system and run the install command Cloudflare shows on the server, as root. It
   installs `cloudflared` as a system service (`cloudflared service install <token>`). Copy it straight from
   the dashboard; the token in it lets anyone run your tunnel, so keep it out of chat and notes.
3. The tunnel's **Overview** should say **Healthy**, with one replica named after the server.

### 2. Publish SSH on it

1. On the tunnel's **Routes** tab, choose **Add route → Published application**.
2. Enter the subdomain and domain (`ssh-coolify` on `example.com`) and set **Service URL** to
   `ssh://127.0.0.1:22`, with the port sshd listens on (the port Coolify shows for the server).
3. Choose **Add route**. Cloudflare creates the DNS record pointing the name at the tunnel.

Cloudflare Access is optional. Without an Access application on the name, anyone who knows it can reach the
server's sshd through Cloudflare, so turn off password logins (step 5). With one, allow a service token in
its policy and enter that token under **Advanced** on the Termix connection, as in
[Coolify behind Cloudflare Access](#coolify-behind-cloudflare-access); sync gives it to every tunnelled host.

To try it from your own computer before going further, with `cloudflared` installed there:

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" root@ssh-coolify.example.com
```

### 3. Point the Termix host at it

1. In the Coolify tab, open **Servers**.
2. On the row of the server Coolify runs on, tick **Reach through a Cloudflare tunnel**. The address field
   becomes **Tunnel hostname**; enter `ssh-coolify.example.com`.
3. Choose **Create and update hosts**, then open a terminal on the host. Sync writes SSH Terminal's tunnel
   settings, as for [servers behind a tunnel](#servers-behind-a-tunnel), and the key copied from Coolify
   still logs in.

Untick the box and sync again to go back to a direct address; sync then clears the tunnel from the host.

### 4. Close SSH to the internet

Do this only once the Termix host connects through the tunnel, and keep your provider's web console open in
case you lock yourself out. Run these on the server as root.

First check what is there:

```bash
ufw status verbose
```

```bash
ss -tlnp | grep -v '127.0.0.1\|::1'
```

If ufw already allows SSH (`22/tcp` or `OpenSSH`), delete that rule first, or it matches before the block
below. If anything that isn't Docker listens on the host besides sshd, allow it before turning ufw on.

Coolify reaches its own host over the Docker bridge (from an address like `10.0.1.7`), and `cloudflared`
connects from `127.0.0.1`, which ufw always allows. Allow the private ranges Docker uses, then block the
port for everyone else and turn ufw on:

```bash
ufw allow from 10.0.0.0/8 to any port 22 proto tcp
```

```bash
ufw allow from 172.16.0.0/12 to any port 22 proto tcp
```

```bash
ufw allow from 192.168.0.0/16 to any port 22 proto tcp
```

```bash
ufw deny 22/tcp
```

```bash
ufw default deny incoming
```

```bash
ufw enable
```

An SSH session that is already open stays up; new ones from the internet are refused. Ports Docker publishes
(Traefik's 80 and 443, Coolify's 8000, 6001 and 6002, Traefik's 8080) are routed around ufw, so ufw neither
breaks nor closes them. To close the ones you don't need from outside (with a domain set for Coolify, only
80 and 443 are), use your provider's network firewall.

### 5. Turn off password logins

Coolify and Termix both log in with keys. Ubuntu cloud images turn passwords on in
`/etc/ssh/sshd_config.d/50-cloud-init.conf`, and sshd keeps the first value it reads, so put the change in a
file that sorts first:

```bash
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
```

```bash
sshd -t && systemctl reload ssh
```

```bash
sshd -T | grep -Ei 'passwordauthentication|kbdinteractive|permitrootlogin'
```

The last command should print `passwordauthentication no`, `kbdinteractiveauthentication no` and
`permitrootlogin without-password`.

### 6. Check it

- In Coolify, open the server and run **Validate**: Coolify still reaches its own host.
- In Termix, open a terminal on the host. On the server, `journalctl -u ssh` shows the login coming from
  `127.0.0.1`: that is `cloudflared`, so it came through the tunnel.
- From outside, `nc -vz <the server's public IP> 22` times out, and the password guesses bots send to every
  public SSH port stop showing up in the log.

With ufw on, the log also shows `[UFW BLOCK]` lines from Cloudflare addresses on port 443 to high ports on
the server, with `ACK PSH`. Those are late replies to outbound HTTPS connections that already closed, not
attempts to get in; `ufw logging off` hides them.
