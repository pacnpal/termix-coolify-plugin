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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const at = (minute: number) => ({
  created_at: `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000000Z`,
});

/**
 * Coolify's answers for the connection-wide queue: GET /deployments (the
 * running ones, with one of an application this connection doesn't have and
 * one that names no application) and the history pages of web and api, on
 * top of deploymentAnswers().
 */
export function queueAnswers(): Record<string, FakeAnswer> {
  return {
    ...deploymentAnswers(),
    "GET /deployments": {
      json: [
        deploymentRaw("dep-run", "in_progress", { extra: at(30) }),
        deploymentRaw("dep-api-queued", "queued", {
          appUuid: "app-api-uuid",
          entries: null,
          extra: at(31),
        }),
        deploymentRaw("dep-elsewhere", "in_progress", {
          appUuid: "app-not-mine-uuid",
          entries: [logEntry(1, "a foreign build line")],
          extra: at(32),
        }),
        {
          ...deploymentRaw("dep-nolink", "in_progress", { extra: at(33) }),
          deployment_url: null,
        },
      ],
    },
    "GET /deployments/applications/app-web-uuid": {
      json: {
        count: 3,
        deployments: [
          deploymentRaw("dep-run", "in_progress", { extra: at(30) }),
          deploymentRaw("dep-done", "finished", { extra: at(20) }),
          deploymentRaw("dep-failed", "failed", { extra: at(10) }),
        ],
      },
    },
    "GET /deployments/applications/app-api-uuid": {
      json: {
        count: 2,
        deployments: [
          deploymentRaw("dep-api-old", "finished", {
            appUuid: "app-api-uuid",
            extra: at(25),
          }),
          // A row whose link names an application this connection lacks.
          deploymentRaw("dep-api-foreign", "finished", {
            appUuid: "app-not-mine-uuid",
            extra: at(26),
          }),
        ],
      },
    },
  };
}

/**
 * Coolify's answers for deploy by tag "prod": web and a foreign application
 * from GET /applications?tag=prod, the n8n service through its tags, and
 * POST /deploy's answer for web and n8n. Without a tag, GET /applications
 * answers `all` (the resource fixtures).
 */
export function tagAnswers(all: unknown): Record<string, FakeAnswer> {
  return {
    "GET /applications": (url: string) => {
      const tag = new URL(url).searchParams.get("tag");
      if (tag === null) return json(all);
      if (tag !== "prod") return json([]);
      const rows = (all as { uuid: string }[]).filter(
        (r) => r.uuid === "app-web-uuid",
      );
      return json([
        ...rows,
        { uuid: "app-not-mine-uuid", name: "foreign", status: "running" },
      ]);
    },
    "GET /services/svc-n8n-uuid/tags": {
      json: [{ uuid: "tag-prod-uuid", name: "prod" }],
    },
    "POST /deploy": {
      json: {
        deployments: [
          {
            message: "Application web deployment queued.",
            resource_uuid: "app-web-uuid",
            deployment_uuid: "dep-tag-web",
          },
          { message: "Service n8n started.", resource_uuid: "svc-n8n-uuid" },
        ],
      },
    },
  };
}
