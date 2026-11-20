import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import { CoolifyTab } from "../../../src/frontend/views/CoolifyTab";
import {
  DETAIL_TABS,
  detailTabOf,
} from "../../../src/frontend/views/ResourceDetail";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { connection, stubApi } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

/** The Coolify tab, opened with the data a palette entry gives it. */
async function openWith(
  data: Record<string, unknown>,
  permissions = OPERATE,
  api = stubApi(),
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  const tab = rendered.renderTab("coolify", {
    isVisible: true,
    tab: { id: "t1", type: "coolify", label: "Coolify", data },
  });
  await within(tab).findByText("web");
  return { r: rendered, tab };
}

function pick(tab: HTMLElement, name: string) {
  fireEvent.click(
    within(tab)
      .getAllByRole("row")
      .find((row) => row.getAttribute("data-name") === name)!,
  );
}

describe("command palette", () => {
  it("registers Open shell in…, Logs of… and Sync servers", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const items = await rendered.loadPaletteGroup("coolify");
    const opened = (title: string) => {
      const item = items.find((i) => i.title === title);
      expect(item, title).toBeTruthy();
      const shell = { openSingletonTab: vi.fn() };
      item!.run({ shell } as never);
      return shell.openSingletonTab.mock.calls;
    };
    expect(opened(locales.palette.shell)).toEqual([
      ["coolify", { data: { section: "resources", open: "shell" } }],
    ]);
    expect(opened(locales.palette.logs)).toEqual([
      ["coolify", { data: { section: "resources", tab: "logs" } }],
    ]);
    expect(opened(locales.palette.sync)).toEqual([
      ["coolify", { data: { section: "sync" } }],
    ]);
  });

  it("Open shell in… opens the picked resource's shell in a coolify-shell tab, once", async () => {
    const { r, tab } = await openWith({ section: "resources", open: "shell" });
    pick(tab, "web");
    const call = r.shellCalls.find((c) => c.method === "openTab");
    expect(call?.args[1]).toBe("coolify-shell");
    expect((call!.args[2] as { data: unknown }).data).toEqual({
      connectionId: 1,
      uuid: "app-web-uuid",
      console: "shell",
    });
    expect(screen.queryByText(locales.detail.fields.coolifyStatus)).toBeNull();
    // The next pick browses as usual.
    pick(tab, "api");
    await screen.findByText(locales.detail.fields.coolifyStatus);
    expect(r.shellCalls.filter((c) => c.method === "openTab")).toHaveLength(1);
  });

  it("without coolify.operate, Open shell in… opens the resource instead", async () => {
    const { r, tab } = await openWith({ section: "resources", open: "shell" }, [
      "coolify.view",
    ]);
    pick(tab, "web");
    await screen.findByText(locales.detail.fields.coolifyStatus);
    expect(r.shellCalls.some((c) => c.method === "openTab")).toBe(false);
  });

  it("with only a view grant on the connection, Open shell in… opens the resource instead", async () => {
    const api = stubApi({ connections: [{ ...connection, access: "view" }] });
    const { r, tab } = await openWith(
      { section: "resources", open: "shell" },
      OPERATE,
      api,
    );
    pick(tab, "web");
    await screen.findByText(locales.detail.fields.coolifyStatus);
    expect(r.shellCalls.some((c) => c.method === "openTab")).toBe(false);
  });

  it("Logs of… opens the picked resource on its Logs view", async () => {
    const api = stubApi();
    const { tab } = await openWith(
      { section: "resources", tab: "logs" },
      OPERATE,
      api,
    );
    pick(tab, "web");
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\/connections\/1\/resources\/app-web-uuid\/logs/,
        ),
      ),
    );
  });

  it("without coolify.operate, Logs of… opens the resource on Overview", async () => {
    const api = stubApi();
    const { tab } = await openWith(
      { section: "resources", tab: "logs" },
      ["coolify.view"],
      api,
    );
    pick(tab, "web");
    await screen.findByText(locales.detail.fields.coolifyStatus);
    expect(
      api.get.mock.calls.some(([url]) => String(url).includes("/logs")),
    ).toBe(false);
  });

  it("a palette entry run while the tab is open applies to that tab", async () => {
    // A test-only tab type that wraps the real tab, so its data can change.
    const contributes = manifest.contributes ?? {};
    const withProbe = {
      ...manifest,
      contributes: {
        ...contributes,
        tabs: [
          ...(contributes.tabs ?? []),
          { id: "coolify-reopen", titleKey: "tab.title", icon: "Rocket" },
        ],
      },
    } as PluginManifest;
    rendered = await renderWithApp(plugin, {
      manifest: withProbe,
      locales,
      api: stubApi(),
      permissions: OPERATE,
    });
    // Stands in for the shell: openSingletonTab hands the open tab new data.
    let reopen: (data: Record<string, unknown>) => void = () => {};
    function Shell(props: TabProps) {
      const [data, setData] = useState<Record<string, unknown>>({
        section: "overview",
      });
      reopen = setData;
      return <CoolifyTab {...props} tab={{ ...props.tab, data }} />;
    }
    rendered.app.registerTab("coolify-reopen", Shell, {
      titleKey: "tab.title",
    });
    const r = rendered;
    const tab = r.renderTab("coolify-reopen", {
      tab: { id: "t1", type: "coolify-reopen", label: "Coolify" },
    });
    await within(tab).findAllByText(locales.nav.overview);

    act(() => reopen({ section: "resources", open: "shell" }));
    await within(tab).findByText("web");
    pick(tab, "web");
    expect(r.shellCalls.filter((c) => c.method === "openTab")).toHaveLength(1);
  });
});

describe("ResourceDetail's requested tab", () => {
  it("falls back to its default tab when it doesn't know a requested tab", () => {
    expect(detailTabOf("no-such-tab")).toBe("overview");
    expect(detailTabOf(undefined)).toBe("overview");
    expect(detailTabOf(42)).toBe("overview");
    for (const id of DETAIL_TABS) expect(detailTabOf(id)).toBe(id);
  });
});
