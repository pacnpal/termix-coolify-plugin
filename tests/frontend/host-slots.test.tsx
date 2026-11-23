import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  checkFrameApp,
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../src/frontend/index";
import { createApi, type ServerHealth } from "../../src/frontend/api";
import {
  createHostStatsFeed,
  HOST_METRICS_ACTION,
  HOST_ROW_ACTION,
  HOST_ROW_BADGE_ACTION,
  HOST_STATS_POLL_MS,
} from "../../src/frontend/host-slots";
import { HEALTH_MAX_AGE_MS, useServerHealth } from "../../src/frontend/linked";
import locales from "../../locales/en.json";
import { manifest, stubClient } from "./helpers";

const H = locales.resources.health;
const S = locales.hostSlots;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A host record; the server health cache outlives a test, so ids differ. */
function host(
  id: number,
  link: { connectionId: number; serverUuid: string } | null,
) {
  return {
    id,
    name: `host-${id}`,
    ip: `203.0.113.${id}`,
    port: 22,
    username: "root",
    pluginSettings: link
      ? {
          coolify: {
            coolifyLinked: true,
            coolifyConnectionId: String(link.connectionId),
            coolifyServerUuid: link.serverUuid,
          },
        }
      : {},
  };
}

/** The same host as the shell lists it: its id is a string. */
function shellHost(
  id: number,
  link: { connectionId: number; serverUuid: string } | null,
) {
  return { ...host(id, link), id: String(id) };
}

function health(overrides: Partial<ServerHealth> = {}): ServerHealth {
  return {
    servers: [{ uuid: "srv-a", reachable: true, usable: true }],
    degraded: { "srv-a": 1 },
    counts: {
      "srv-a": { running: 3, degraded: 1, stopped: 2, deploying: 0 },
    },
    deploying: { "srv-a": 2 },
    ...overrides,
  };
}

const STATS = {
  containers: 2,
  cpuPercent: 37.5,
  memoryBytes: 2 * 1024 ** 3,
  cpus: 4,
  memoryTotalBytes: 8 * 1024 ** 3,
  at: "2026-11-22T10:00:00.000Z",
};

type Get = (url: string) => Promise<{ data: unknown }>;

function client(get: Get) {
  return stubClient({ get });
}

const healthCalls = (api: ReturnType<typeof client>) =>
  api.get.mock.calls.filter(([url]) => /\/server-health$/.test(String(url)));
const statsCalls = (api: ReturnType<typeof client>) =>
  api.get.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes("/host-metrics"));

async function start(
  api: PluginApiClient,
  options: { permissions?: string[]; hosts?: Record<string, unknown>[] } = {},
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: options.permissions ?? ["coolify.view", "coolify.operate"],
    hosts: options.hosts,
  });
  return rendered;
}

/** Gives any effect a chance to fetch; only for checking nothing happened. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("dashboard.hostRow", () => {
  it("shows a Linked host's running, degraded and stopped counts", async () => {
    const api = client(async () => ({ data: health() }));
    const r = await start(api);
    const h = host(1, { connectionId: 201, serverUuid: "srv-a" });
    const read = r.readDataValues(
      "dashboard.hostRow",
      { hostId: 1, host: h, online: true },
      "1",
    );
    await waitFor(() =>
      expect(read.values()[HOST_ROW_ACTION]).toEqual([
        {
          shape: "stat",
          items: [
            { label: H.running, value: 3, tone: "good" },
            { label: H.degraded, value: 1, tone: "warn" },
            { label: H.stopped, value: 2, tone: "muted" },
          ],
        },
      ]),
    );
  });

  it("an unlinked host shows nothing and makes no request", async () => {
    const api = client(async () => ({ data: health() }));
    const r = await start(api);
    const read = r.readDataValues(
      "dashboard.hostRow",
      { hostId: 2, host: host(2, null), online: true },
      "2",
    );
    await settle();
    expect(read.values()[HOST_ROW_ACTION]).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("a viewer without coolify.view makes no request; a refused read shows nothing", async () => {
    const api = client(async () => ({ data: health() }));
    const r = await start(api, { permissions: [] });
    const h = host(3, { connectionId: 203, serverUuid: "srv-a" });
    const read = r.readDataValues(
      "dashboard.hostRow",
      { hostId: 3, host: h, online: true },
      "3",
    );
    await settle();
    expect(read.values()[HOST_ROW_ACTION]).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    await rendered!.deactivate();

    // Another user's connection answers 404.
    const refused = client(async () => {
      throw Object.assign(new Error("Not found"), {
        response: { status: 404 },
      });
    });
    const r2 = await start(refused);
    const h2 = host(4, { connectionId: 204, serverUuid: "srv-a" });
    const read2 = r2.readDataValues(
      "dashboard.hostRow",
      { hostId: 4, host: h2, online: true },
      "4",
    );
    await waitFor(() => expect(healthCalls(refused)).toHaveLength(1));
    await settle();
    expect(read2.values()[HOST_ROW_ACTION]).toBeNull();
  });

  it("a server gone from the connection's target shows nothing", async () => {
    // The connection now points at a Coolify without srv-a.
    const api = client(async () => ({
      data: health({
        servers: [{ uuid: "srv-b", reachable: true, usable: true }],
        counts: {
          "srv-b": { running: 9, degraded: 0, stopped: 0, deploying: 0 },
        },
        deploying: { "srv-b": 1 },
      }),
    }));
    const r = await start(api);
    const h = host(5, { connectionId: 205, serverUuid: "srv-a" });
    const context = { hostId: 5, host: h, online: true };
    const row = r.readDataValues("dashboard.hostRow", context, "5");
    const badge = r.readDataValues("dashboard.hostRowBadge", context, "5");
    await waitFor(() => expect(healthCalls(api)).toHaveLength(1));
    await settle();
    expect(row.values()[HOST_ROW_ACTION]).toBeNull();
    expect(badge.values()[HOST_ROW_BADGE_ACTION]).toBeNull();
  });
});

describe("dashboard.hostRowBadge", () => {
  it("shows a deploying badge while the host's server has deployments running", async () => {
    const api = client(async () => ({ data: health() }));
    const r = await start(api);
    const h = host(6, { connectionId: 206, serverUuid: "srv-a" });
    const read = r.readDataValues(
      "dashboard.hostRowBadge",
      { hostId: 6, host: h, online: true },
      "6",
    );
    await waitFor(() =>
      expect(read.values()[HOST_ROW_BADGE_ACTION]).toEqual([
        {
          shape: "badge",
          label: S.deploying,
          tone: "default",
          tooltip: S.deployingHint.replace("{{count}}", "2"),
          icon: "Rocket",
        },
      ]),
    );
  });

  it("shows no badge when nothing deploys, on an unlinked host, or without access", async () => {
    const api = client(async () => ({
      data: health({ deploying: { "srv-a": 0 } }),
    }));
    const r = await start(api);
    const idle = r.readDataValues(
      "dashboard.hostRowBadge",
      {
        hostId: 7,
        host: host(7, { connectionId: 207, serverUuid: "srv-a" }),
        online: true,
      },
      "7",
    );
    const plain = r.readDataValues(
      "dashboard.hostRowBadge",
      { hostId: 8, host: host(8, null), online: true },
      "8",
    );
    await waitFor(() => expect(healthCalls(api)).toHaveLength(1));
    await settle();
    expect(idle.values()[HOST_ROW_BADGE_ACTION]).toBeNull();
    expect(plain.values()[HOST_ROW_BADGE_ACTION]).toBeNull();
    expect(healthCalls(api)).toEqual([["/connections/207/server-health"]]);
  });

  it("every row and badge of one connection costs one request", async () => {
    const api = client(async () => ({
      data: health({
        servers: [
          { uuid: "srv-a", reachable: true, usable: true },
          { uuid: "srv-b", reachable: true, usable: true },
        ],
        counts: {
          "srv-a": { running: 1, degraded: 0, stopped: 0, deploying: 0 },
          "srv-b": { running: 2, degraded: 0, stopped: 1, deploying: 0 },
        },
      }),
    }));
    const r = await start(api);
    const reads = [9, 10].map((id, i) => {
      const context = {
        hostId: id,
        host: host(id, {
          connectionId: 209,
          serverUuid: i === 0 ? "srv-a" : "srv-b",
        }),
        online: true,
      };
      return [
        r.readDataValues("dashboard.hostRow", context, String(id)),
        r.readDataValues("dashboard.hostRowBadge", context, String(id)),
      ];
    });
    await waitFor(() =>
      expect(reads[1]![0]!.values()[HOST_ROW_ACTION]).not.toBeNull(),
    );
    expect(reads[0]![0]!.values()[HOST_ROW_ACTION]).not.toBeNull();
    expect(healthCalls(api)).toEqual([["/connections/209/server-health"]]);
  });
});

describe("useServerHealth", () => {
  it("drops a late answer for the host's old link and never shows it for the new one", async () => {
    const answers: Record<string, (value: { data: unknown }) => void> = {};
    const api = createApi(
      client(
        (url) =>
          new Promise((resolve) => {
            answers[url] = resolve;
          }),
      ),
    );
    const { result, rerender } = renderHook(
      ({ link }) => useServerHealth(api, link),
      {
        initialProps: {
          link: { connectionId: 301, serverUuid: "srv-a" } as {
            connectionId: number;
            serverUuid: string;
          } | null,
        },
      },
    );
    await waitFor(() =>
      expect(answers["/connections/301/server-health"]).toBeTruthy(),
    );
    // The host is linked to another connection before the answer lands.
    rerender({ link: { connectionId: 302, serverUuid: "srv-a" } });
    await act(async () => {
      answers["/connections/301/server-health"]!({ data: health() });
    });
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(answers["/connections/302/server-health"]).toBeTruthy(),
    );
    const other = health({ deploying: { "srv-a": 5 } });
    await act(async () => {
      answers["/connections/302/server-health"]!({ data: other });
    });
    expect(result.current?.deploying).toEqual({ "srv-a": 5 });
    // Unlinked: nothing, at once.
    rerender({ link: null });
    expect(result.current).toBeNull();
  });

  it("reads again each cache period while mounted, and stops on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const raw = client(async () => ({ data: health() }));
    const api = createApi(raw);
    const { result, unmount } = renderHook(() =>
      useServerHealth(api, { connectionId: 303, serverUuid: "srv-a" }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(healthCalls(raw)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_MAX_AGE_MS);
    });
    await waitFor(() => expect(healthCalls(raw)).toHaveLength(2));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_MAX_AGE_MS * 3);
    });
    expect(healthCalls(raw)).toHaveLength(2);
  });
});

describe("homepage.hostMetrics", () => {
  function statsClient(answer: unknown = null) {
    return client(async (url) => {
      if (!url.includes("/host-metrics")) return { data: {} };
      const servers = new URL(url, "http://x").searchParams
        .get("servers")!
        .split(",");
      return {
        data: answer ?? {
          servers: Object.fromEntries(servers.map((s) => [s, STATS])),
          errors: {},
        },
      };
    });
  }

  it("shows a Linked host's container CPU and memory as bars", async () => {
    const api = statsClient();
    const r = await start(api, {
      hosts: [shellHost(11, { connectionId: 1, serverUuid: "srv-a" })],
    });
    const read = r.readDataValues(
      "homepage.hostMetrics",
      { hostId: 11, online: true },
      "11",
    );
    await waitFor(() =>
      expect(read.values()[HOST_METRICS_ACTION]).toEqual([
        {
          shape: "bars",
          items: [
            {
              label: S.containerCpu,
              value: 37.5 / 400,
              detail: S.containers.replace("{{count}}", "2"),
            },
            {
              label: S.containerMemory,
              value: 0.25,
              detail: "2.0 GiB / 8.0 GiB",
            },
          ],
        },
      ]),
    );
    expect(statsCalls(api)).toEqual([
      "/connections/1/host-metrics?servers=srv-a",
    ]);
  });

  it("an unlinked or offline host shows nothing and makes no request", async () => {
    const api = statsClient();
    const r = await start(api, {
      hosts: [
        shellHost(12, null),
        shellHost(13, { connectionId: 1, serverUuid: "s" }),
      ],
    });
    const plain = r.readDataValues(
      "homepage.hostMetrics",
      { hostId: 12, online: true },
      "12",
    );
    const offline = r.readDataValues(
      "homepage.hostMetrics",
      { hostId: 13, online: false },
      "13",
    );
    await settle();
    expect(plain.values()[HOST_METRICS_ACTION]).toBeNull();
    expect(offline.values()[HOST_METRICS_ACTION]).toBeNull();
    expect(statsCalls(api)).toEqual([]);
  });

  it("a viewer without coolify.operate makes no request; a refused server shows nothing", async () => {
    const api = statsClient();
    const r = await start(api, {
      permissions: ["coolify.view"],
      hosts: [shellHost(14, { connectionId: 1, serverUuid: "srv-a" })],
    });
    const read = r.readDataValues(
      "homepage.hostMetrics",
      { hostId: 14, online: true },
      "14",
    );
    await settle();
    expect(read.values()[HOST_METRICS_ACTION]).toBeNull();
    expect(statsCalls(api)).toEqual([]);
    await rendered!.deactivate();

    const refused = statsClient({
      servers: {},
      errors: { "srv-a": "no-host-access" },
    });
    const r2 = await start(refused, {
      hosts: [shellHost(15, { connectionId: 1, serverUuid: "srv-a" })],
    });
    const read2 = r2.readDataValues(
      "homepage.hostMetrics",
      { hostId: 15, online: true },
      "15",
    );
    await waitFor(() => expect(statsCalls(refused)).toHaveLength(1));
    await settle();
    expect(read2.values()[HOST_METRICS_ACTION]).toBeNull();
  });

  it("every host of one connection shares one request", async () => {
    const api = statsClient();
    const r = await start(api, {
      hosts: [
        shellHost(16, { connectionId: 1, serverUuid: "srv-a" }),
        shellHost(17, { connectionId: 1, serverUuid: "srv-b" }),
      ],
    });
    const a = r.readDataValues(
      "homepage.hostMetrics",
      { hostId: 16, online: true },
      "16",
    );
    const b = r.readDataValues(
      "homepage.hostMetrics",
      { hostId: 17, online: true },
      "17",
    );
    await waitFor(() => expect(b.values()[HOST_METRICS_ACTION]).not.toBeNull());
    expect(a.values()[HOST_METRICS_ACTION]).not.toBeNull();
    expect(statsCalls(api)).toEqual([
      "/connections/1/host-metrics?servers=srv-a%2Csrv-b",
    ]);
  });
});

describe("createHostStatsFeed", () => {
  it("polls while a host shows it, never keeps a server's value past its last row", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const raw = client(async (url) => {
      const servers = new URL(url, "http://x").searchParams
        .get("servers")!
        .split(",");
      return {
        data: {
          servers: Object.fromEntries(servers.map((s) => [s, STATS])),
          errors: {},
        },
      };
    });
    const feed = createHostStatsFeed(createApi(raw));
    const stop = feed.subscribe(1, "srv-a", () => {});
    // Another host of the same connection stays on screen throughout.
    const stopKeep = feed.subscribe(1, "srv-keep", () => {});
    await waitFor(() => expect(feed.value(1, "srv-a")).toEqual(STATS));
    expect(statsCalls(raw)).toEqual([
      "/connections/1/host-metrics?servers=srv-a%2Csrv-keep",
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_STATS_POLL_MS);
    });
    await waitFor(() => expect(statsCalls(raw)).toHaveLength(2));
    // The host is relinked: its old server's value goes with its last row,
    // and the new one starts empty until its own answer.
    stop();
    expect(feed.value(1, "srv-a")).toBeNull();
    expect(feed.value(1, "srv-keep")).toEqual(STATS);
    const again = feed.subscribe(1, "srv-a", () => {});
    expect(feed.value(1, "srv-a")).toBeNull();
    const stopB = feed.subscribe(2, "srv-b", () => {});
    expect(feed.value(2, "srv-b")).toBeNull();
    await waitFor(() => expect(feed.value(2, "srv-b")).toEqual(STATS));
    stopB();
    again();
    stopKeep();
    const before = statsCalls(raw).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_STATS_POLL_MS * 3);
    });
    expect(statsCalls(raw)).toHaveLength(before);
  });

  it("drops an answer that lands after its server's last row went", async () => {
    let answer: (value: { data: unknown }) => void = () => {};
    const raw = client(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const feed = createHostStatsFeed(createApi(raw));
    const stop = feed.subscribe(1, "srv-a", () => {});
    const stopKeep = feed.subscribe(1, "srv-keep", () => {});
    await waitFor(() => expect(statsCalls(raw)).toHaveLength(1));
    stop();
    answer({
      data: { servers: { "srv-a": STATS, "srv-keep": STATS }, errors: {} },
    });
    await waitFor(() => expect(feed.value(1, "srv-keep")).toEqual(STATS));
    expect(feed.value(1, "srv-a")).toBeNull();
    stopKeep();
  });
});

describe("host slots in a frame", () => {
  it("registers the three data slots frame-safe", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    const slots = registrations
      .filter((r) => r.kind === "slotContribution")
      .map((r) => (r.data as { slotId?: string }).slotId);
    expect(slots).toEqual(
      expect.arrayContaining([
        "dashboard.hostRow",
        "dashboard.hostRowBadge",
        "homepage.hostMetrics",
      ]),
    );
  });
});
