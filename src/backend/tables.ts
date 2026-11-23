import {
  boolean,
  defineTable,
  id,
  integer,
  json,
  refUser,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

// Stored as p_coolify_<name>. Columns follow the design's "Data model".
// connectionId columns hold p_coolify_connections.id; plugin tables can't
// carry foreign keys to each other, so the services clean up after a delete.

/** One Coolify instance reached with one API token, owned by one user. */
export const connections = defineTable(
  "connections",
  {
    id: id(),
    userId: refUser(),
    name: text().notNull(),
    baseUrl: text().notNull(),
    // Sealed with ctx.secrets.seal. Never returned, logged or stored plain.
    tokenSealed: text().notNull(),
    cfAccessIdSealed: text(),
    cfAccessSecretSealed: text(),
    allowPrivate: boolean().notNull().default(false),
    caCert: text(),
    // Normalized base URL plus "#" and the Coolify team id; null until known.
    instanceKey: varchar(255),
    pollEnabled: boolean().notNull().default(false),
    autoSync: boolean().notNull().default(false),
    execEnabled: boolean().notNull().default(false),
    alertKinds: json(),
    abilities: json(),
    coolifyVersion: text(),
    teamName: text(),
    lastError: text(),
    lastCheckedAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_p_coolify_connections_user_id", columns: ["userId"] },
      {
        name: "idx_p_coolify_connections_instance_key",
        columns: ["instanceKey"],
      },
    ],
  },
);

/** A connection shared by its owner with another named user. */
export const grants = defineTable(
  "grants",
  {
    id: id(),
    connectionId: integer().notNull(),
    userId: refUser(),
    // view, operate or configure
    level: varchar(16).notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    uniques: [
      {
        name: "idx_p_coolify_grants_connection_user",
        columns: ["connectionId", "userId"],
      },
    ],
  },
);

/** One webhook per Coolify team, shared by every connection with that instanceKey. */
export const webhooks = defineTable(
  "webhooks",
  {
    id: id(),
    instanceKey: varchar(255).notNull(),
    // sha256 of the webhook token; the token itself is never stored.
    tokenHash: varchar(64).notNull(),
    // Not refUser: the webhook outlives the user who set it up.
    createdByUserId: varchar(255).notNull(),
    lastReceivedAt: timestamp(),
  },
  {
    uniques: [
      {
        name: "idx_p_coolify_webhooks_instance_key",
        columns: ["instanceKey"],
      },
      { name: "idx_p_coolify_webhooks_token_hash", columns: ["tokenHash"] },
    ],
  },
);

/** A Coolify server seen through a connection, and its Linked host. */
export const servers = defineTable(
  "servers",
  {
    id: id(),
    connectionId: integer().notNull(),
    serverUuid: varchar(255).notNull(),
    // The Linked host, or null. A plain integer, not refHost: deleting the
    // host must not delete this row, or addressOverride and the credential
    // choice are lost. Task 9's host.deleted handler sets it to NULL (unlinks).
    hostId: integer(),
    addressOverride: text(),
    credentialMode: varchar(16),
    credentialId: integer(),
    keyFingerprint: text(),
    lastSyncedAt: timestamp(),
    // Whether sync wrote SSH Terminal's tunnel settings on the Linked host.
    // Cleared only by a write that turned the tunnel off while SSH Terminal
    // was running, so stale tunnel settings are never left behind.
    tunnelApplied: boolean().notNull().default(false),
  },
  {
    uniques: [
      {
        name: "idx_p_coolify_servers_connection_server",
        columns: ["connectionId", "serverUuid"],
      },
    ],
    indexes: [{ name: "idx_p_coolify_servers_host_id", columns: ["hostId"] }],
  },
);

/** Stripped DTOs from Coolify, never raw payloads. */
export const cache = defineTable(
  "cache",
  {
    connectionId: integer().notNull(),
    kind: varchar(255).notNull(),
    json: json().notNull(),
    fetchedAt: timestamp().notNull(),
  },
  {
    uniques: [
      {
        name: "idx_p_coolify_cache_connection_kind",
        columns: ["connectionId", "kind"],
      },
    ],
  },
);

/**
 * The event log: deployments, restarts and other things that happened, with
 * no secrets. Only the event pipeline (src/backend/events/service.ts) writes
 * it, already redacted; it keeps the newest EVENT_LOG_LIMIT per connection.
 */
export const events = defineTable(
  "events",
  {
    id: id(),
    connectionId: integer().notNull(),
    kind: varchar(64).notNull(),
    resourceUuid: varchar(255),
    deploymentUuid: varchar(255),
    // Plain integer, not refHost: history stays when the host goes.
    hostId: integer(),
    title: text().notNull(),
    detail: json(),
    createdAt: timestamp().notNull().defaultNow(),
    // The Coolify server the event is about (or its resource's server).
    serverUuid: varchar(255),
    // "deployment|<uuid>" or "<kind>|<subject>|<minute>": one row per event.
    dedupeKey: varchar(255),
  },
  {
    indexes: [
      {
        name: "idx_p_coolify_events_connection_created",
        columns: ["connectionId", "createdAt"],
      },
    ],
    uniques: [
      {
        name: "idx_p_coolify_events_connection_dedupe",
        columns: ["connectionId", "dedupeKey"],
      },
    ],
  },
);

/** One reverse onboarding run (design: "Partial onboarding"). */
export const onboardings = defineTable(
  "onboardings",
  {
    id: id(),
    userId: refUser(),
    connectionId: integer().notNull(),
    // Plain integer, not refHost: a watching row keeps its marker after the host goes.
    hostId: integer().notNull(),
    // generated or existing
    keyMode: varchar(16).notNull(),
    step: varchar(64).notNull(),
    // running, uncertain, failed, done or watching
    state: varchar(16).notNull(),
    sentAt: timestamp(),
    watchUntil: timestamp(),
    // Sealed; erased when the run completes or is cleaned up.
    generatedKeySealed: text(),
    authorizedKeyMarker: varchar(255),
    coolifyKeyUuid: varchar(255),
    serverUuid: varchar(255),
    lastError: text(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_p_coolify_onboardings_host_id", columns: ["hostId"] },
      {
        name: "idx_p_coolify_onboardings_connection_id",
        columns: ["connectionId"],
      },
    ],
  },
);

/** Public read-only status pages. */
export const statusPages = defineTable(
  "status_pages",
  {
    id: id(),
    connectionId: integer().notNull(),
    // sha256 of the page token; the token itself is never stored.
    tokenHash: varchar(64).notNull(),
    // JSON list of resource uuids
    resources: json().notNull(),
    title: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
    revokedAt: timestamp(),
  },
  {
    uniques: [
      { name: "idx_p_coolify_status_pages_token_hash", columns: ["tokenHash"] },
    ],
  },
);

/** DNS records the plugin made through the DNS plugin. */
export const dnsRecords = defineTable(
  "dns_records",
  {
    id: id(),
    connectionId: integer().notNull(),
    resourceUuid: varchar(255).notNull(),
    handle: json().notNull(),
    fqdn: varchar(255).notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      {
        name: "idx_p_coolify_dns_records_resource",
        columns: ["connectionId", "resourceUuid"],
      },
    ],
  },
);

/** Recently used resources per user, for palette ranking. */
export const recent = defineTable(
  "recent",
  {
    userId: refUser(),
    connectionId: integer().notNull(),
    resourceUuid: varchar(255).notNull(),
    usedAt: timestamp().notNull().defaultNow(),
  },
  {
    uniques: [
      {
        name: "idx_p_coolify_recent_user_resource",
        columns: ["userId", "connectionId", "resourceUuid"],
      },
    ],
  },
);

/**
 * One person's alert kinds for one connection they own or were granted
 * (#93). No row: the default kinds. Only that person reads or writes it.
 */
export const alertPrefs = defineTable(
  "alert_prefs",
  {
    id: id(),
    connectionId: integer().notNull(),
    userId: refUser(),
    // The event kinds this person gets alerts for, as a JSON list.
    kinds: json().notNull(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  {
    uniques: [
      {
        name: "idx_p_coolify_alert_prefs_connection_user",
        columns: ["connectionId", "userId"],
      },
    ],
  },
);

// termix-plugin migrations reads this list.
export const tables = [
  connections,
  grants,
  webhooks,
  servers,
  cache,
  events,
  onboardings,
  statusPages,
  dnsRecords,
  recent,
  alertPrefs,
];
