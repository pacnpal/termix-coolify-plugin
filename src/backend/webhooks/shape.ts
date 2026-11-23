import type { ReadableSubject } from "../coolify/api.js";
import type { SourceEvent } from "../events/service.js";

/**
 * The strict shape of a Coolify webhook body (#91).
 *
 * Coolify's webhook channel (app/Notifications/Channels/WebhookChannel.php)
 * POSTs the array a notification's `toWebhook()` returns as JSON, with no
 * signature, from a queued job (app/Jobs/SendWebhookJob.php) that retries a
 * 429 or 5xx and counts a 401, 403, 404 or 410 against the channel. Every
 * body has `success`, `message` and `event`; the rest depends on `event`.
 *
 * The table below is each v4.7.5 notification's key set, read from its
 * source (tag v4.7.5, commit 378ce373; main c3d137e1 sends the same). A body
 * must name one of these events, hold only that event's keys, every
 * required one, each of its type. Anything else is refused whole. Keys
 * Coolify adds only sometimes (a preview's pull request, a task's resource)
 * are optional; nullable text is text or null, as PHP may send null.
 *
 * Image vulnerability digests have a toggle in v4.7.5's webhook settings,
 * but their payload isn't in this table, so they are refused until it is.
 */

/** A Coolify uuid: one plain segment, never a path (as the pipeline's). */
const UUID = /^[A-Za-z0-9_-]{1,128}$/;

/** `value` when it is a plain Coolify uuid the pipeline takes, else null. */
export function plainUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

type FieldType =
  /** true or false */
  | "bool"
  /** a string */
  | "string"
  /** a string or null */
  | "text"
  /** a plain uuid */
  | "uuid"
  /** a plain uuid or null */
  | "uuid?"
  /** a safe integer */
  | "int"
  /** a finite number */
  | "number"
  /** a safe integer or a string (an id Coolify takes from elsewhere) */
  | "id"
  /**
   * Any JSON value: only the nested lists of events this plugin never
   * reads (patch lists, Traefik servers, renewed certificates).
   */
  | "json";

function fits(type: FieldType, value: unknown): boolean {
  switch (type) {
    case "bool":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "text":
      return value === null || typeof value === "string";
    case "uuid":
      return typeof value === "string" && UUID.test(value);
    case "uuid?":
      return value === null || (typeof value === "string" && UUID.test(value));
    case "int":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "id":
      return Number.isSafeInteger(value) || typeof value === "string";
    case "json":
      return true;
  }
}

/** What the visibility check GETs with each connection's own token. */
export type Subject = ReadableSubject;

/** What to hand the pipeline, and the subject a connection must see first. */
export interface WebhookIngest {
  subject: Subject;
  event: SourceEvent;
}

export interface WebhookEvent {
  /** Coolify's event word, like deployment_failed. */
  event: string;
  /** Null for an event no event kind covers: accepted, nothing ingested. */
  ingest: WebhookIngest | null;
}

type Body = Record<string, unknown>;

interface EventShape {
  fields: Record<string, FieldType>;
  /** Required besides success, message and event. */
  required?: readonly string[];
  map?: (body: Body) => WebhookIngest | null;
}

const BASE: Record<string, FieldType> = {
  success: "bool",
  message: "string",
  event: "string",
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null =>
  Number.isSafeInteger(v) ? (v as number) : null;

/** Only the given fields that are present, so absent ones aren't stored as null. */
function present(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== null && v !== undefined),
  );
}

const DEPLOYMENT: Record<string, FieldType> = {
  application_name: "text",
  application_uuid: "uuid",
  deployment_uuid: "uuid",
  deployment_url: "text",
  project: "text",
  environment: "text",
  pull_request_id: "int",
  preview_fqdn: "text",
  fqdn: "text",
};

function deployment(kind: "deployment-finished" | "deployment-failed") {
  return (b: Body): WebhookIngest => ({
    subject: { type: "application", uuid: b.application_uuid as string },
    event: {
      kind,
      source: "webhook",
      resourceUuid: b.application_uuid as string,
      deploymentUuid: b.deployment_uuid as string,
      name: str(b.application_name),
      // Coolify's own deployment status words, as the poller reads them.
      status: kind === "deployment-failed" ? "failed" : "finished",
      fields: present({ pullRequestId: int(b.pull_request_id) }),
    },
  });
}

const RESOURCE_STATUS: Record<string, FieldType> = {
  application_name: "text",
  application_uuid: "uuid",
  resource_name: "text",
  resource_uuid: "uuid",
  url: "text",
  project: "text",
  environment: "text",
  fqdn: "text",
};

const BACKUP: Record<string, FieldType> = {
  database_name: "text",
  database_uuid: "uuid",
  database_type: "text",
  frequency: "text",
  url: "text",
};

function backup(
  kind: "backup-succeeded" | "backup-failed",
  extra: Record<string, unknown> = {},
) {
  return (b: Body): WebhookIngest => ({
    subject: { type: "database", uuid: b.database_uuid as string },
    event: {
      kind,
      source: "webhook",
      resourceUuid: b.database_uuid as string,
      name: str(b.database_name),
      // Coolify's backup execution status words.
      status: kind === "backup-failed" ? "failed" : "success",
      fields: extra,
    },
  });
}

const TASK: Record<string, FieldType> = {
  task_name: "text",
  task_uuid: "uuid",
  output: "text",
  application_uuid: "uuid",
  service_uuid: "uuid",
  url: "text",
};

function task(kind: "task-succeeded" | "task-failed", status: string) {
  return (b: Body): WebhookIngest | null => {
    // A task belongs to an application or a service; the task uuid itself
    // isn't a resource a token can be asked about.
    const subject: Subject | null =
      typeof b.application_uuid === "string"
        ? { type: "application", uuid: b.application_uuid }
        : typeof b.service_uuid === "string"
          ? { type: "service", uuid: b.service_uuid }
          : null;
    if (!subject) return null;
    return {
      subject,
      event: {
        kind,
        source: "webhook",
        resourceUuid: subject.uuid,
        name: str(b.task_name),
        status,
        fields: present({ consecutiveFailures: int(b.consecutive_failures) }),
      },
    };
  };
}

const SERVER: Record<string, FieldType> = {
  server_name: "text",
  server_uuid: "uuid",
  url: "text",
};

/** Every event Coolify v4.7.5 sends to a webhook, by its `event` word. */
export const COOLIFY_WEBHOOK_EVENTS: Record<string, EventShape> = {
  deployment_success: {
    fields: DEPLOYMENT,
    required: ["application_uuid", "deployment_uuid"],
    map: deployment("deployment-finished"),
  },
  deployment_failed: {
    fields: { ...DEPLOYMENT, blocked: "bool" },
    required: ["application_uuid", "deployment_uuid"],
    map: deployment("deployment-failed"),
  },
  // "Resource stopped": no event kind for it yet.
  status_changed: {
    fields: { ...RESOURCE_STATUS, status: "text" },
    required: ["application_uuid"],
  },
  restart_limit_reached: {
    fields: {
      ...RESOURCE_STATUS,
      restart_count: "int",
      max_restart_count: "int",
    },
    required: ["application_uuid"],
    // Coolify names the resource application_uuid whatever it is; it is
    // checked as an application, so another kind fails closed.
    map: (b) => ({
      subject: { type: "application", uuid: b.application_uuid as string },
      event: {
        kind: "restart-limit",
        source: "webhook",
        resourceUuid: b.application_uuid as string,
        name: str(b.resource_name) ?? str(b.application_name),
        fields: present({
          restartCount: int(b.restart_count),
          maxRestartCount: int(b.max_restart_count),
        }),
      },
    }),
  },
  // Names a container and a server, not a resource uuid the
  // container-restarted kind needs.
  container_restarted: {
    fields: { ...SERVER, container_name: "text" },
    required: ["server_uuid"],
  },
  backup_success: {
    fields: BACKUP,
    required: ["database_uuid"],
    map: backup("backup-succeeded"),
  },
  backup_failed: {
    fields: { ...BACKUP, error_output: "text" },
    required: ["database_uuid"],
    map: backup("backup-failed"),
  },
  backup_success_with_s3_warning: {
    fields: { ...BACKUP, s3_error: "text", s3_storage_url: "text" },
    required: ["database_uuid"],
    map: backup("backup-succeeded", { s3Failed: true }),
  },
  task_success: { fields: TASK, map: task("task-succeeded", "success") },
  task_failed: {
    fields: { ...TASK, consecutive_failures: "int" },
    map: task("task-failed", "failed"),
  },
  task_disabled: {
    fields: { ...TASK, consecutive_failures: "int" },
    map: task("task-failed", "disabled"),
  },
  docker_cleanup_success: {
    fields: { ...SERVER, cleanup_message: "text" },
    required: ["server_uuid"],
  },
  docker_cleanup_failed: {
    fields: { ...SERVER, error_message: "text" },
    required: ["server_uuid"],
  },
  server_force_disabled: { fields: SERVER, required: ["server_uuid"] },
  server_force_enabled: { fields: SERVER, required: ["server_uuid"] },
  hetzner_deletion_failed: {
    fields: { hetzner_server_id: "id", error: "text", url: "text" },
  },
  high_disk_usage: {
    fields: { ...SERVER, disk_usage: "number", threshold: "number" },
    required: ["server_uuid"],
    map: (b) => ({
      subject: { type: "server", uuid: b.server_uuid as string },
      event: {
        kind: "high-disk",
        source: "webhook",
        serverUuid: b.server_uuid as string,
        name: str(b.server_name),
        fields: present({ diskUsage: b.disk_usage, threshold: b.threshold }),
      },
    }),
  },
  server_reachable: { fields: SERVER, required: ["server_uuid"] },
  server_unreachable: {
    fields: SERVER,
    required: ["server_uuid"],
    map: (b) => ({
      subject: { type: "server", uuid: b.server_uuid as string },
      event: {
        kind: "server-unreachable",
        source: "webhook",
        serverUuid: b.server_uuid as string,
        name: str(b.server_name),
        status: "unreachable",
        fields: {},
      },
    }),
  },
  server_patch_check_error: {
    fields: {
      ...SERVER,
      os_id: "text",
      package_manager: "text",
      error: "text",
    },
    required: ["server_uuid"],
  },
  server_patch_check: {
    fields: {
      ...SERVER,
      total_updates: "int",
      os_id: "text",
      package_manager: "text",
      updates: "json",
      critical_packages_count: "int",
      security_updates: "json",
      reboot_required: "json",
    },
    required: ["server_uuid"],
  },
  traefik_version_outdated: {
    fields: { affected_servers_count: "int", servers: "json" },
  },
  ssl_certificate_renewal: {
    fields: { resources: "json", urls: "json", url: "text" },
  },
  // Coolify's Test button: proves the webhook works, ingests nothing.
  test: { fields: { url: "text" } },
  // Internal notices to the root team.
  general: { fields: { url: "text" } },
};

const own = (o: object, key: string) =>
  Object.prototype.hasOwnProperty.call(o, key);

/**
 * The webhook body, if it is exactly one of Coolify's events, with what to
 * ingest; null for anything else. Reads only the body's own keys.
 */
export function readWebhook(body: unknown): WebhookEvent | null {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    return null;
  }
  const b = body as Body;
  const event = own(b, "event") ? b.event : undefined;
  if (typeof event !== "string" || !own(COOLIFY_WEBHOOK_EVENTS, event)) {
    return null;
  }
  const shape = COOLIFY_WEBHOOK_EVENTS[event];
  const allowed = new Map(
    Object.entries({ ...shape.fields, ...BASE }) as [string, FieldType][],
  );
  for (const key of Object.keys(b)) {
    const type = allowed.get(key);
    if (!type || !fits(type, b[key])) return null;
  }
  for (const key of [...Object.keys(BASE), ...(shape.required ?? [])]) {
    if (!own(b, key)) return null;
  }
  return { event, ingest: shape.map ? shape.map(b) : null };
}
