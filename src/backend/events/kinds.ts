/**
 * Every kind of plugin event. Each is declared in manifest.json as the
 * operations event `coolify.<kind>`, with scope "server": hostId comes only
 * when the subject's server is Linked, so no event may need one.
 *
 * `subject` says what the event is about, and so what a source must name:
 * a resource (`resourceUuid`), a server (`serverUuid`), either, or nothing
 * (team-wide). `title` is the event log's plain-language line.
 */
export const EVENT_KINDS = {
  "deployment-finished": {
    subject: "resource",
    severity: "info",
    title: "Deployment finished",
  },
  "deployment-failed": {
    subject: "resource",
    severity: "warning",
    title: "Deployment failed",
  },
  "container-restarted": {
    subject: "resource",
    severity: "warning",
    title: "Container restarted",
  },
  "restart-limit": {
    subject: "resource",
    severity: "critical",
    title: "Restart limit reached",
  },
  "server-unreachable": {
    subject: "server",
    severity: "critical",
    title: "Server unreachable",
  },
  "backup-succeeded": {
    subject: "resource",
    severity: "info",
    title: "Backup succeeded",
  },
  "backup-failed": {
    subject: "resource",
    severity: "warning",
    title: "Backup failed",
  },
  "task-succeeded": {
    subject: "resource",
    severity: "info",
    title: "Scheduled task succeeded",
  },
  "task-failed": {
    subject: "resource",
    severity: "warning",
    title: "Scheduled task failed",
  },
  "high-disk": {
    subject: "server",
    severity: "warning",
    title: "High disk usage",
  },
  "certificate-problem": {
    subject: "any",
    severity: "warning",
    title: "Certificate problem",
  },
  "token-expiring": {
    subject: "team",
    severity: "warning",
    title: "API token expiring",
  },
} as const satisfies Record<
  string,
  {
    subject: "resource" | "server" | "any" | "team";
    severity: "info" | "warning" | "critical";
    title: string;
  }
>;

export type EventKind = keyof typeof EVENT_KINDS;
export type EventSubject = (typeof EVENT_KINDS)[EventKind]["subject"];

/** The keys each kind's emitted payload holds, as manifest.json declares them. */
export const PAYLOAD_KEYS = {
  resource: ["connectionId", "uuid", "name", "deploymentUuid", "status"],
  server: ["connectionId", "serverUuid", "name", "status"],
  any: ["connectionId", "uuid", "serverUuid", "name", "status"],
  team: ["connectionId", "name", "status"],
} as const satisfies Record<EventSubject, readonly string[]>;
export type EventSeverity = (typeof EVENT_KINDS)[EventKind]["severity"];

/** Where an event came from: the poller (#90) or the team webhook (#91). */
export type EventSource = "poll" | "webhook";

export const EVENT_SOURCES: readonly EventSource[] = ["poll", "webhook"];

export function isEventKind(value: unknown): value is EventKind {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(EVENT_KINDS, value)
  );
}

/** The operations event id a kind is emitted as. */
export function eventId(kind: EventKind): string {
  return `coolify.${kind}`;
}
