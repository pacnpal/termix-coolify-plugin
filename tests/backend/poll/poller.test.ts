import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeAnswer } from "../helpers/fake-coolify.js";
import { grant, link, startLifecycle } from "../helpers/lifecycle.js";
import { OTHER, OWNER, type PluginHarness } from "../helpers/plugin.js";
import {
  POLL_AWAKE_REASON,
  POLL_BACKOFF_MS,
  POLL_ID,
  SLOW_POLL_MS,
} from "../../../src/backend/poll/service.js";
import { HEAVY_TEST_MS } from "../../shared/timing.js";

const T0 = Date.parse("2026-11-23T10:00:00.000Z");
const MINUTE = 60_000;

const at = (ms: number) => new Date(ms).toISOString();

/** Coolify's queue with these deployments of app-web-uuid running. */
function running(...rows: [uuid: string, status: string][]): FakeAnswer {
  return {
    json: rows.map(([uuid, status]) => ({
      deployment_uuid: uuid,
      application_uuid: "app-web-uuid",
      status,
      created_at: at(T0 - MINUTE),
    })),
  };
}

/** app-web-uuid's deployment history, newest first. */
function history(
  ...rows: [uuid: string, status: string, finishedAt: number][]
): FakeAnswer {
  return {
    json: {
      count: rows.length,
      deployments: rows.map(([uuid, status, finished]) => ({
        deployment_uuid: uuid,
        application_uuid: "app-web-uuid",
        status,
        logs: "a build log that never leaves Coolify",
        created_at: at(finished - MINUTE),
        finished_at: at(finished),
      })),
    },
  };
}

const HISTORY = "GET /deployments/applications/app-web-uuid";

/** The one application the poll tests watch, with its status. */
function web(status: string): FakeAnswer {
  return {
    json: [
      {
        id: 11,
        uuid: "app-web-uuid",
        name: "web",
        status,
        last_deployment_at: at(T0 - MINUTE),
        destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
      },
    ],
  };
}

function servers(edgeReachable: boolean): FakeAnswer {
  return {
    json: [
      {
        uuid: "srv-vps1-uuid",
        name: "vps1",
        ip: "203.0.113.10",
        settings: { is_reachable: true, is_usable: true },
      },
      {
        uuid: "srv-edge-uuid",
        name: "edge",
        ip: "203.0.113.20",
        settings: { is_reachable: edgeReachable, is_usable: edgeReachable },
      },
    ],
  };
}

/** A Coolify with one application, one database and no deployments yet. */
function pollAnswers(): Record<string, FakeAnswer> {
  return {
    "GET /applications": web("running:healthy"),
    "GET /services": { json: [] },
    "GET /databases": {
      json: [
        {
          id: 21,
          uuid: "db-main-uuid",
          name: "main-db",
          status: "running:healthy",
          destination: { server: { uuid: "srv-vps1-uuid", name: "vps1" } },
        },
      ],
    },
    "GET /deployments": running(),
    [HISTORY]: history(),
    "GET /servers": servers(true),
  };
}

async function start(
  overrides: Record<string, FakeAnswer> = {},
  options: Parameters<typeof startLifecycle>[0] = {},
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const started = await startLifecycle({
    ...options,
    overrides: { ...pollAnswers(), ...overrides, ...options.overrides },
  });
  harnesses.push(started.harness);
  return started;
}

const harnesses: PluginHarness[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.close();
});

/** Runs the scheduled jobs once at `ms`, with no actor, as core does. */
async function pollAt(harness: PluginHarness, ms: number) {
  vi.setSystemTime(ms);
  harness.mock.setActor(undefined);
  try {
    await harness.mock.runScheduled();
  } finally {
    harness.mock.setActor(OWNER);
  }
}

function eventRows(harness: PluginHarness, id: number) {
  return harness.db.sqlite
    .prepare(
      "SELECT kind, deployment_uuid, resource_uuid, server_uuid, dedupe_key FROM p_coolify_events WHERE connection_id = ? ORDER BY id",
    )
    .all(id) as {
    kind: string;
    deployment_uuid: string | null;
    resource_uuid: string | null;
    server_uuid: string | null;
    dedupe_key: string;
  }[];
}

const kinds = (harness: PluginHarness) =>
  harness.mock.operationEvents.map((e) => e.eventId);

async function connection(harness: PluginHarness, id: number) {
  const answer = await harness.request("GET", `/connections/${id}`);
  expect(answer.status).toBe(200);
  return answer.body as { pollEnabled: boolean; pollError: string | null };
}

describe("the coolify-poll schedule", () => {
  it("is declared in sandbox.schedules and registered with jitter at 60 s or more", async () => {
    const { harness } = await start();
    const declared = (harness.mock.ctx.manifest.sandbox?.schedules ?? []).map(
      (s: string | { id: string; every?: number }) =>
        typeof s === "string" ? { id: s } : s,
    );
    const entry = declared.find((s) => s.id === POLL_ID) as
      { id: string; every?: number } | undefined;
    expect(entry).toBeTruthy();
    expect(entry!.every).toBeGreaterThanOrEqual(60_000);
    // Two jobs a minute apart: the status page refresh and the poll.
    expect(
      harness.mock.scheduled.filter((j) => j.kind === "every" && !j.stopped)
        .length,
    ).toBe(2);
    expect(POLL_BACKOFF_MS).toEqual([1, 2, 5, 15].map((m) => m * MINUTE));
  });
});

describe("diffing polls", () => {
  it("the first poll records a baseline and emits nothing for what already exists", async () => {
    const { harness, id } = await start({
      "GET /applications": web("running:unhealthy"),
      "GET /deployments": running(["dep-live", "in_progress"]),
      [HISTORY]: history(["dep-old", "failed", T0 - 2 * MINUTE]),
      "GET /servers": servers(false),
    });
    await pollAt(harness, T0);
    expect(harness.mock.operationEvents).toEqual([]);
    expect(eventRows(harness, id)).toEqual([]);
  });

  it("a deployment changing status emits once, and a repeat poll emits nothing", async () => {
    const { harness, fake, id } = await start({
      "GET /deployments": running(["dep-1", "in_progress"]),
    });
    link(harness, id, "srv-vps1-uuid", 7);
    await pollAt(harness, T0);
    expect(harness.mock.operationEvents).toEqual([]);

    fake.set("GET /deployments", running());
    fake.set(HISTORY, history(["dep-1", "finished", T0 + 30_000]));
    await pollAt(harness, T0 + MINUTE);
    expect(harness.mock.operationEvents).toEqual([
      {
        eventId: "coolify.deployment-finished",
        hostId: 7,
        payload: expect.objectContaining({
          connectionId: id,
          uuid: "app-web-uuid",
          name: "web",
          deploymentUuid: "dep-1",
          status: "finished",
        }),
      },
    ]);
    expect(eventRows(harness, id)).toEqual([
      expect.objectContaining({
        kind: "deployment-finished",
        deployment_uuid: "dep-1",
      }),
    ]);

    await pollAt(harness, T0 + 2 * MINUTE);
    await pollAt(harness, T0 + 3 * MINUTE);
    expect(harness.mock.operationEvents).toHaveLength(1);
    expect(eventRows(harness, id)).toHaveLength(1);
    expect(JSON.stringify(eventRows(harness, id))).not.toContain("build log");
  });

  it("a deployment that started and failed between two polls is one event; older history is not", async () => {
    const { harness, fake } = await start();
    await pollAt(harness, T0);
    // dep-new ended after the last poll; dep-ancient long before it.
    fake.set(
      HISTORY,
      history(
        ["dep-new", "failed", T0 + 20_000],
        ["dep-ancient", "failed", T0 - 60 * MINUTE],
      ),
    );
    await pollAt(harness, T0 + MINUTE);
    expect(harness.mock.operationEvents).toEqual([
      expect.objectContaining({
        eventId: "coolify.deployment-failed",
        payload: expect.objectContaining({
          deploymentUuid: "dep-new",
          status: "failed",
        }),
      }),
    ]);
  });

  it("a status change and an unreachable server each emit once", async () => {
    const { harness, fake, id } = await start();
    await pollAt(harness, T0);
    fake.set("GET /applications", web("exited:unhealthy"));
    fake.set("GET /servers", servers(false));
    await pollAt(harness, T0 + MINUTE);
    expect(kinds(harness).sort()).toEqual([
      "coolify.server-unreachable",
      "coolify.status-changed",
    ]);
    expect(
      harness.mock.operationEvents.find(
        (e) => e.eventId === "coolify.status-changed",
      )?.payload,
    ).toMatchObject({
      connectionId: id,
      uuid: "app-web-uuid",
      name: "web",
      status: "exited:unhealthy",
    });
    expect(
      harness.mock.operationEvents.find(
        (e) => e.eventId === "coolify.server-unreachable",
      )?.payload,
    ).toMatchObject({ serverUuid: "srv-edge-uuid", name: "edge" });

    await pollAt(harness, T0 + 2 * MINUTE);
    expect(harness.mock.operationEvents).toHaveLength(2);
  });

  it("a restart is container-restarted, and a deploy's passing states are no status change", async () => {
    const { harness, fake } = await start();
    await pollAt(harness, T0);
    fake.set("GET /applications", web("starting"));
    await pollAt(harness, T0 + MINUTE);
    fake.set("GET /applications", web("running:healthy"));
    await pollAt(harness, T0 + 2 * MINUTE);
    expect(harness.mock.operationEvents).toEqual([]);
    fake.set("GET /applications", web("restarting:unknown"));
    await pollAt(harness, T0 + 3 * MINUTE);
    expect(kinds(harness)).toEqual(["coolify.container-restarted"]);
  });

  it.each(["running:unhealthy", "running:healthy", "degraded:unhealthy"])(
    "%s to restarting is one container-restarted, however the health reads",
    async (before) => {
      const { harness, fake } = await start({
        "GET /applications": web(before),
      });
      await pollAt(harness, T0);
      fake.set("GET /applications", web("restarting:unhealthy"));
      await pollAt(harness, T0 + MINUTE);
      await pollAt(harness, T0 + 2 * MINUTE);
      expect(kinds(harness)).toEqual(["coolify.container-restarted"]);
    },
  );

  it("a poll needs no actor and never reads Coolify as anyone but the owner's token", async () => {
    const { harness, fake } = await start();
    const before = fake.calls.length;
    await pollAt(harness, T0);
    const polled = fake.calls.slice(before);
    expect(polled.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        "GET /applications",
        "GET /deployments",
        "GET /servers",
      ]),
    );
    expect(polled.every((c) => c.method === "GET")).toBe(true);
    for (const call of polled) {
      expect(
        (call.init?.headers as Record<string, string>)?.authorization,
      ).toBe("Bearer fake-token-lifecycle");
    }
  });
});

describe("a target change", () => {
  it("a repoint mid-run stores nothing, and the next poll is a baseline again", async () => {
    const { harness, fake, id } = await start({
      "GET /deployments": running(["dep-1", "in_progress"]),
    });
    await pollAt(harness, T0);
    fake.set(HISTORY, history(["dep-1", "failed", T0 + 30_000]));
    // The connection is repointed while the poll reads Coolify.
    fake.set("GET /deployments", (url) => {
      harness.db.sqlite
        .prepare(
          "UPDATE p_coolify_connections SET allow_private = 1 WHERE id = ?",
        )
        .run(id);
      void url;
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    });
    await pollAt(harness, T0 + MINUTE);
    expect(harness.mock.operationEvents).toEqual([]);
    expect(eventRows(harness, id)).toEqual([]);
    expect((await connection(harness, id)).pollError).toBeNull();

    // Under the new revision nothing old is compared: a baseline again.
    fake.set("GET /deployments", running());
    await pollAt(harness, T0 + 2 * MINUTE);
    expect(harness.mock.operationEvents).toEqual([]);
  });

  it.each(["/services", "/servers"])(
    "a repoint while %s waits to retry sends no further request",
    async (path) => {
      const { harness, fake, id } = await start();
      await pollAt(harness, T0);
      // Coolify asks for a retry; the connection is repointed meanwhile.
      fake.set(`GET ${path}`, () => {
        harness.db.sqlite
          .prepare(
            "UPDATE p_coolify_connections SET allow_private = 1 WHERE id = ?",
          )
          .run(id);
        return new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      });
      const before = fake.calls.length;
      await pollAt(harness, T0 + MINUTE);
      const sent = fake.calls.slice(before).map((c) => c.path);
      expect(sent.filter((p) => p === path)).toHaveLength(1);
      // Nothing after the repoint but the list reads already sent with it.
      const inFlight = new Set(["/applications", "/databases"]);
      expect(
        sent.slice(sent.indexOf(path) + 1).filter((p) => !inFlight.has(p)),
      ).toEqual([]);
      expect(harness.mock.operationEvents).toEqual([]);
      expect((await connection(harness, id)).pollError).toBeNull();
    },
    HEAVY_TEST_MS,
  );
});

describe("a token scope", () => {
  const forbidden: FakeAnswer = {
    status: 403,
    json: { message: "This token can't do that." },
  };

  it("a scoped connection polls its resources and deployments, and never its servers", async () => {
    const { harness, fake, id } = await start({
      "GET /team": forbidden,
      "GET /servers": forbidden,
      "GET /deployments": running(["dep-1", "in_progress"]),
    });
    expect((await connection(harness, id)) as unknown).toMatchObject({
      scoped: true,
    });
    const before = fake.calls.length;
    await pollAt(harness, T0);
    fake.set("GET /deployments", running());
    fake.set(HISTORY, history(["dep-1", "finished", T0 + 30_000]));
    fake.set("GET /applications", web("exited"));
    await pollAt(harness, T0 + MINUTE);
    expect(kinds(harness).sort()).toEqual([
      "coolify.deployment-finished",
      "coolify.status-changed",
    ]);
    expect(
      fake.calls.slice(before).filter((c) => c.path === "/servers"),
    ).toEqual([]);
    expect((await connection(harness, id)).pollError).toBeNull();
  });

  it("a read the token is refused leaves that part as it was: no events, no failure", async () => {
    const { harness, fake, id } = await start({
      "GET /deployments": running(["dep-1", "in_progress"]),
    });
    await pollAt(harness, T0);
    // Servers refused while edge goes down: nothing about servers is sent,
    // and the rest of the poll still counts.
    fake.set("GET /servers", forbidden);
    fake.set("GET /deployments", running());
    fake.set(HISTORY, history(["dep-1", "finished", T0 + 30_000]));
    await pollAt(harness, T0 + MINUTE);
    expect(kinds(harness)).toEqual(["coolify.deployment-finished"]);
    expect((await connection(harness, id)).pollError).toBeNull();
    // Readable again: what was seen before the refusal still counts.
    fake.set("GET /servers", servers(false));
    await pollAt(harness, T0 + 2 * MINUTE);
    expect(kinds(harness)).toEqual([
      "coolify.deployment-finished",
      "coolify.server-unreachable",
    ]);
  });
});

describe("who is polled", () => {
  it("skips a connection whose owner lost coolify.view, without reading Coolify", async () => {
    const { harness, fake } = await start();
    const hasFor = vi
      .spyOn(harness.mock.ctx.rbac, "hasFor")
      .mockResolvedValue(false);
    const before = fake.calls.length;
    await pollAt(harness, T0);
    expect(hasFor).toHaveBeenCalledWith(OWNER, "view");
    expect(fake.calls.slice(before)).toEqual([]);
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(false);
  });

  it("an owner who gets view back starts from a baseline, not from before", async () => {
    const { harness, fake } = await start();
    await pollAt(harness, T0);
    const hasFor = vi
      .spyOn(harness.mock.ctx.rbac, "hasFor")
      .mockResolvedValue(false);
    fake.set("GET /applications", web("exited"));
    await pollAt(harness, T0 + MINUTE);
    hasFor.mockRestore();
    await pollAt(harness, T0 + 2 * MINUTE);
    expect(harness.mock.operationEvents).toEqual([]);
  });

  it("polls by default; once the team's webhook delivered, follows pollEnabled", async () => {
    const { harness, fake, id } = await start();
    expect((await connection(harness, id)).pollEnabled).toBe(false);
    const polls = () =>
      fake.calls.filter((c) => c.path === "/deployments").length;

    await pollAt(harness, T0);
    expect(polls()).toBe(1);
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(true);

    // A webhook row for another team changes nothing.
    harness.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_webhooks (instance_key, token_hash, created_by_user_id, last_received_at) VALUES (?, ?, ?, ?)",
      )
      .run("other-team", "hash-other", OWNER, at(T0));
    await pollAt(harness, T0 + MINUTE);
    expect(polls()).toBe(2);

    // A webhook row for this team, never delivered: still polls.
    const key = (
      harness.db.sqlite
        .prepare("SELECT instance_key FROM p_coolify_connections WHERE id = ?")
        .get(id) as { instance_key: string }
    ).instance_key;
    expect(key).toBeTruthy();
    harness.db.sqlite
      .prepare(
        "INSERT INTO p_coolify_webhooks (instance_key, token_hash, created_by_user_id) VALUES (?, ?, ?)",
      )
      .run(key, "hash-ours", OWNER);
    await pollAt(harness, T0 + 2 * MINUTE);
    expect(polls()).toBe(3);

    // Delivered: polling now follows pollEnabled, which is off.
    harness.db.sqlite
      .prepare(
        "UPDATE p_coolify_webhooks SET last_received_at = ? WHERE instance_key = ?",
      )
      .run(at(T0 + 2 * MINUTE), key);
    await pollAt(harness, T0 + 3 * MINUTE);
    expect(polls()).toBe(3);
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(false);

    // The owner turns it on again.
    const outcome = await harness.mock.ctx.operations.run(
      "coolify.connection-set-poll",
      { input: { connectionId: String(id), pollEnabled: true } },
    );
    expect(outcome.data).toMatchObject({ id, pollEnabled: true });
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(true);
    await pollAt(harness, T0 + 4 * MINUTE);
    expect(polls()).toBe(4);
  });

  it("the admin setting allowPolling off stops every poll", async () => {
    const { harness, fake } = await start(
      {},
      { settings: { allowPolling: false } },
    );
    const before = fake.calls.length;
    await pollAt(harness, T0);
    expect(fake.calls.slice(before)).toEqual([]);
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(false);
  });

  it("minPollSeconds above a minute spaces polls out", async () => {
    const { harness, fake } = await start(
      {},
      { settings: { minPollSeconds: 180 } },
    );
    const polls = () =>
      fake.calls.filter((c) => c.path === "/deployments").length;
    await pollAt(harness, T0);
    await pollAt(harness, T0 + MINUTE);
    await pollAt(harness, T0 + 2 * MINUTE);
    expect(polls()).toBe(1);
    await pollAt(harness, T0 + 3 * MINUTE);
    expect(polls()).toBe(2);
  });
});

describe("keepAwake", () => {
  it("is on only while some connection polls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { harness, id } = await startLifecycle({ overrides: pollAnswers() });
    harnesses.push(harness);
    // A connection was created: it polls.
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(true);
    await harness.mock.ctx.operations.run("coolify.connection-delete", {
      input: { connectionId: String(id) },
    });
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(false);
    await pollAt(harness, T0);
    expect(harness.mock.awake.has(POLL_AWAKE_REASON)).toBe(false);
  });
});

describe("backoff", () => {
  it("waits 1, 2, 5, then 15 minutes, shows the cause on the connection, and resets on success", async () => {
    const { harness, fake, id } = await start();
    const polls = () =>
      fake.calls.filter((c) => c.path === "/deployments").length;
    await pollAt(harness, T0);
    expect(polls()).toBe(1);
    fake.set("GET /deployments", {
      status: 401,
      json: { message: "Unauthenticated." },
    });

    let now = T0 + MINUTE;
    await pollAt(harness, now);
    expect(polls()).toBe(2);
    expect((await connection(harness, id)).pollError).toBe("unauthorized");

    for (const minutes of [1, 2, 5, 15, 15]) {
      const count = polls();
      // Not before the wait is over...
      await pollAt(harness, now + minutes * MINUTE - 1_000);
      expect(polls()).toBe(count);
      // ...and once it is.
      now += minutes * MINUTE;
      await pollAt(harness, now);
      expect(polls()).toBe(count + 1);
    }

    // Success resets the wait and clears the cause.
    fake.set("GET /deployments", running());
    now += 15 * MINUTE;
    await pollAt(harness, now);
    expect((await connection(harness, id)).pollError).toBeNull();
    fake.set("GET /deployments", {
      status: 401,
      json: { message: "Unauthenticated." },
    });
    now += MINUTE;
    await pollAt(harness, now);
    const count = polls();
    now += MINUTE;
    await pollAt(harness, now);
    expect(polls()).toBe(count + 1);
  });

  it("an unreachable Coolify shows its own cause", async () => {
    const { harness, fake, id } = await start();
    fake.set("GET /applications", () => {
      throw new TypeError("fetch failed");
    });
    await pollAt(harness, T0);
    expect((await connection(harness, id)).pollError).toBe("unreachable");
  });

  it("the wait counts from when the poll failed, not from when it started", async () => {
    const { harness, fake } = await start();
    const polls = () =>
      fake.calls.filter((c) => c.path === "/deployments").length;
    await pollAt(harness, T0);
    // The failing answer comes 90 seconds into the poll.
    fake.set("GET /deployments", () => {
      vi.setSystemTime(T0 + MINUTE + 90_000);
      return new Response(JSON.stringify({ message: "Unauthenticated." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    await pollAt(harness, T0 + MINUTE);
    fake.set("GET /deployments", running());
    const count = polls();
    // A minute after the start, but not yet after the failure.
    await pollAt(harness, T0 + 2 * MINUTE + 89_000);
    expect(polls()).toBe(count);
    await pollAt(harness, T0 + 2 * MINUTE + 90_000);
    expect(polls()).toBe(count + 1);
  });
});

describe("backups and scheduled tasks", () => {
  function backups(status: string, finished: number): FakeAnswer {
    return {
      json: [
        {
          uuid: "backup-config-uuid",
          frequency: "0 * * * *",
          executions: [
            {
              uuid: "exec-1",
              status,
              message: "a backup log that never leaves Coolify",
              created_at: at(finished - MINUTE),
              updated_at: at(finished),
              finished_at: at(finished),
            },
          ],
        },
      ],
    };
  }

  it("are read at most every five minutes, and a finished run is one event", async () => {
    const { harness, fake, id } = await start({
      "GET /databases/db-main-uuid/backups": backups("running", T0),
      "GET /applications/app-web-uuid/scheduled-tasks": {
        json: [{ uuid: "task-1", name: "nightly", enabled: true }],
      },
      "GET /applications/app-web-uuid/scheduled-tasks/task-1/executions": {
        json: [],
      },
    });
    const reads = () =>
      fake.calls.filter(
        (c) =>
          c.path === "/databases/db-main-uuid/backups" ||
          c.path === "/applications/app-web-uuid/scheduled-tasks",
      ).length;
    await pollAt(harness, T0);
    expect(reads()).toBe(2);
    fake.set(
      "GET /databases/db-main-uuid/backups",
      backups("failed", T0 + 2 * MINUTE),
    );
    fake.set(
      "GET /applications/app-web-uuid/scheduled-tasks/task-1/executions",
      {
        json: [
          {
            uuid: "task-exec-1",
            status: "success",
            message: "task output that never leaves Coolify",
            created_at: at(T0 + 3 * MINUTE),
            finished_at: at(T0 + 3 * MINUTE),
          },
        ],
      },
    );
    for (let m = 1; m < 5; m++) await pollAt(harness, T0 + m * MINUTE);
    expect(reads()).toBe(2);
    expect(harness.mock.operationEvents).toEqual([]);
    expect(
      SLOW_POLL_MS,
      "backups and tasks wait five minutes between reads",
    ).toBe(5 * MINUTE);
    await pollAt(harness, T0 + 5 * MINUTE);
    expect(reads()).toBe(4);
    expect(kinds(harness).sort()).toEqual([
      "coolify.backup-failed",
      "coolify.task-succeeded",
    ]);
    // A task run carries its task, so it dedupes with the webhook's
    // task_uuid and apart from the resource's other tasks.
    expect(eventRows(harness, id).map((r) => r.dedupe_key)).toContainEqual(
      expect.stringMatching(/^task\|task-succeeded\|task-1\|\d+$/),
    );
    expect(JSON.stringify(harness.mock.operationEvents)).not.toMatch(
      /never leaves Coolify/,
    );
    await pollAt(harness, T0 + 10 * MINUTE);
    expect(harness.mock.operationEvents).toHaveLength(2);
  });
});

describe("a waited deploy and a poll", () => {
  it("send one event for the same deployment", async () => {
    const { harness, fake, id } = await start({
      "GET /deployments": running(["dep-uuid", "in_progress"]),
    });
    await pollAt(harness, T0);
    await harness.mock.ctx.operations.run("coolify.resource-deploy", {
      input: { connectionId: String(id), uuid: "app-web-uuid", wait: true },
    });
    expect(kinds(harness)).toEqual(["coolify.deployment-finished"]);
    fake.set("GET /deployments", running());
    fake.set(HISTORY, history(["dep-uuid", "finished", T0 + 10_000]));
    await pollAt(harness, T0 + MINUTE);
    expect(kinds(harness)).toEqual(["coolify.deployment-finished"]);
    expect(eventRows(harness, id)).toHaveLength(1);
  });
});

describe("coolify.connection-set-poll", () => {
  it("only the owner with Configure Coolify changes it, and it is audited", async () => {
    const { harness, id } = await start();
    grant(harness, id, OTHER, "configure");
    harness.mock.setActor(OTHER);
    await expect(
      harness.mock.ctx.operations.run("coolify.connection-set-poll", {
        input: { connectionId: String(id), pollEnabled: true },
      }),
    ).rejects.toThrow();
    harness.mock.setActor(OWNER);
    expect(
      (
        await harness.request(
          "PATCH",
          `/connections/${id}`,
          { pollEnabled: true },
          OTHER,
        )
      ).status,
    ).toBe(403);
    const answer = await harness.request("PATCH", `/connections/${id}`, {
      pollEnabled: true,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ pollEnabled: true, pollError: null });
    expect(
      (await harness.request("PATCH", `/connections/${id}`, { pollEnabled: 1 }))
        .status,
    ).toBe(400);
  });
});
