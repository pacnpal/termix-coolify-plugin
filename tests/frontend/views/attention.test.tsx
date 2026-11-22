import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RenderedPluginApp } from "@termix-ssh/plugin-sdk/testing";
import { createApi } from "../../../src/frontend/api";
import {
  BADGE_POLL_MS,
  PANEL_POLL_MS,
  railBadge,
} from "../../../src/frontend/views/useAttention";
import locales from "../../../locales/en.json";
import { renderApp } from "../helpers";
import { stubApi } from "../fixtures";

const P = locales.activityPanel;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function deployment(uuid: string, status: string, app: string) {
  return {
    uuid,
    resourceUuid: `app-${app}-uuid`,
    resourceName: app,
    status,
    commit: "abc1234",
    commitMessage: `Commit of ${uuid}`,
    pullRequestId: 0,
    rollback: false,
    serverName: "vps1",
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: null,
    finishedAt: null,
  };
}

function conn(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    access: "owner",
    scoped: false,
    running: [],
    failed: [],
    degraded: [],
    unreachable: [],
    error: null,
    ...extra,
  };
}

/** Two connections: Prod with one of each item, Staging with a failure. */
const ANSWER = {
  connections: [
    conn(1, "Prod", {
      running: [deployment("dep-run", "in_progress", "web")],
      degraded: [
        {
          uuid: "app-api-uuid",
          name: "api",
          kind: "application",
          status: "running:unhealthy",
          serverName: "edge",
          projectName: "Shop",
          environmentName: "production",
        },
      ],
      unreachable: [{ uuid: "srv-edge-uuid", name: "edge" }],
    }),
    conn(2, "Staging", {
      access: "view",
      failed: [deployment("dep-failed", "failed", "blog")],
    }),
  ],
  counts: { running: 1, failed: 1, degraded: 1, unreachable: 1 },
  badge: 2,
  fetchedAt: "2026-11-22T10:01:00.000Z",
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A client that answers /attention with `answer` (a function per call). */
function attentionApi(answer: () => unknown = () => ANSWER) {
  const api = stubApi();
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (/^\/attention(\?refresh=1)?$/.test(url)) {
      return { data: await answer() };
    }
    return fallback(url);
  });
  return api;
}

const attentionReads = (api: ReturnType<typeof stubApi>) =>
  api.get.mock.calls.filter(([url]) => String(url).startsWith("/attention"))
    .length;

function badgeOf(api: ReturnType<typeof stubApi>, allowed = true) {
  const hasPermission = vi.fn(async () => allowed);
  const useBadge = railBadge({ api: createApi(api), hasPermission });
  return { hook: renderHook(() => useBadge()), hasPermission };
}

describe("the rail badge", () => {
  it("shows running deployments plus recent failures", async () => {
    const api = attentionApi(() => ({ ...ANSWER, badge: 3 }));
    const { hook } = badgeOf(api);
    await waitFor(() => expect(hook.result.current).toBe(3));
  });

  it("is hidden at zero", async () => {
    const api = attentionApi(() => ({
      connections: [conn(1, "Prod")],
      badge: 0,
    }));
    const { hook } = badgeOf(api);
    await waitFor(() => expect(attentionReads(api)).toBe(1));
    await act(async () => {});
    expect(hook.result.current).toBeNull();
  });

  it("is hidden without coolify.view and asks for nothing", async () => {
    const api = attentionApi();
    const { hook, hasPermission } = badgeOf(api, false);
    await waitFor(() => expect(hasPermission).toHaveBeenCalledWith("view"));
    await act(async () => {});
    expect(hook.result.current).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("polls at a modest interval and stops once it goes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = attentionApi();
    const { hook } = badgeOf(api);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(attentionReads(api)).toBe(1);
    expect(hook.result.current).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(BADGE_POLL_MS - 1));
    expect(attentionReads(api)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(attentionReads(api)).toBe(2);
    hook.unmount();
    await act(() => vi.advanceTimersByTimeAsync(BADGE_POLL_MS * 5));
    expect(attentionReads(api)).toBe(2);
  });
});

async function openPanel(
  api: ReturnType<typeof stubApi>,
  props: Record<string, unknown> = {},
  permissions = ["coolify.view", "coolify.configure", "coolify.operate"],
) {
  rendered = await renderApp(api, permissions);
  const shell = { openSingletonTab: vi.fn() };
  rendered.renderPanel("coolify-activity", {
    active: true,
    placement: "left",
    setEditing: () => {},
    shell,
    ...props,
  });
  return shell;
}

describe("the sidebar panel", () => {
  it("lists what is in progress and what needs attention, from the one shared read", async () => {
    const api = attentionApi();
    await openPanel(api);
    expect(await screen.findByText("Commit of dep-run")).toBeTruthy();
    expect(screen.getByText("Commit of dep-failed")).toBeTruthy();
    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.getByText("edge")).toBeTruthy();
    expect(screen.getByText(P.inProgress)).toBeTruthy();
    expect(screen.getByText(P.attention)).toBeTruthy();
    // Nothing per connection: the panel reads only what the badge reads.
    const urls = api.get.mock.calls.map(([url]) => String(url));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("/attention"))).toBe(true);
  });

  it("opens the right place in the coolify tab from each row", async () => {
    const api = attentionApi();
    const shell = await openPanel(api);
    fireEvent.click(await screen.findByText("Commit of dep-run"));
    expect(shell.openSingletonTab).toHaveBeenLastCalledWith("coolify", {
      data: {
        section: "deployments",
        connectionId: 1,
        resourceUuid: "app-web-uuid",
        deploymentUuid: "dep-run",
      },
    });
    fireEvent.click(screen.getByText("Commit of dep-failed"));
    expect(shell.openSingletonTab).toHaveBeenLastCalledWith("coolify", {
      data: {
        section: "deployments",
        connectionId: 2,
        resourceUuid: "app-blog-uuid",
        deploymentUuid: "dep-failed",
      },
    });
    fireEvent.click(screen.getByText("api"));
    expect(shell.openSingletonTab).toHaveBeenLastCalledWith("coolify", {
      data: { section: "resources", connectionId: 1, uuid: "app-api-uuid" },
    });
    // The owner with configure syncs servers; anyone else gets the Overview.
    fireEvent.click(screen.getByText("edge"));
    expect(shell.openSingletonTab).toHaveBeenLastCalledWith("coolify", {
      data: { section: "servers", connectionId: 1 },
    });
  });

  it("opens the Overview for a server without configure", async () => {
    const api = attentionApi();
    const shell = await openPanel(api, {}, ["coolify.view"]);
    fireEvent.click(await screen.findByText("edge"));
    expect(shell.openSingletonTab).toHaveBeenLastCalledWith("coolify", {
      data: { section: "overview", connectionId: 1 },
    });
  });

  it("drops a connection's rows once an answer leaves it out, and ignores a late older answer", async () => {
    const slow = deferred<unknown>();
    let call = 0;
    const api = attentionApi(() => {
      call += 1;
      if (call === 1) return ANSWER;
      if (call === 2) return slow.promise;
      // Staging is gone: no longer shared with this user.
      return { ...ANSWER, connections: [ANSWER.connections[0]], badge: 1 };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openPanel(api);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Commit of dep-failed")).toBeTruthy();
    // A refresh whose answer is slow, then the next poll overtakes it.
    fireEvent.click(screen.getByRole("button", { name: P.refresh }));
    await act(() => vi.advanceTimersByTimeAsync(PANEL_POLL_MS));
    expect(attentionReads(api)).toBe(3);
    expect(screen.queryByText("Commit of dep-failed")).toBeNull();
    await act(async () => {
      slow.resolve(ANSWER);
      await slow.promise;
    });
    expect(screen.queryByText("Commit of dep-failed")).toBeNull();
    expect(screen.getByText("Commit of dep-run")).toBeTruthy();
  });

  it("polls only while it is shown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = attentionApi();
    await openPanel(api, { active: false });
    await act(() => vi.advanceTimersByTimeAsync(PANEL_POLL_MS * 3));
    expect(attentionReads(api)).toBe(0);
  });

  it("says when a connection could not be read, and keeps the others", async () => {
    const api = attentionApi(() => ({
      ...ANSWER,
      connections: [
        ANSWER.connections[0],
        conn(2, "Staging", {
          error: { error: "Coolify did not answer", cause: "timeout" },
        }),
      ],
    }));
    await openPanel(api);
    expect(await screen.findByText("Commit of dep-run")).toBeTruthy();
    expect(screen.getByText(/Staging/)).toBeTruthy();
  });

  it("shows all clear when nothing needs a look", async () => {
    const api = attentionApi(() => ({
      connections: [conn(1, "Prod")],
      badge: 0,
    }));
    await openPanel(api);
    expect(await screen.findByText(P.empty.title)).toBeTruthy();
  });
});
