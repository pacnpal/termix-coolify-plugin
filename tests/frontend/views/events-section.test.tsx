import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import { CoolifyTab } from "../../../src/frontend/views/CoolifyTab";
import {
  EVENT_KIND_IDS,
  EVENTS_POLL_MS,
  mergeNewest,
} from "../../../src/frontend/views/useEventLog";
import { EVENT_KINDS } from "../../../src/backend/events/kinds";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { connection, queueRow, stubApi } from "../fixtures";

const real = manifestJson as unknown as PluginManifest;
/** The plugin's manifest plus a test tab that holds CoolifyTab. */
const manifest: PluginManifest = {
  ...real,
  contributes: {
    ...real.contributes,
    tabs: [
      ...(real.contributes?.tabs ?? []),
      {
        id: "coolify-harness",
        titleKey: "tab.title",
        icon: "Rocket",
        openFrom: ["palette"],
      },
    ],
  },
};
const E = locales.eventLog;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

interface Row {
  id: number;
  kind: string;
  resourceUuid?: string | null;
  serverUuid?: string | null;
  deploymentUuid?: string | null;
  name?: string | null;
}

/** An event log row as GET /connections/:id/events answers it. */
function ev(r: Row, connectionId = 1) {
  return {
    connectionId,
    severity: "warning",
    title: r.kind,
    resourceUuid: "app-web-uuid",
    serverUuid: "srv-vps1-uuid",
    deploymentUuid: null,
    hostId: null,
    name: "web",
    status: "failed",
    source: "poll",
    fields: {},
    createdAt: `2026-11-19T10:${String(r.id).padStart(2, "0")}:00.000Z`,
    ...r,
  };
}

type Page = { rows: ReturnType<typeof ev>[]; nextBefore: number | null };
type Answer = (query: URLSearchParams, id: number) => Promise<Page> | Page;

const EVENTS_URL = /^\/connections\/(\d+)\/events(?:\?(.*))?$/;

/** The stub with the event log routed to `answer`. */
function eventsApi(answer: Answer, connections?: unknown[]) {
  const api = stubApi({ connections });
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    const match = EVENTS_URL.exec(url);
    if (match) {
      return {
        data: await answer(new URLSearchParams(match[2] ?? ""), +match[1]),
      };
    }
    if (/^\/connections\/\d+\/deployments$/.test(url)) {
      return { data: { running: [], recent: [], fetchedAt: null } };
    }
    if (url === "/connections/1/resources/app-web-uuid/deployments/dep-1") {
      return {
        data: {
          deployment: queueRow("dep-1", "failed", {
            uuid: "app-web-uuid",
            name: "web",
          }),
          log: { lines: [], truncated: false },
          final: true,
          cancellable: false,
        },
      };
    }
    return fallback(url);
  });
  return api;
}

const eventCalls = (api: ReturnType<typeof stubApi>) =>
  api.get.mock.calls
    .map(([url]) => EVENTS_URL.exec(String(url)))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ id: +m[1], query: new URLSearchParams(m[2] ?? "") }));

/** The event ids shown, top to bottom. */
const shownIds = () =>
  [...document.querySelectorAll("[data-event-id]")].map((el) =>
    Number(el.getAttribute("data-event-id")),
  );

async function openTab(api: ReturnType<typeof stubApi>, permissions = OPERATE) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.renderTab("coolify", { isVisible: true });
  await screen.findByRole("button", { name: locales.nav.events });
}

function openEvents() {
  fireEvent.click(screen.getByRole("button", { name: locales.nav.events }));
}

/** The row of event `id`, once it shows. */
function eventRow(id: number) {
  return waitFor(() => {
    const el = document.querySelector(`[data-event-id="${id}"]`);
    if (!el) throw new Error(`event ${id} is not shown`);
    return el;
  });
}

/** Picks `option` in the select labelled `label`. */
async function choose(label: string, option: string) {
  Element.prototype.scrollIntoView = () => {};
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** Lets fake timers run every promise that is ready. */
async function pump() {
  for (let i = 0; i < 10; i += 1) {
    await act(() => vi.advanceTimersByTimeAsync(0));
  }
}

describe("events section", () => {
  it("has a label for every event kind", () => {
    expect([...EVENT_KIND_IDS].sort()).toEqual(Object.keys(EVENT_KINDS).sort());
    for (const kind of EVENT_KIND_IDS) {
      expect(typeof (E.kinds as Record<string, string>)[kind]).toBe("string");
    }
  });

  it("lists the log newest first", async () => {
    const api = eventsApi(() => ({
      // Whatever order arrives, the newest shows on top.
      rows: [
        ev({ id: 2, kind: "backup-failed", name: "cache" }),
        ev({ id: 7, kind: "deployment-failed" }),
        ev({ id: 5, kind: "restart-limit", name: "api" }),
      ],
      nextBefore: null,
    }));
    await openTab(api);
    openEvents();
    expect(await screen.findByText(E.kinds["deployment-failed"])).toBeTruthy();
    expect(shownIds()).toEqual([7, 5, 2]);
    expect(eventCalls(api)[0]).toMatchObject({ id: 1 });
    expect(screen.queryByRole("button", { name: E.older })).toBeNull();
  });

  it("pages older events with the before cursor", async () => {
    const api = eventsApi((q) =>
      q.get("before") === "4"
        ? { rows: [ev({ id: 3, kind: "task-failed" })], nextBefore: null }
        : {
            rows: [
              ev({ id: 5, kind: "deployment-failed" }),
              ev({ id: 4, kind: "backup-failed" }),
            ],
            nextBefore: 4,
          },
    );
    await openTab(api);
    openEvents();
    fireEvent.click(await screen.findByRole("button", { name: E.older }));
    await waitFor(() => expect(shownIds()).toEqual([5, 4, 3]));
    const calls = eventCalls(api);
    expect(calls[0].query.get("before")).toBeNull();
    expect(calls[1].query.get("before")).toBe("4");
    expect(screen.queryByRole("button", { name: E.older })).toBeNull();
  });

  it("filters by kind and by resource", async () => {
    const api = eventsApi((q) => {
      if (q.get("uuid") === "app-api-uuid") {
        return {
          rows: [ev({ id: 9, kind: "deployment-failed", name: "api-only" })],
          nextBefore: null,
        };
      }
      if (q.get("kind") === "deployment-failed") {
        return {
          rows: [ev({ id: 8, kind: "deployment-failed", name: "kind-only" })],
          nextBefore: null,
        };
      }
      return {
        rows: [ev({ id: 1, kind: "backup-failed", name: "everything" })],
        nextBefore: null,
      };
    });
    await openTab(api);
    openEvents();
    expect(await screen.findByText(/everything/)).toBeTruthy();
    await choose(E.kindFilter, E.kinds["deployment-failed"]);
    expect(await screen.findByText(/kind-only/)).toBeTruthy();
    expect(screen.queryByText(/everything/)).toBeNull();
    await choose(E.resourceFilter, "api");
    expect(await screen.findByText(/api-only/)).toBeTruthy();
    const last = eventCalls(api).at(-1)!.query;
    expect(last.get("kind")).toBe("deployment-failed");
    expect(last.get("uuid")).toBe("app-api-uuid");
  });

  it("says when the log is empty, and when a read fails, with a retry", async () => {
    let fail = true;
    const api = eventsApi(() => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("offline"));
      }
      return { rows: [], nextBefore: null };
    });
    await openTab(api);
    openEvents();
    expect(await screen.findByText(E.failed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: E.retry }));
    expect(await screen.findByText(E.empty)).toBeTruthy();
    expect(screen.queryByText(E.failed)).toBeNull();
  });

  it("opens a row's subject: its resource, its server or its build log", async () => {
    const api = eventsApi(() => ({
      rows: [
        ev({
          id: 4,
          kind: "token-expiring",
          resourceUuid: null,
          serverUuid: null,
        }),
        ev({ id: 3, kind: "deployment-failed", deploymentUuid: "dep-1" }),
        ev({
          id: 2,
          kind: "server-unreachable",
          resourceUuid: null,
          serverUuid: "srv-edge-uuid",
          name: "edge",
        }),
        ev({ id: 1, kind: "backup-failed", resourceUuid: "app-api-uuid" }),
      ],
      nextBefore: null,
    }));
    await openTab(api);
    openEvents();
    await screen.findByText(E.kinds["backup-failed"]);
    // A team-wide row has no subject to open.
    fireEvent.click(await eventRow(4));
    expect(screen.getByText(E.kinds["token-expiring"])).toBeTruthy();

    fireEvent.click(await eventRow(1));
    expect(
      await screen.findByText(locales.detail.fields.coolifyStatus),
    ).toBeTruthy();
    expect(screen.getAllByText("api").length).toBeGreaterThan(0);

    openEvents();
    fireEvent.click(await eventRow(2));
    expect(
      await screen.findByText(
        locales.resources.serverFilter.label.replace("{{server}}", "edge"),
      ),
    ).toBeTruthy();

    openEvents();
    fireEvent.click(await eventRow(3));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/deployments/dep-1",
      ),
    );
  });

  it("opens a deployment row's resource, not its build log, without operate", async () => {
    const api = eventsApi(() => ({
      rows: [ev({ id: 3, kind: "deployment-failed", deploymentUuid: "dep-1" })],
      nextBefore: null,
    }));
    await openTab(api, ["coolify.view"]);
    openEvents();
    fireEvent.click(await eventRow(3));
    expect(
      await screen.findByText(locales.detail.fields.coolifyStatus),
    ).toBeTruthy();
    expect(api.get).not.toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/deployments/dep-1",
    );
  });

  it("clears on a connection change and drops the old connection's late answer", async () => {
    let releaseOld: (page: Page) => void = () => {};
    let first = true;
    const api = eventsApi(
      (_q, id) => {
        if (id === 1 && first) {
          first = false;
          return new Promise<Page>((resolve) => (releaseOld = resolve));
        }
        return {
          rows: [ev({ id: 50, kind: "backup-failed", name: `from-${id}` }, id)],
          nextBefore: null,
        };
      },
      [connection, { ...connection, id: 2, name: "Staging", revision: "r2" }],
    );
    await openTab(api);
    openEvents();
    await waitFor(() => expect(eventCalls(api)).toHaveLength(1));
    expect(screen.getByText(E.loading)).toBeTruthy();
    await choose(locales.picker.label, "Staging");
    expect(await screen.findByText(/from-2/)).toBeTruthy();
    // Connection 1's first read answers only now: it never shows.
    await act(async () =>
      releaseOld({
        rows: [ev({ id: 60, kind: "deployment-failed", name: "late-from-1" })],
        nextBefore: null,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/late-from-1/)).toBeNull();
    expect(screen.getByText(/from-2/)).toBeTruthy();
    // And back on connection 1: its own fresh read, nothing of connection 2's.
    await choose(locales.picker.label, "Prod");
    expect(await screen.findByText(/from-1/)).toBeTruthy();
    expect(screen.queryByText(/from-2/)).toBeNull();
  });
});

describe("events section refresh", () => {
  /** Opens the section in a tab whose visibility the test sets. */
  async function openHarness(api: ReturnType<typeof stubApi>) {
    let setVisible: (v: boolean) => void = () => {};
    function Harness(props: TabProps) {
      const [visible, set] = useState(true);
      useEffect(() => {
        setVisible = set;
      }, []);
      return <CoolifyTab {...props} isVisible={visible} />;
    }
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: OPERATE,
    });
    rendered.app.registerTab("coolify-harness", Harness as never, {
      titleKey: "tab.title",
      hostless: true,
    });
    rendered.renderTab("coolify-harness");
    await screen.findByRole("button", { name: locales.nav.events });
    // Faked before the section mounts, so every read is counted.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    openEvents();
    await pump();
    return (v: boolean) => act(() => setVisible(v));
  }

  it("reads again on the interval only while shown, never sooner", async () => {
    let n = 0;
    const api = eventsApi(() => {
      n += 1;
      // The whole log each time: one more event per read.
      return {
        rows: Array.from({ length: n }, (_, i) =>
          ev({ id: n - i, kind: "backup-failed", name: `read-${n - i}` }),
        ),
        nextBefore: null,
      };
    });
    const setVisible = await openHarness(api);
    expect(eventCalls(api)).toHaveLength(1);
    expect(screen.getByText(/read-1/)).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_POLL_MS - 1));
    expect(eventCalls(api)).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await pump();
    expect(eventCalls(api)).toHaveLength(2);
    // A new event lands on top of what was there.
    expect(shownIds()).toEqual([2, 1]);

    await setVisible(false);
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_POLL_MS * 6));
    expect(eventCalls(api)).toHaveLength(2);

    await setVisible(true);
    await pump();
    expect(eventCalls(api)).toHaveLength(3);
    expect(EVENTS_POLL_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("stops reading once another section shows", async () => {
    const api = eventsApi(() => ({ rows: [], nextBefore: null }));
    await openHarness(api);
    expect(eventCalls(api)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: locales.nav.overview }));
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_POLL_MS * 4));
    expect(eventCalls(api)).toHaveLength(1);
  });

  it("schedules the next read only after the current one settles", async () => {
    let release: (page: Page) => void = () => {};
    let n = 0;
    const api = eventsApi(() => {
      n += 1;
      if (n === 2) return new Promise<Page>((resolve) => (release = resolve));
      return { rows: [ev({ id: n, kind: "backup-failed" })], nextBefore: null };
    });
    await openHarness(api);
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_POLL_MS));
    await pump();
    expect(eventCalls(api)).toHaveLength(2);
    // The second read is still out: no third, however long it takes.
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_POLL_MS * 5));
    expect(eventCalls(api)).toHaveLength(2);
    await act(async () =>
      release({ rows: [ev({ id: 2, kind: "task-failed" })], nextBefore: null }),
    );
    await pump();
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_POLL_MS - 1));
    expect(eventCalls(api)).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await pump();
    expect(eventCalls(api)).toHaveLength(3);
  });
});

describe("mergeNewest", () => {
  const rowsOf = (...ids: number[]) =>
    ids.map((id) => ev({ id, kind: "backup-failed" })) as never[];

  it("keeps older rows already shown under a newest page that reaches them", () => {
    const merged = mergeNewest(
      { rows: rowsOf(5, 4, 3, 2), nextBefore: 2 },
      { rows: rowsOf(7, 6, 5), nextBefore: 5 },
    );
    expect(merged.rows.map((r) => r.id)).toEqual([7, 6, 5, 4, 3, 2]);
    expect(merged.nextBefore).toBe(2);
  });

  it("starts again from the page when more events came than a page holds", () => {
    const merged = mergeNewest(
      { rows: rowsOf(3, 2), nextBefore: 2 },
      { rows: rowsOf(9, 8), nextBefore: 8 },
    );
    expect(merged.rows.map((r) => r.id)).toEqual([9, 8]);
    expect(merged.nextBefore).toBe(8);
  });
});
