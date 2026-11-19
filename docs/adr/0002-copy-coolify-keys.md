# Coolify's SSH keys are copied into Termix credentials by default

To make every Coolify server connect from Termix with no setup, the plugin reads each server's private key
through the Coolify API (with `read:sensitive`) and stores it as a Termix SSH key credential. The owner chose
this ("A with fallback") over asking for a Termix credential per server. It means a copy of the key that
controls those servers lives in Termix as well.

## Considered Options

- Copy keys by default, falling back to a picked credential when the token can't read keys. **Chosen.**
- Always pick an existing Termix credential per server. Needs a weaker token, but means manual setup for each
  server.

## Consequences

- Admins can force the fallback for everyone with the `allowKeyCopy` setting.
- Keys are only ever in memory while being copied. They are never in plugin tables or logs, and every copy is
  audited.
