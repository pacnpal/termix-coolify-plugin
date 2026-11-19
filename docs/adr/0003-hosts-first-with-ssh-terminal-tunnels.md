# Coolify servers become locked Termix hosts, with tunnels carried by SSH Terminal

The plugin mirrors each Coolify server as a Termix host and builds everything else on those hosts. That
includes Operations resources, the terminal, files and the Docker plugin. Servers behind Cloudflare tunnels
get the SSH Terminal plugin's own tunnel host settings (`cloudflareTunnel*`, port 443), written through
`ctx.hosts.create`. The plugin does not ship its own `ssh:transport` or run `cloudflared`. Mirrored hosts are
locked while managed, and Unlink makes them ordinary hosts.

## Considered Options

- **A standalone console with no Termix hosts.** It would lose tunnel reuse, files, the Docker plugin and
  Operations resources, which need a host.
- **The plugin's own tunnel transport.** It would duplicate SSH Terminal and need two high-risk
  capabilities (`ssh:transport`, `network:sockets`).

## Consequences

- Tunnelled servers need the SSH Terminal plugin to be running.
- The plugin depends on SSH Terminal's setting names. They live in one constant and are covered by a test.
