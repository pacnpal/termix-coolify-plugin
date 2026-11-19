import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import {
  DETAIL_TABS,
  detailTabOf,
} from "../../../src/frontend/views/ResourceDetail";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { stubApi } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

/** The Coolify tab, opened with the data a palette entry gives it. */
async function openWith(data: Record<string, unknown>, permissions = OPERATE) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: stubApi(),
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

  it("Logs of… opens the picked resource, on Overview while there is no Logs view", async () => {
    const { tab } = await openWith({ section: "resources", tab: "logs" });
    pick(tab, "web");
    expect(
      await screen.findByText(locales.detail.fields.coolifyStatus),
    ).toBeTruthy();
  });
});

describe("ResourceDetail's requested tab", () => {
  it("falls back to its default tab when it doesn't know a requested tab", () => {
    expect(detailTabOf("logs")).toBe("overview");
    expect(detailTabOf("no-such-tab")).toBe("overview");
    expect(detailTabOf(undefined)).toBe("overview");
    expect(detailTabOf(42)).toBe("overview");
    for (const id of DETAIL_TABS) expect(detailTabOf(id)).toBe(id);
  });
});
