import type { FakeAnswer } from "./fake-coolify.js";

/** Where Coolify's UI shows a deployment: it names the application's uuid. */
export function deploymentUrl(appUuid: string, deploymentUuid: string): string {
  return `/project/proj-uuid/environment/env-uuid/application/${appUuid}/deployment/${deploymentUuid}`;
}

/** One build log entry as Coolify stores it in a deployment's `logs`. */
export function logEntry(
  order: number,
  output: string,
  extra: Record<string, unknown> = {},
) {
  return {
    command: null,
    output,
    type: "stdout",
    timestamp: `2026-11-19T10:00:${String(order).padStart(2, "0")}.000000Z`,
    hidden: false,
    batch: 1,
    order,
    ...extra,
  };
}

/** A deployment of `appUuid` as GET /deployments/{uuid} answers it. */
export function deploymentRaw(
  uuid: string,
  status: string,
  opts: {
    appUuid?: string;
    entries?: ReturnType<typeof logEntry>[] | null;
    extra?: Record<string, unknown>;
  } = {},
) {
  const appUuid = opts.appUuid ?? "app-web-uuid";
  const entries =
    opts.entries === undefined ? [logEntry(1, "Starting")] : opts.entries;
  return {
    id: 61,
    deployment_uuid: uuid,
    application_id: "11",
    application_name: "web",
    status,
    commit: "abc1234",
    commit_message: "Fix the header",
    pull_request_id: 0,
    rollback: false,
    server_name: "vps1",
    deployment_url: deploymentUrl(appUuid, uuid),
    created_at: "2026-11-19T10:00:00.000000Z",
    updated_at: "2026-11-19T10:01:00.000000Z",
    finished_at: status === "finished" ? "2026-11-19T10:02:00.000000Z" : null,
    // Without read:sensitive Coolify leaves logs out.
    ...(entries === null ? {} : { logs: JSON.stringify(entries) }),
    ...opts.extra,
  };
}

/** Coolify's answers for web's deployments: a page of three, and each one. */
export function deploymentAnswers(): Record<string, FakeAnswer> {
  const running = deploymentRaw("dep-run", "in_progress", {
    entries: [
      logEntry(1, "Starting deployment"),
      logEntry(2, "docker build --secret id=env", {
        hidden: true,
        command: "docker build",
      }),
      logEntry(3, "DB_PASSWORD=fake-build-pass"),
      logEntry(4, "Building image"),
    ],
  });
  const done = deploymentRaw("dep-done", "finished");
  const failed = deploymentRaw("dep-failed", "failed");
  return {
    "GET /deployments/applications/app-web-uuid": {
      json: { count: 23, deployments: [running, done, failed] },
    },
    "GET /deployments/dep-run": { json: running },
    "GET /deployments/dep-done": { json: done },
    "GET /deployments/dep-failed": { json: failed },
    // A deployment of an application this connection can't see.
    "GET /deployments/dep-elsewhere": {
      json: deploymentRaw("dep-elsewhere", "in_progress", {
        appUuid: "app-not-mine-uuid",
      }),
    },
    "POST /deployments/dep-run/cancel": {
      json: {
        message: "Deployment cancelled successfully.",
        deployment_uuid: "dep-run",
        status: "cancelled-by-user",
      },
    },
  };
}

/** A fake private key's body: it must never leave the plugin. */
export const KEY_BODY = "FAKEKEYBODY-not-a-real-key";

/**
 * A private key printed across several build log entries, as a build that
 * cats a key file does: BEGIN, body and END each in an entry of its own.
 */
export function keyEntries(from: number) {
  return [
    logEntry(from, "-----BEGIN OPENSSH PRIVATE KEY-----"),
    logEntry(from + 1, `${KEY_BODY}-line-1`),
    logEntry(from + 2, `${KEY_BODY}-line-2`, { hidden: true }),
    logEntry(from + 3, "-----END OPENSSH PRIVATE KEY-----"),
    logEntry(from + 4, "after the key"),
  ];
}
