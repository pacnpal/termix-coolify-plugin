import { expect, vi } from "vitest";
import type { fakeCoolify, FakeAnswer } from "./fake-coolify.js";
import { grant } from "./lifecycle.js";
import { OTHER, type PluginHarness } from "./plugin.js";

/**
 * ctx.operations.run as core answers it across the plugin process boundary:
 * a handler's refusal comes back as a plain Error, its class and code lost.
 */
export function coreLikeRun(harness: PluginHarness) {
  const ops = harness.mock.ctx.operations;
  const run = ops.run.bind(ops);
  vi.spyOn(ops, "run").mockImplementation(async (id, options) => {
    try {
      return await run(id, options);
    } catch (err) {
      throw new Error((err as Error).message);
    }
  });
}

/** Callers a route that hands its work to an action must refuse itself. */
export const REFUSED_CALLERS = [
  ["another user", null, 404],
  ["a view grant", "view", 403],
] as const;

/**
 * POSTs `path` as OTHER (with a grant at `level`, if any) through a
 * core-like run, and expects `status` with no request to Coolify.
 */
export async function expectRefusedBeforeCoolify(
  started: {
    harness: PluginHarness;
    fake: ReturnType<typeof fakeCoolify>;
    id: number;
  },
  level: "view" | null,
  status: number,
  path: string,
  body?: unknown,
): Promise<void> {
  const { harness, fake, id } = started;
  if (level) grant(harness, id, OTHER, level);
  coreLikeRun(harness);
  const before = fake.calls.length;
  const answer = await harness.request("POST", path, body, OTHER);
  expect(answer.status).toBe(status);
  expect(fake.calls.slice(before)).toEqual([]);
}

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

/**
 * keyEntries cut inside the key, as a log read from its tail would be: the
 * body and END with no BEGIN before them.
 */
export function keyTailEntries(from: number) {
  return keyEntries(from - 1).slice(1);
}

/** web's rollback images as Coolify lists them: the current one and two older. */
export function rollbackImagesRaw() {
  return {
    current: "abc1234",
    images: [
      {
        tag: "abc1234",
        created_at: "2026-11-19T10:00:00.000000Z",
        is_current: true,
        source: "local",
      },
      {
        tag: "0ld3r00",
        created_at: "2026-11-18T09:00:00.000000Z",
        is_current: false,
        source: "local",
      },
      {
        tag: "0ld3st0",
        created_at: "2026-11-17T08:00:00.000000Z",
        is_current: false,
        source: "registry",
      },
    ],
  };
}

/** Coolify's answers for web's rollback images and a rollback to one of them. */
export function rollbackAnswers(): Record<string, FakeAnswer> {
  return {
    "GET /applications/app-web-uuid/rollback-images": {
      json: rollbackImagesRaw(),
    },
    "POST /applications/app-web-uuid/rollback": {
      json: {
        message: "Rollback deployment queued.",
        deployment_uuid: "dep-rollback",
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
