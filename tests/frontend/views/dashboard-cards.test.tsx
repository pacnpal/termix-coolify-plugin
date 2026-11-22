import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { RenderedPluginApp } from "@termix-ssh/plugin-sdk/testing";
import { PluginComponent, SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import {
  CardView,
  type CardViewProps,
} from "../../../src/frontend/views/dashboard/CoolifyCards";
import { CARD_POLL_MS } from "../../../src/shared/dashboard";
import locales from "../../../locales/en.json";
import { renderApp, stubClient } from "../helpers";
import { connection, queueRow, resourceAnswer } from "../fixtures";

const D = locales.dashboard;
const VIEW = ["coolify.view"];
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;
let draws = 0;

afterEach(async () => {
  vi.useRealTimers();
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

const OVERVIEW = {
  connectionId: 1,
  counts: { running: 3, degraded: 1, stopped: 1, deploying: 1 },
  total: 6,
  servers: { total: 2, unreachable: 1, unusable: 1 },
  fetchedAt: "2026-11-22T10:00:00.000Z",
};

const VULNERABILITIES = {
  connectionId: 1,
  resources: 5,
  affected: 3,
  statuses: {
    updateNow: 1,
    updateAvailable: 1,
    noFix: 1,
    checkNeeded: 0,
    ok: 1,
    notChecked: 1,
  },
  problems: { total: 10, critical: 2, high: 4, medium: 4, exploited: 1 },
  fetchedAt: "2026-11-22T10:00:00.000Z",
};

const QUEUE = {
  running: [
    queueRow("dep-run", "in_progress", { uuid: "app-web-uuid", name: "web" }),
  ],
  recent: [],
  fetchedAt: "2026-11-22T10:00:00.000Z",
};

type Answers = Record<string, () => unknown>;

/** A client answering each GET path from `answers`, else the connection. */
function client(answers: Answers = {}) {
  const table: Answers = {
    "/connections": () => [connection, { ...connection, id: 2, name: "Lab" }],
    "/connections/1": () => connection,
    "/connections/2": () => ({ ...connection, id: 2, name: "Lab" }),
    "/connections/1/overview": () => OVERVIEW,
    "/connections/2/overview": () => ({
      ...OVERVIEW,
      connectionId: 2,
      counts: { running: 9, degraded: 0, stopped: 0, deploying: 0 },
      total: 9,
      servers: { total: 4, unreachable: 0, unusable: 0 },
    }),
    "/connections/1/resources": () => resourceAnswer,
    "/connections/1/deployments": () => QUEUE,
    "/connections/1/vulnerabilities": () => VULNERABILITIES,
    ...answers,
  };
  return stubClient({
    get: async (url: string) => {
      const answer = table[url.replace(/\?.*$/, "")];
      if (!answer) throw new Error(`unexpected GET ${url}`);
      return { data: await answer() };
    },
    post: async () => ({ data: { deploymentUuid: "dep-new" } }),
  });
}

const reads = (api: ReturnType<typeof client>, path: string) =>
  api.get.mock.calls.filter(
    ([url]) => String(url).replace(/\?.*$/, "") === path,
  ).length;

/** Draws `component` in the plugin's scope, so its SDK hooks work. */
function draw<P>(component: ComponentType<P>, props: P) {
  const id = `coolify.card-under-test-${++draws}`;
  rendered!.app.registerComponent(
    id,
    component as unknown as ComponentType<Record<string, unknown>>,
  );
  const tree = (next: P) => (
    <SurfaceScope>
      <PluginComponent id={id} {...(next as Record<string, unknown>)} />
    </SurfaceScope>
  );
  const view = render(tree(props));
  return {
    view,
    rerender: (next: P) => view.rerender(tree(next)),
    close: () => view.rerender(<SurfaceScope>{null}</SurfaceScope>),
  };
}

async function card(
  props: Partial<CardViewProps> & Pick<CardViewProps, "kind">,
  options: { api?: ReturnType<typeof client>; permissions?: string[] } = {},
) {
  const api = options.api ?? client();
  rendered = await renderApp(api, options.permissions ?? VIEW);
  const drawn = draw(CardView, {
    config: { connectionId: 1 },
    active: true,
    ...props,
  } as CardViewProps);
  return { api, ...drawn };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const failure = (status: number, cause: string) =>
  Object.assign(new Error(cause), {
    response: { status, data: { error: "fixed words", cause } },
  });

describe("the connection overview card", () => {
  it("shows loading, then resource counts and servers from one read", async () => {
    const pending = deferred<unknown>();
    const api = client({ "/connections/1/overview": () => pending.promise });
    const { view } = await card({ kind: "overview" }, { api });
    expect(await within(view.container).findByText(D.loading)).toBeTruthy();
    pending.resolve(OVERVIEW);
    expect(
      await within(view.container).findByText(locales.overview.tiles.degraded),
    ).toBeTruthy();
    expect(view.container.textContent).toContain("2 servers, 1 unreachable");
    // The overview route reads the shared caches; nothing per resource.
    expect(reads(api, "/connections/1/overview")).toBe(1);
    expect(reads(api, "/connections/1/resources")).toBe(0);
  });

  it("says so when the connection has no resources", async () => {
    const api = client({
      "/connections/1/overview": () => ({
        ...OVERVIEW,
        counts: { running: 0, degraded: 0, stopped: 0, deploying: 0 },
        total: 0,
      }),
    });
    const { view } = await card({ kind: "overview" }, { api });
    expect(
      await within(view.container).findByText(D.overview.empty),
    ).toBeTruthy();
  });

  it("shows an error when the read fails", async () => {
    const api = client({
      "/connections/1/overview": () => {
        throw failure(502, "unreachable");
      },
    });
    const { view } = await card({ kind: "overview" }, { api });
    // The cause's words, with its fix when it has one.
    await waitFor(() =>
      expect(view.container.textContent).toContain(locales.causes.unreachable),
    );
    // Only the plugin's own words for the cause, never the backend's text.
    expect(view.container.textContent).not.toContain("fixed words");
  });

  it("shows no access without coolify.view and asks for nothing", async () => {
    const { view, api } = await card({ kind: "overview" }, { permissions: [] });
    expect(
      await within(view.container).findByText(D.noPermission),
    ).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows no access for a connection the user can't open", async () => {
    const api = client({
      "/connections/1": () => {
        throw failure(404, "not-found");
      },
    });
    const { view } = await card({ kind: "overview" }, { api });
    expect(await within(view.container).findByText(D.noAccess)).toBeTruthy();
    expect(reads(api, "/connections/1/overview")).toBe(0);
  });

  it("reads again only when the cache has turned over, and only while shown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { api, rerender } = await card({ kind: "overview" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reads(api, "/connections/1/overview")).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(CARD_POLL_MS.overview - 1));
    expect(reads(api, "/connections/1/overview")).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(reads(api, "/connections/1/overview")).toBe(2);
    rerender({
      kind: "overview",
      config: { connectionId: 1 },
      active: false,
    });
    await act(() => vi.advanceTimersByTimeAsync(CARD_POLL_MS.overview * 5));
    expect(reads(api, "/connections/1/overview")).toBe(2);
  });

  it("drops an answer for the connection it was switched away from", async () => {
    const slow = deferred<unknown>();
    const api = client({ "/connections/1/overview": () => slow.promise });
    const { view, rerender } = await card({ kind: "overview" }, { api });
    await waitFor(() => expect(reads(api, "/connections/1/overview")).toBe(1));
    rerender({ kind: "overview", config: { connectionId: 2 }, active: true });
    expect(await within(view.container).findByText("9")).toBeTruthy();
    slow.resolve(OVERVIEW);
    await act(async () => {});
    expect(view.container.textContent).toContain("4 servers, 0 unreachable");
    expect(view.container.textContent).not.toContain("2 servers, 1");
  });
});

describe("the single resource card", () => {
  const config = { connectionId: 1, uuid: "app-web-uuid" };

  it("shows the resource's status, and no Deploy button to a view-only user", async () => {
    const { view } = await card({ kind: "resource", config });
    expect(await within(view.container).findByText("web")).toBeTruthy();
    expect(
      within(view.container).queryByRole("button", {
        name: D.resource.deploy,
      }),
    ).toBeNull();
  });

  it("has no Deploy button on a view grant, even with coolify.operate", async () => {
    const api = client({
      "/connections/1": () => ({ ...connection, access: "view" }),
    });
    const { view } = await card(
      { kind: "resource", config },
      { api, permissions: OPERATE },
    );
    expect(await within(view.container).findByText("web")).toBeTruthy();
    expect(
      within(view.container).queryByRole("button", {
        name: D.resource.deploy,
      }),
    ).toBeNull();
  });

  it("deploys after a confirm, through the lifecycle route", async () => {
    const { view, api } = await card(
      { kind: "resource", config },
      { permissions: OPERATE },
    );
    fireEvent.click(
      await within(view.container).findByRole("button", {
        name: D.resource.deploy,
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: D.resource.deployConfirm.confirm,
      }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/deploy",
        { force: false },
      ),
    );
  });

  it("does nothing when the confirm is accepted after the card's target changed", async () => {
    const { view, api, rerender } = await card(
      { kind: "resource", config },
      { permissions: OPERATE },
    );
    fireEvent.click(
      await within(view.container).findByRole("button", {
        name: D.resource.deploy,
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    rerender({
      kind: "resource",
      config: { connectionId: 1, uuid: "app-api-uuid" },
      active: true,
    });
    await within(view.container).findByText("api");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: D.resource.deployConfirm.confirm,
      }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says so when the resource is gone from Coolify", async () => {
    const { view } = await card({
      kind: "resource",
      config: { connectionId: 1, uuid: "app-gone-uuid" },
    });
    expect(
      await within(view.container).findByText(D.resource.gone),
    ).toBeTruthy();
  });
});

describe("the deployments card", () => {
  it("lists deployments in progress", async () => {
    const { view } = await card({ kind: "deployments" });
    expect(
      await within(view.container).findByText("Commit of dep-run"),
    ).toBeTruthy();
  });

  it("says so when nothing is deploying", async () => {
    const api = client({
      "/connections/1/deployments": () => ({ ...QUEUE, running: [] }),
    });
    const { view } = await card({ kind: "deployments" }, { api });
    expect(
      await within(view.container).findByText(D.deployments.empty),
    ).toBeTruthy();
  });
});

describe("the vulnerabilities card", () => {
  it("shows how many resources are affected, with a link to Coolify", async () => {
    const { view } = await card({ kind: "vulnerabilities" });
    expect(await within(view.container).findByText("3")).toBeTruthy();
    expect(view.container.textContent).toContain("2 critical, 4 high");
    const link = within(view.container).getByRole("link", {
      name: D.vulnerabilities.open,
    });
    expect(link.getAttribute("href")).toBe(connection.baseUrl);
  });

  it("says so when nothing has known vulnerabilities", async () => {
    const api = client({
      "/connections/1/vulnerabilities": () => ({
        ...VULNERABILITIES,
        affected: 0,
      }),
    });
    const { view } = await card({ kind: "vulnerabilities" }, { api });
    expect(
      await within(view.container).findByText(D.vulnerabilities.empty),
    ).toBeTruthy();
  });
});

describe.each([
  ["overview", "/connections/1/overview", { connectionId: 1 }],
  [
    "resource",
    "/connections/1/resources",
    { connectionId: 1, uuid: "app-web-uuid" },
  ],
  ["deployments", "/connections/1/deployments", { connectionId: 1 }],
  ["vulnerabilities", "/connections/1/vulnerabilities", { connectionId: 1 }],
] as const)("every card's states: %s", (kind, path, config) => {
  it("shows loading until its first answer", async () => {
    const pending = deferred<unknown>();
    const api = client({ [path]: () => pending.promise });
    const { view } = await card({ kind, config }, { api });
    expect(await within(view.container).findByText(D.loading)).toBeTruthy();
  });

  it("shows the cause when its read fails", async () => {
    const api = client({
      [path]: () => {
        throw failure(502, "unreachable");
      },
    });
    const { view } = await card({ kind, config }, { api });
    await waitFor(() =>
      expect(view.container.textContent).toContain(locales.causes.unreachable),
    );
  });

  it("shows no access, and reads nothing, for a connection it can't open", async () => {
    const api = client({
      "/connections/1": () => {
        throw failure(404, "not-found");
      },
    });
    const { view } = await card({ kind, config }, { api });
    expect(await within(view.container).findByText(D.noAccess)).toBeTruthy();
    expect(reads(api, path)).toBe(0);
  });

  it("shows no access without coolify.view", async () => {
    const { view, api } = await card({ kind, config }, { permissions: [] });
    expect(
      await within(view.container).findByText(D.noPermission),
    ).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("a card's own settings", () => {
  it("asks for a connection, then a resource, and saves them", async () => {
    const setConfig = vi.fn();
    const { view, rerender } = await card({
      kind: "resource",
      config: {},
      setConfig,
    });
    fireEvent.click(await within(view.container).findByText("Lab"));
    expect(setConfig).toHaveBeenLastCalledWith({
      card: "resource",
      connectionId: 2,
      uuid: null,
    });
    rerender({
      kind: "resource",
      config: { connectionId: 1 },
      setConfig,
      active: true,
    });
    fireEvent.click(await within(view.container).findByText("web"));
    expect(setConfig).toHaveBeenLastCalledWith({
      card: "resource",
      connectionId: 1,
      uuid: "app-web-uuid",
    });
  });

  it("tells the user to pick one when it can't save settings itself", async () => {
    const { view, api } = await card({ kind: "overview", config: {} });
    expect(await within(view.container).findByText(D.pickHint)).toBeTruthy();
    expect(reads(api, "/connections")).toBe(0);
  });
});

describe("registration", () => {
  it("adds one dashboard card with an entry per card, and four homepage widgets", async () => {
    rendered = await renderApp(client(), VIEW);
    expect(rendered.registered.dashboardCards()).toEqual(
      expect.arrayContaining([expect.stringMatching(/coolify$/)]),
    );
    expect(rendered.registered.extensions("homepage.widgets")).toEqual([
      "coolify.overview",
      "coolify.resource",
      "coolify.deployments",
      "coolify.vulnerabilities",
    ]);
  });

  it("draws a homepage widget from its own config", async () => {
    const api = client();
    rendered = await renderApp(api, VIEW);
    const element = rendered.renderExtension(
      "homepage.widgets",
      "coolify.overview",
      "view",
      {
        widget: {
          id: "w1",
          typeId: "coolify.overview",
          title: null,
          config: {},
        },
        config: { connectionId: 1 },
      },
    );
    expect(
      await within(element).findByText(locales.overview.tiles.degraded),
    ).toBeTruthy();
  });

  it("lets a homepage widget pick its connection in its edit form", async () => {
    rendered = await renderApp(client(), VIEW);
    const onChange = vi.fn();
    const element = rendered.renderExtension(
      "homepage.widgets",
      "coolify.deployments",
      "editForm",
      { config: {}, onChange },
    );
    fireEvent.click(await within(element).findByText("Prod"));
    expect(onChange).toHaveBeenLastCalledWith({
      card: "deployments",
      connectionId: 1,
      uuid: null,
    });
  });
});
