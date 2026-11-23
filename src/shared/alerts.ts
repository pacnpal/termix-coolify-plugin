// Alert kinds and links, shared by the backend (alerts) and the frontend
// (the preferences view and the Coolify tab that a link opens).
import type { EventKind } from "../backend/events/kinds.js";

/**
 * The kinds a person gets alerts for until they pick their own (design:
 * "Alerts and live events", Event output): deploy failed, restart limit,
 * server unreachable, backup failed, task failed, high disk, certificate
 * problems and API token expiring.
 */
export const DEFAULT_ALERT_KINDS: readonly EventKind[] = [
  "deployment-failed",
  "restart-limit",
  "server-unreachable",
  "backup-failed",
  "task-failed",
  "high-disk",
  "certificate-problem",
  "token-expiring",
];

/** The subject an alert is about, as the stored event names it. */
export interface AlertSubject {
  connectionId: number;
  resourceUuid: string | null;
  serverUuid: string | null;
}

/**
 * The Coolify tab data that opens an alert's subject (CoolifyTab reads it
 * in `requestOf`): a resource's detail, a server's resources, or the
 * connection's overview for a team-wide event.
 */
export function alertTabData(subject: AlertSubject): Record<string, unknown> {
  const { connectionId, resourceUuid, serverUuid } = subject;
  if (resourceUuid) {
    return { section: "resources", connectionId, uuid: resourceUuid };
  }
  if (serverUuid) {
    return { section: "resources", connectionId, serverUuid };
  }
  return { section: "overview", connectionId };
}
