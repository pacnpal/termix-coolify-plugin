import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { stubApi } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const L = locales.resources;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

async function openResources(api = stubApi()) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: ["coolify.view"],
  });
  const tab = rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await within(tab).findByRole("button", { name: locales.nav.resources }),
  );
  await within(tab).findByText("web");
  return { tab, api };
}

/** The names in the table, top to bottom. */
function names(tab: HTMLElement): string[] {
  return within(tab)
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.getAttribute("data-name") ?? "");
}

function radio(name: string) {
  return screen.getByRole("radio", { name: new RegExp(`^${name}`) });
}

describe("resources list", () => {
  it("shows every resource with Parts right under their service", async () => {
    const { tab } = await openResources();
    expect(names(tab)).toEqual([
      "web",
      "api",
      "n8n",
      "n8n-main",
      "postgresql",
      "main-db",
      "cache",
      "blog",
    ]);
    const part = within(tab)
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-name") === "n8n-main")!;
    expect(part.getAttribute("data-parent")).toBe("svc-n8n-uuid");
    expect(within(part).getByText("https://n8n.example.test")).toBeTruthy();
    const web = within(tab)
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-name") === "web")!;
    expect(within(web).getByText(L.health.running)).toBeTruthy();
    expect(within(web).getByText("vps1")).toBeTruthy();
    expect(within(web).getByText("Shop / production")).toBeTruthy();
    expect(within(web).getByText("https://shop.example.test")).toBeTruthy();
    expect(within(web).getByText(L.kinds.application)).toBeTruthy();
  });

  it("search matches names, domains and servers, keeping a matched Part's service", async () => {
    const { tab } = await openResources();
    const search = within(tab).getByPlaceholderText(L.search);
    fireEvent.change(search, { target: { value: "edge" } });
    expect(names(tab)).toEqual(["api"]);
    fireEvent.change(search, { target: { value: "n8n.example" } });
    expect(names(tab)).toEqual(["n8n", "n8n-main", "postgresql"]);
    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(await within(tab).findByText(L.noMatch.title)).toBeTruthy();
  });

  it("filters by type and by status", async () => {
    const { tab } = await openResources();
    fireEvent.click(radio(L.filters.databases));
    expect(names(tab)).toEqual(["main-db", "cache"]);
    fireEvent.click(radio(L.filters.services));
    expect(names(tab)).toEqual(["n8n", "n8n-main", "postgresql"]);
    fireEvent.click(radio(L.filters.allKinds));
    fireEvent.click(radio(L.health.degraded));
    expect(names(tab)).toEqual(["api"]);
    fireEvent.click(radio(L.health.deploying));
    expect(names(tab)).toEqual(["blog"]);
  });

  it("opens a resource's Overview detail, and a Part from its service", async () => {
    const { tab } = await openResources();
    fireEvent.click(
      within(tab)
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-name") === "n8n")!,
    );
    expect(await screen.findByText(locales.detail.parts)).toBeTruthy();
    expect(screen.getByText(locales.detail.fields.coolifyStatus)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /postgresql/ }));
    expect(await screen.findByText("postgres:16-alpine")).toBeTruthy();
    expect(screen.getByText("part-postgres-uuid")).toBeTruthy();
  });

  it("on a phone, lists rows instead of the table, Parts still under their service", async () => {
    const width = window.innerWidth;
    window.innerWidth = 400;
    try {
      const { tab } = await openResources();
      expect(within(tab).queryByRole("table")).toBeNull();
      const order = [...tab.querySelectorAll("[data-name]")].map((el) =>
        el.getAttribute("data-name"),
      );
      expect(order).toEqual([
        "web",
        "api",
        "n8n",
        "n8n-main",
        "postgresql",
        "main-db",
        "cache",
        "blog",
      ]);
    } finally {
      window.innerWidth = width;
    }
  });

  it("shows an empty state when the connection has no resources", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi({
        resources: {
          rows: [],
          counts: { running: 0, degraded: 0, stopped: 0, deploying: 0 },
          fetchedAt: "2026-11-19T10:00:00.000Z",
        },
      }),
      permissions: ["coolify.view"],
    });
    const tab = rendered.renderTab("coolify", { isVisible: true });
    fireEvent.click(
      await within(tab).findByRole("button", { name: locales.nav.resources }),
    );
    await waitFor(() =>
      expect(within(tab).getByText(L.empty.title)).toBeTruthy(),
    );
  });
});
