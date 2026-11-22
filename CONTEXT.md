# Coolify for Termix

A Termix plugin that brings Coolify servers, applications, services and databases into Termix, so they can
be used from Termix's UI, API and MCP.

## Language

### Connections and access

**Connection**:
One Coolify instance reached with one Coolify API token, owned by the Termix user who added it.
_Avoid_: Instance, account, integration

**Grant**:
A Connection shared by its owner with another named Termix user, at a level (view, operate or configure).
_Avoid_: Share, delegation

**Server access**:
Permission to open SSH sessions on a Linked host, given separately from any Grant.
_Avoid_: Shell access, host share

### Servers and hosts

**Coolify server**:
A server as Coolify knows it, where Coolify runs Resources.
_Avoid_: Destination, node

**Linked host**:
The Termix host the plugin created for, or attached to, a Coolify server.
_Avoid_: Synced host, mirrored host, managed host

**Unlink**:
Ending the plugin's management of a Linked host, so it becomes an ordinary, editable Termix host.
_Avoid_: Detach, release

### What runs on servers

**Resource**:
An application, service or database that Coolify deploys.
_Avoid_: App (as the general word), workload

**Part**:
An application or database that belongs to a service.
_Avoid_: Service application, service database, sub-resource

### What happens

**Event**:
One thing that happened in Coolify (a deployment ended, a server became unreachable, a backup failed), kept
and sent once per dedupe key by the event pipeline: once per deployment, and otherwise once per kind,
subject and minute, so sightings in different minutes can be separate events.
_Avoid_: Alert (an alert is a notification about an event), notification

**Event log**:
A connection's stored events, its newest 1,000.
_Avoid_: History, audit log
