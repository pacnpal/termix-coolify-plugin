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
import type { Resource } from "../../../src/frontend/api";
import { PreviewsTab } from "../../../src/frontend/views/PreviewsTab";
import {
  detailTabs,
  DETAIL_TABS,
} from "../../../src/frontend/views/ResourceDetail";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { resourceRows, stubApi } from "../fixtures";

const real = manifestJson as unknown as PluginManifest;
/** The plugin's manifest plus a test tab that holds PreviewsTab. */
const manifest: PluginManifest = {
  ...real,
  contributes: {
    ...real.contributes,
    tabs: [
      ...(real.contributes?.tabs ?? []),
      {
        id: "previews-harness",
        titleKey: "tab.title",
        icon: "GitPullRequest",
        openFrom: ["palette"],
      },
    ],
  },
};
const P = locales.previews;
const OPERATE = ["coolify.view", "coolify.operate"];

const web = resourceRows.find((r) => r.uuid === "app-web-uuid") as Resource;
const api_ = resourceRows.find((r) => r.uuid === "app-api-uuid") as Resource;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function preview(pullRequestId: number, extra: Record<string, unknown> = {}) {
  return {
    pullRequestId,
    uuid: `prev-${pullRequestId}-uuid`,
    pullRequestUrl: `https://github.com/acme/web/pull/${pullRequestId}`,
    gitType: "github",
    status: "running:healthy",
    domains: [`https://pr-${pullRequestId}.example.test`],
    composeDomains: [],
    dockerTag: null,
    lastOnlineAt: null,
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: null,
    deploymentUuid: `dep-pr${pullRequestId}`,
    deploymentStatus: "finished",
    ...extra,
  };
}

const LIST = /\/resources\/([^/]+)\/previews$/;
type Answer = () => Promise<unknown>;

/** A stub whose preview lists answer with `answers[uuid]`, in order. */
function previewApi(answers: Record<string, Answer[] | Answer>) {
  const api = stubApi();
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    const match = LIST.exec(url);
    if (!match) {
      if (/\/previews\/\d+\/logs/.test(url)) {
        return { data: { pullRequestId: 42, text: "preview log line" } };
      }
      if (/\/deployments\/[^/]+$/.test(url)) {
        return {
          data: {
            deployment: {
              uuid: "dep-pr42",
              resourceUuid: "app-web-uuid",
              status: "finished",
              commit: null,
              commitMessage: null,
              pullRequestId: 42,
              rollback: false,
              serverName: null,
              createdAt: "2026-11-19T10:00:00.000Z",
              updatedAt: null,
              finishedAt: null,
            },
            log: {
              lines: [
                {
                  order: 1,
                  timestamp: null,
                  stream: "stdout",
                  hidden: false,
                  command: null,
                  output: "preview build line",
                },
              ],
              truncated: false,
            },
            final: true,
            cancellable: false,
          },
        };
      }
      return fallback(url);
    }
    const queue = answers[match[1]];
    const next = Array.isArray(queue)
      ? (queue.length > 1 ? queue.shift() : queue[0])!
      : queue;
    return { data: await next() };
  });
  return api;
}

/** The harness's controls: which resource, and mounted or not. */
const controls = {
  setResource: (_r: Resource) => {},
  setMounted: (_mounted: boolean) => {},
};

function Harness() {
  const [resource, setResource] = useState<Resource>(web);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    controls.setResource = setResource;
    controls.setMounted = setMounted;
  }, []);
  return mounted ? (
    <PreviewsTab connectionId={1} resource={resource} canOperate />
  ) : null;
}

async function renderHarness(
  api: ReturnType<typeof stubApi>,
  permissions = OPERATE,
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.app.registerTab("previews-harness", Harness, {
    titleKey: "tab.title",
    hostless: true,
  });
  rendered.renderTab("previews-harness");
}

const two = { "app-web-uuid": async () => ({ rows: [preview(42)] }) };

function rowOf(id: number): HTMLElement {
  return screen
    .getByText(P.title.replace("{{id}}", String(id)))
    .closest("[data-preview]") as HTMLElement;
}

describe("previews tab", () => {
  it("lists an application's previews with their domains", async () => {
    const api = previewApi({
      "app-web-uuid": async () => ({
        rows: [preview(42), preview(7, { status: "exited" })],
      }),
    });
    await renderHarness(api);
    expect(await screen.findByText("Pull request #42")).toBeTruthy();
    expect(screen.getByText("Pull request #7")).toBeTruthy();
    expect(screen.getByText("https://pr-42.example.test")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/previews",
    );
  });

  it("switched from app A to app B, never shows A's previews and ignores A's late answer", async () => {
    let releaseA: (value: unknown) => void = () => {};
    const api = previewApi({
      "app-web-uuid": () => new Promise((resolve) => (releaseA = resolve)),
      "app-api-uuid": async () => ({ rows: [preview(99)] }),
    });
    await renderHarness(api);
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/previews",
      ),
    );
    act(() => controls.setResource(api_));
    expect(await screen.findByText("Pull request #99")).toBeTruthy();
    await act(async () => releaseA({ rows: [preview(42)] }));
    await act(async () => {});
    expect(screen.queryByText("Pull request #42")).toBeNull();
    expect(screen.getByText("Pull request #99")).toBeTruthy();
  });

  it("drops A's previews the moment B is chosen", async () => {
    const api = previewApi({
      "app-web-uuid": async () => ({ rows: [preview(42)] }),
      "app-api-uuid": () => new Promise(() => {}),
    });
    await renderHarness(api);
    expect(await screen.findByText("Pull request #42")).toBeTruthy();
    act(() => controls.setResource(api_));
    expect(screen.queryByText("Pull request #42")).toBeNull();
  });

  it("says when the connected Coolify has no preview API", async () => {
    const api = previewApi({
      "app-web-uuid": async () => {
        throw Object.assign(new Error("old"), {
          response: {
            status: 409,
            data: { error: "x", cause: "unsupported-by-instance" },
          },
        });
      },
    });
    await renderHarness(api);
    expect(await screen.findByText(P.unsupported)).toBeTruthy();
  });

  it("deletes a preview only after a destructive confirm", async () => {
    const api = previewApi(two);
    api.delete.mockImplementation(async () => ({
      data: { pullRequestId: 42 },
    }));
    await renderHarness(api);
    await screen.findByText("Pull request #42");
    fireEvent.click(
      within(rowOf(42)).getByRole("button", { name: P.delete.action }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      P.delete.confirm.title.replace("{{id}}", "42"),
    );
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: P.delete.confirm.confirm }),
    );
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/previews/42",
      ),
    );
  });

  it("sends nothing when the view moves to another app while the confirm is open", async () => {
    const api = previewApi({
      ...two,
      "app-api-uuid": async () => ({ rows: [preview(99)] }),
    });
    await renderHarness(api);
    await screen.findByText("Pull request #42");
    fireEvent.click(
      within(rowOf(42)).getByRole("button", { name: P.delete.action }),
    );
    const dialog = await screen.findByRole("alertdialog");
    act(() => controls.setResource(api_));
    await screen.findByText("Pull request #99");
    fireEvent.click(
      within(dialog).getByRole("button", { name: P.delete.confirm.confirm }),
    );
    await act(async () => {});
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("sends nothing when the view unmounts while the confirm is open", async () => {
    const api = previewApi(two);
    await renderHarness(api);
    await screen.findByText("Pull request #42");
    fireEvent.click(
      within(rowOf(42)).getByRole("button", { name: P.delete.action }),
    );
    const dialog = await screen.findByRole("alertdialog");
    act(() => controls.setMounted(false));
    fireEvent.click(
      within(dialog).getByRole("button", { name: P.delete.confirm.confirm }),
    );
    await act(async () => {});
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("refuses invalid domains before any request or confirm", async () => {
    const api = previewApi(two);
    await renderHarness(api);
    await screen.findByText("Pull request #42");
    fireEvent.click(
      within(rowOf(42)).getByRole("button", { name: P.domains.edit }),
    );
    const input = screen.getByLabelText(
      P.domains.label.replace("{{id}}", "42"),
    );
    fireEvent.change(input, { target: { value: "pr-42.example.test" } });
    fireEvent.click(screen.getByRole("button", { name: P.domains.save }));
    expect(await screen.findByText(P.domains.errors.scheme)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("changes domains after a confirm", async () => {
    const api = previewApi(two);
    api.patch.mockImplementation(async () => ({
      data: { pullRequestId: 42, domains: "https://new.example.test" },
    }));
    await renderHarness(api);
    await screen.findByText("Pull request #42");
    fireEvent.click(
      within(rowOf(42)).getByRole("button", { name: P.domains.edit }),
    );
    fireEvent.change(
      screen.getByLabelText(P.domains.label.replace("{{id}}", "42")),
      { target: { value: "https://New.example.test" } },
    );
    fireEvent.click(screen.getByRole("button", { name: P.domains.save }));
    const dialog = await screen.findByRole("alertdialog");
    expect(api.patch).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: P.domains.confirm.confirm }),
    );
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/previews/42",
        { domains: "https://new.example.test" },
      ),
    );
  });

  it("deploys a preview for a pull request after a confirm", async () => {
    const api = previewApi(two);
    api.post.mockImplementation(async () => ({
      data: { pullRequestId: 51, deploymentUuid: "dep-pr51" },
    }));
    await renderHarness(api);
    await screen.findByText("Pull request #42");
    fireEvent.click(screen.getByRole("button", { name: P.create.open }));
    fireEvent.change(screen.getByLabelText(P.create.pullRequestId), {
      target: { value: "51" },
    });
    fireEvent.click(screen.getByRole("button", { name: P.create.submit }));
    const dialog = await screen.findByRole("alertdialog");
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: P.create.confirm.confirm }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/previews",
        { pullRequestId: 51 },
      ),
    );
  });

  it("opens a preview's build log and its container logs", async () => {
    const api = previewApi(two);
    await renderHarness(api);
    await screen.findByText("Pull request #42");
    fireEvent.click(
      within(rowOf(42)).getByRole("button", { name: P.buildLog }),
    );
    expect(await screen.findByText("preview build line")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/deployments/dep-pr42",
    );
    fireEvent.click(screen.getByRole("button", { name: P.back }));
    await screen.findByText("Pull request #42");
    fireEvent.click(
      within(rowOf(42)).getByRole("button", { name: P.logs.action }),
    );
    expect(await screen.findByText("preview log line")).toBeTruthy();
  });

  it("without operate, lists previews but offers no changes", async () => {
    const api = previewApi(two);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    function ViewOnly() {
      return <PreviewsTab connectionId={1} resource={web} canOperate={false} />;
    }
    rendered.app.registerTab("previews-harness", ViewOnly, {
      titleKey: "tab.title",
      hostless: true,
    });
    rendered.renderTab("previews-harness");
    await screen.findByText("Pull request #42");
    expect(screen.queryByRole("button", { name: P.delete.action })).toBeNull();
    expect(screen.queryByRole("button", { name: P.create.open })).toBeNull();
    expect(screen.getByText(P.noAccess)).toBeTruthy();
  });
});

describe("the Previews tab in resource detail", () => {
  it("is offered for applications only", () => {
    expect(DETAIL_TABS).toContain("previews");
    expect(detailTabs(web, true)).toContain("previews");
    expect(detailTabs(web, false)).toContain("previews");
    for (const uuid of [
      "svc-n8n-uuid",
      "part-n8n-uuid",
      "part-postgres-uuid",
      "db-main-uuid",
    ]) {
      const r = resourceRows.find((x) => x.uuid === uuid) as Resource;
      expect(detailTabs(r, true), uuid).not.toContain("previews");
    }
  });

  it("a database's detail shows no Previews tab", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(),
      permissions: OPERATE,
    });
    const tab = rendered.renderTab("coolify", { isVisible: true });
    fireEvent.click(
      await within(tab).findByRole("button", { name: locales.nav.resources }),
    );
    await within(tab).findByText("web");
    fireEvent.click(
      within(tab)
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-name") === "main-db")!,
    );
    await screen.findByText(locales.detail.fields.coolifyStatus);
    expect(
      screen.queryByRole("button", { name: locales.detail.tabs.previews }),
    ).toBeNull();
    // The tab strip is there; it just has no Previews tab.
    expect(
      screen.getByRole("button", { name: locales.detail.tabs.shell }),
    ).toBeTruthy();
  });
});
