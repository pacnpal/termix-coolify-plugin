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
import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import { CoolifyTab } from "../../../src/frontend/views/CoolifyTab";
import { QUEUE_POLL_MS } from "../../../src/frontend/views/useDeploymentQueue";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { connection, stubApi } from "../fixtures";

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
const S = locales.deploymentsSection;
const T = locales.deployByTag;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function row(
  uuid: string,
  status: string,
  app: { uuid: string; name: string },
  minute = 0,
) {
  return {
    uuid,
    resourceUuid: app.uuid,
    resourceName: app.name,
    status,
    commit: "abc1234",
    commitMessage: `Commit of ${uuid}`,
    pullRequestId: 0,
    rollback: false,
    serverName: "vps1",
    createdAt: `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`,
    updatedAt: null,
    finishedAt: null,
  };
}

const WEB = { uuid: "app-web-uuid", name: "web" };
const API = { uuid: "app-api-uuid", name: "api" };

const QUEUE = {
  running: [row("dep-a", "in_progress", WEB, 30)],
  recent: [row("dep-b", "finished", API, 20)],
  fetchedAt: "2026-11-19T10:31:00.000Z",
};

function detail(uuid: string, app: { uuid: string }, output: string) {
  return {
    deployment: { ...row(uuid, "in_progress", WEB), resourceUuid: app.uuid },
    log: {
      lines: [
        {
          order: 1,
          timestamp: null,
          stream: "stdout",
          hidden: false,
          command: null,
          output,
        },
      ],
      truncated: false,
    },
    final: false,
    cancellable: true,
  };
}

const TARGETS = {
  tag: "prod",
  targets: [
    {
      uuid: "app-web-uuid",
      name: "web",
      kind: "application",
      serverName: "vps1",
    },
    { uuid: "svc-n8n-uuid", name: "n8n", kind: "service", serverName: "vps1" },
  ],
  skippedServices: 0,
};

const QUEUE_URL = /^\/connections\/(\d+)\/deployments(\?refresh=1)?$/;
const DETAIL_URL = /\/resources\/([^/]+)\/deployments\/([^/?]+)$/;

/** A stub with the queue, tag preview and deployment reads routed. */
function sectionApi(
  opts: {
    connections?: unknown[];
    details?: Record<string, () => Promise<unknown>>;
  } = {},
) {
  const api = stubApi({ connections: opts.connections });
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (QUEUE_URL.test(url)) return { data: QUEUE };
    if (url.includes("/deploy-by-tag?")) return { data: TARGETS };
    const match = DETAIL_URL.exec(url);
    if (match) {
      const read = opts.details?.[match[2]];
      if (read) return { data: await read() };
    }
    return fallback(url);
  });
  api.post.mockImplementation(async () => ({
    data: { ...TARGETS, deployments: [] },
  }));
  return api;
}

const queueReads = (api: ReturnType<typeof stubApi>) =>
  api.get.mock.calls.filter(([url]) => QUEUE_URL.test(String(url))).length;

async function openTab(api: ReturnType<typeof stubApi>, permissions = OPERATE) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.renderTab("coolify", { isVisible: true });
  await screen.findByRole("button", { name: locales.nav.deployments });
}

function openSection() {
  fireEvent.click(
    screen.getByRole("button", { name: locales.nav.deployments }),
  );
}

describe("deployments section", () => {
  it("one cached read serves the Overview and the section", async () => {
    const api = sectionApi();
    await openTab(api);
    // The Overview lists what is in progress.
    const overview = await screen.findByText(locales.overview.inProgress.title);
    expect(overview).toBeTruthy();
    expect(await screen.findByText("Commit of dep-a")).toBeTruthy();
    expect(queueReads(api)).toBe(1);
    openSection();
    expect(await screen.findByText(S.running)).toBeTruthy();
    expect(screen.getByText("Commit of dep-a")).toBeTruthy();
    expect(screen.getByText("Commit of dep-b")).toBeTruthy();
    expect(queueReads(api)).toBe(1);
  });

  it("polls only while the tab is shown", async () => {
    const api = sectionApi();
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
    // Faked before the first read answers, so every poll is counted.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let i = 0; i < 10; i += 1) {
      await act(() => vi.advanceTimersByTimeAsync(0));
    }
    expect(screen.getByText("Commit of dep-a")).toBeTruthy();
    expect(queueReads(api)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(QUEUE_POLL_MS));
    expect(queueReads(api)).toBe(2);

    act(() => setVisible(false));
    await act(() => vi.advanceTimersByTimeAsync(QUEUE_POLL_MS * 6));
    expect(queueReads(api)).toBe(2);

    act(() => setVisible(true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(queueReads(api)).toBe(3);
  });

  it("opens the right deployment's build log and never shows a previous one's lines", async () => {
    let releaseB: (value: unknown) => void = () => {};
    const api = sectionApi({
      details: {
        "dep-a": async () => detail("dep-a", WEB, "A build line"),
        "dep-b": () => new Promise((resolve) => (releaseB = resolve)),
      },
    });
    await openTab(api);
    openSection();
    fireEvent.click(await screen.findByText("Commit of dep-a"));
    expect(await screen.findByText("A build line")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/deployments/dep-a",
    );
    fireEvent.click(screen.getByRole("button", { name: S.back }));
    fireEvent.click(await screen.findByText("Commit of dep-b"));
    // B's log is still loading: nothing of A's shows meanwhile.
    expect(screen.queryByText("A build line")).toBeNull();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-api-uuid/deployments/dep-b",
    );
    await act(async () => releaseB(detail("dep-b", API, "B build line")));
    expect(await screen.findByText("B build line")).toBeTruthy();
    expect(screen.queryByText("A build line")).toBeNull();
  });

  it("opens no build log without operate", async () => {
    const api = sectionApi();
    await openTab(api, ["coolify.view"]);
    openSection();
    fireEvent.click(await screen.findByText("Commit of dep-a"));
    expect(screen.queryByRole("button", { name: S.back })).toBeNull();
    expect(screen.queryByRole("button", { name: T.open })).toBeNull();
  });
});

/** Fills the deploy by tag form and asks for its review. */
async function review(tag = "prod") {
  openSection();
  fireEvent.click(await screen.findByRole("button", { name: T.open }));
  fireEvent.change(screen.getByPlaceholderText(T.tagPlaceholder), {
    target: { value: tag },
  });
  fireEvent.click(screen.getByRole("button", { name: T.review }));
  return screen.findByRole("alertdialog");
}

describe("deploy by tag", () => {
  it("lists the resources it will deploy in the confirm, then deploys exactly those", async () => {
    const api = sectionApi();
    await openTab(api);
    const dialog = await review();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/deploy-by-tag?tag=prod",
    );
    expect(within(dialog).getByText(/web/)).toBeTruthy();
    expect(within(dialog).getByText(/n8n/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: T.confirm.confirm }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/deploy-by-tag", {
        tag: "prod",
        force: false,
        targets: ["app-web-uuid", "svc-n8n-uuid"],
      }),
    );
  });

  it("sends nothing when the view moves on while the confirm is open", async () => {
    const api = sectionApi();
    await openTab(api);
    const dialog = await review();
    // Another section: the form is gone.
    fireEvent.click(screen.getByRole("button", { name: locales.nav.overview }));
    const confirm = within(dialog).queryByRole("button", {
      name: T.confirm.confirm,
    });
    if (confirm) fireEvent.click(confirm);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("sends nothing when the connection changes while the confirm is open", async () => {
    const api = sectionApi({
      connections: [connection, { ...connection, id: 2, name: "Staging" }],
    });
    await openTab(api);
    const dialog = await review();
    Element.prototype.scrollIntoView = () => {};
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: locales.picker.label }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "Staging" }));
    const confirm = within(dialog).queryByRole("button", {
      name: T.confirm.confirm,
    });
    if (confirm) fireEvent.click(confirm);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refuses a Docker tag without a pull request before asking anything", async () => {
    const api = sectionApi();
    await openTab(api);
    openSection();
    fireEvent.click(await screen.findByRole("button", { name: T.open }));
    fireEvent.change(screen.getByPlaceholderText(T.tagPlaceholder), {
      target: { value: "prod" },
    });
    fireEvent.change(screen.getByPlaceholderText(T.dockerTagPlaceholder), {
      target: { value: "pr-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: T.review }));
    expect(await screen.findByText(T.needsPr)).toBeTruthy();
    expect(
      api.get.mock.calls.some(([u]) => String(u).includes("deploy-by-tag")),
    ).toBe(false);
  });
});
