import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import { BuildLogView } from "../../../src/frontend/views/BuildLogView";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { stubApi } from "../fixtures";

const real = manifestJson as unknown as PluginManifest;
/** The plugin's manifest plus a test tab that holds BuildLogView. */
const manifest: PluginManifest = {
  ...real,
  contributes: {
    ...real.contributes,
    tabs: [
      ...(real.contributes?.tabs ?? []),
      {
        id: "build-log-harness",
        titleKey: "tab.title",
        icon: "ScrollText",
        openFrom: ["palette"],
      },
    ],
  },
};
const D = locales.deployments;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function deployment(uuid: string, status: string, extra = {}) {
  return {
    uuid,
    resourceUuid: "app-web-uuid",
    status,
    commit: "abc1234",
    commitMessage: `Commit of ${uuid}`,
    pullRequestId: 0,
    rollback: false,
    serverName: "vps1",
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: null,
    finishedAt: null,
    ...extra,
  };
}

function line(order: number, output: string, hidden = false) {
  return {
    order,
    timestamp: null,
    stream: "stdout",
    hidden,
    command: null,
    output,
  };
}

function detail(
  uuid: string,
  lines: ReturnType<typeof line>[],
  status = "in_progress",
) {
  const final = status !== "in_progress" && status !== "queued";
  return {
    deployment: deployment(uuid, status),
    log: { lines, truncated: false },
    final,
    cancellable: !final,
  };
}

const DEPLOYMENT = /\/deployments\/([^/?]+)$/;
type Answer = () => Promise<unknown>;

/** A stub whose deployment reads answer with `answers[uuid]`, in order. */
function deploymentApi(answers: Record<string, Answer[] | Answer>) {
  const api = stubApi();
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    const match = DEPLOYMENT.exec(url);
    if (!match) return fallback(url);
    const queue = answers[match[1]];
    const next = Array.isArray(queue)
      ? (queue.length > 1 ? queue.shift() : queue[0])!
      : queue;
    return { data: await next() };
  });
  return api;
}

function reads(api: ReturnType<typeof stubApi>, uuid: string): number {
  return api.get.mock.calls.filter(([url]) =>
    String(url).endsWith(`/deployments/${uuid}`),
  ).length;
}

/** The harness's controls: which deployment, shown or not, mounted or not. */
const controls = {
  setDeployment: (_uuid: string) => {},
  setVisible: (_visible: boolean) => {},
  setMounted: (_mounted: boolean) => {},
};

function Harness() {
  const [uuid, setUuid] = useState("dep-a");
  const [visible, setVisible] = useState(true);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    controls.setDeployment = setUuid;
    controls.setVisible = setVisible;
    controls.setMounted = setMounted;
  }, []);
  return mounted ? (
    <BuildLogView
      connectionId={1}
      resourceUuid="app-web-uuid"
      deploymentUuid={uuid}
      isVisible={visible}
      canCancel
    />
  ) : null;
}

/**
 * Renders the harness. With `fakeTimers`, timers are faked right after the
 * first render, before the first read answers, so every poll is counted.
 */
async function renderHarness(
  api: ReturnType<typeof stubApi>,
  opts: { fakeTimers?: boolean } = {},
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: OPERATE,
  });
  rendered.app.registerTab("build-log-harness", Harness, {
    titleKey: "tab.title",
    hostless: true,
  });
  rendered.renderTab("build-log-harness");
  if (opts.fakeTimers) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** Lets pending answers land, with timers faked. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await tick(0);
}

describe("build log view", () => {
  it("switched from A to B, never shows A's lines and ignores A's late answer", async () => {
    let releaseLate: (value: unknown) => void = () => {};
    const api = deploymentApi({
      "dep-a": [
        async () => detail("dep-a", [line(1, "A first line")]),
        () => new Promise((resolve) => (releaseLate = resolve)),
      ],
      "dep-b": async () => detail("dep-b", [line(1, "B line")]),
    });
    await renderHarness(api, { fakeTimers: true });
    await settle();
    expect(screen.getByText("A first line")).toBeTruthy();
    // The next poll of A is asked and doesn't answer yet.
    await tick(2_000);
    expect(reads(api, "dep-a")).toBe(2);

    act(() => controls.setDeployment("dep-b"));
    expect(screen.queryByText("A first line")).toBeNull();
    await settle();
    expect(screen.getByText("B line")).toBeTruthy();

    await act(async () =>
      releaseLate(detail("dep-a", [line(1, "A late line")])),
    );
    await settle();
    expect(screen.queryByText("A late line")).toBeNull();
    expect(screen.queryByText("A first line")).toBeNull();
    expect(screen.getByText("B line")).toBeTruthy();
  });

  it("polls every 2 seconds and stops on unmount", async () => {
    const api = deploymentApi({
      "dep-a": async () => detail("dep-a", [line(1, "running")]),
    });
    await renderHarness(api, { fakeTimers: true });
    await settle();
    expect(screen.getByText("running")).toBeTruthy();
    expect(reads(api, "dep-a")).toBe(1);
    await tick(2_000);
    expect(reads(api, "dep-a")).toBe(2);
    await tick(2_000);
    expect(reads(api, "dep-a")).toBe(3);

    act(() => controls.setMounted(false));
    await tick(10_000);
    expect(reads(api, "dep-a")).toBe(3);
  });

  it("stops polling while hidden and once the deployment reaches a final status", async () => {
    const api = deploymentApi({
      "dep-a": [
        async () => detail("dep-a", [line(1, "building")]),
        async () => detail("dep-a", [line(1, "building")]),
        async () => detail("dep-a", [line(1, "done")], "finished"),
      ],
    });
    await renderHarness(api, { fakeTimers: true });
    await settle();
    expect(screen.getByText("building")).toBeTruthy();
    act(() => controls.setVisible(false));
    await tick(10_000);
    expect(reads(api, "dep-a")).toBe(1);

    act(() => controls.setVisible(true));
    await settle();
    expect(reads(api, "dep-a")).toBe(2);
    await tick(2_000);
    await settle();
    expect(screen.getByText("done")).toBeTruthy();
    expect(reads(api, "dep-a")).toBe(3);
    expect(screen.getByText(D.log.ended)).toBeTruthy();
    await tick(10_000);
    expect(reads(api, "dep-a")).toBe(3);
  });

  it("hides Coolify's hidden lines until the toggle shows them", async () => {
    const api = deploymentApi({
      "dep-a": async () =>
        detail(
          "dep-a",
          [line(1, "plain line"), line(2, "hidden command line", true)],
          "finished",
        ),
    });
    await renderHarness(api);
    expect(await screen.findByText("plain line")).toBeTruthy();
    expect(screen.queryByText("hidden command line")).toBeNull();
    const toggle = screen.getByRole("button", { name: D.log.showHidden });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(await screen.findByText("hidden command line")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByText("hidden command line")).toBeNull(),
    );
  });

  it("keeps the hidden-lines toggle with the deployment it was turned on for", async () => {
    const api = deploymentApi({
      "dep-a": async () =>
        detail(
          "dep-a",
          [line(1, "a plain"), line(2, "a hidden", true)],
          "finished",
        ),
      "dep-b": async () =>
        detail(
          "dep-b",
          [line(1, "b plain"), line(2, "b hidden", true)],
          "finished",
        ),
    });
    await renderHarness(api);
    await screen.findByText("a plain");
    fireEvent.click(screen.getByRole("button", { name: D.log.showHidden }));
    expect(await screen.findByText("a hidden")).toBeTruthy();

    act(() => controls.setDeployment("dep-b"));
    expect(await screen.findByText("b plain")).toBeTruthy();
    expect(screen.queryByText("b hidden")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: D.log.showHidden })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("says when the token can't read build logs", async () => {
    const api = deploymentApi({
      "dep-a": async () => ({
        ...detail("dep-a", [], "finished"),
        log: null,
      }),
    });
    await renderHarness(api);
    expect(await screen.findByText(D.log.noAccess)).toBeTruthy();
  });

  it("cancels a running deployment only after a confirm", async () => {
    const api = deploymentApi({
      "dep-a": async () => detail("dep-a", [line(1, "running")]),
    });
    api.post.mockImplementation(async () => ({
      data: { deploymentUuid: "dep-a", status: "cancelled-by-user" },
    }));
    await renderHarness(api);
    await screen.findByText("running");
    fireEvent.click(screen.getByRole("button", { name: D.cancel }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(D.cancelConfirm.title);
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: D.cancelConfirm.confirm }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/deployments/dep-a/cancel",
        {},
      ),
    );
  });

  it.each([
    [
      "the view moved to another deployment",
      () => controls.setDeployment("dep-b"),
    ],
    ["the view was closed", () => controls.setMounted(false)],
  ])(
    "cancels nothing when %s while the confirm was open",
    async (_case, change) => {
      const api = deploymentApi({
        "dep-a": async () => detail("dep-a", [line(1, "running a")]),
        "dep-b": async () => detail("dep-b", [line(1, "running b")]),
      });
      await renderHarness(api);
      await screen.findByText("running a");
      fireEvent.click(screen.getByRole("button", { name: D.cancel }));
      const dialog = await screen.findByRole("alertdialog");
      act(() => change());
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: D.cancelConfirm.confirm,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(api.post).not.toHaveBeenCalled();
    },
  );
});

/** Opens the coolify tab, the web application and its Deployments view. */
async function openDeployments(
  api: ReturnType<typeof stubApi>,
  permissions = OPERATE,
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await screen.findByRole("button", { name: locales.nav.resources }),
  );
  fireEvent.click(
    await waitFor(() => {
      const r = document.querySelector('[data-name="web"]');
      if (!r) throw new Error("no row");
      return r;
    }),
  );
  // The detail's tab, not the side nav's Deployments section of the same name.
  fireEvent.click(
    await waitFor(() => {
      const tab = screen
        .getAllByRole("button", { name: locales.detail.tabs.deployments })
        .find((b) => !b.closest(`[aria-label="${locales.nav.label}"]`));
      if (!tab) throw new Error("no Deployments tab");
      return tab;
    }),
  );
}

function historyApi(pages: (url: string) => unknown) {
  const api = stubApi();
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (/\/deployments\?/.test(url)) return { data: pages(url) };
    const match = DEPLOYMENT.exec(url);
    if (match) return { data: detail(match[1], [line(1, "log line")]) };
    return fallback(url);
  });
  return api;
}

describe("deployment history", () => {
  it("pages through the history, ten at a time", async () => {
    const api = historyApi((url) => {
      const skip = Number(new URL(url, "http://x").searchParams.get("skip"));
      const rows = Array.from({ length: skip === 0 ? 10 : 3 }, (_, i) =>
        deployment(`dep-${skip + i}`, "finished"),
      );
      return { rows, count: 13, skip, take: 10 };
    });
    await openDeployments(api);
    expect(await screen.findByText("Commit of dep-0")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/deployments?skip=0&take=10",
    );
    fireEvent.click(screen.getByRole("button", { name: /next|older/i }));
    expect(await screen.findByText("Commit of dep-10")).toBeTruthy();
    expect(screen.queryByText("Commit of dep-0")).toBeNull();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/deployments?skip=10&take=10",
    );
  });

  it("opens a deployment's build log from its row", async () => {
    const api = historyApi(() => ({
      rows: [deployment("dep-0", "in_progress")],
      count: 1,
      skip: 0,
      take: 10,
    }));
    await openDeployments(api);
    fireEvent.click(await screen.findByText("Commit of dep-0"));
    expect(await screen.findByText("log line")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: D.back }));
    expect(await screen.findByText("Commit of dep-0")).toBeTruthy();
  });

  it("shows the empty and the error state", async () => {
    await openDeployments(
      historyApi(() => ({ rows: [], count: 0, skip: 0, take: 10 })),
    );
    expect(await screen.findByText(D.empty)).toBeTruthy();
    await rendered?.deactivate();
    rendered = null;
    document.body.innerHTML = "";

    await openDeployments(
      historyApi(() => {
        throw Object.assign(new Error("boom"), {
          response: { data: { error: "x", cause: "unreachable" } },
        });
      }),
    );
    expect(await screen.findByText(D.failed)).toBeTruthy();
    expect(screen.getByRole("button", { name: D.retry })).toBeTruthy();
  });

  it("shows the history without operate, but opens no build log", async () => {
    const api = historyApi(() => ({
      rows: [deployment("dep-0", "finished")],
      count: 1,
      skip: 0,
      take: 10,
    }));
    await openDeployments(api, ["coolify.view"]);
    expect(screen.queryByText(D.noLogAccess)).toBeTruthy();
    // Without operate, a row doesn't open a build log.
    fireEvent.click(await screen.findByText("Commit of dep-0"));
    await new Promise((r) => setTimeout(r, 50));
    expect(
      api.get.mock.calls.filter(([url]) => DEPLOYMENT.test(String(url))),
    ).toEqual([]);
    expect(screen.getByText("Commit of dep-0")).toBeTruthy();
  });
});
