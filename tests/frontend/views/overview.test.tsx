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
const L = locales.overview;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

/** The tile whose title is `label`. */
function tile(label: string): HTMLElement {
  const title = screen.getByText(label, { selector: "span" });
  return title.parentElement!.parentElement as HTMLElement;
}

describe("overview", () => {
  it("overview shows counts tiles", async () => {
    const api = stubApi();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    await screen.findByText(L.tiles.running, { selector: "span" });
    await waitFor(() =>
      expect(within(tile(L.tiles.running)).getByText("3")).toBeTruthy(),
    );
    expect(within(tile(L.tiles.degraded)).getByText("1")).toBeTruthy();
    expect(within(tile(L.tiles.stopped)).getByText("1")).toBeTruthy();
    expect(within(tile(L.tiles.deploying)).getByText("1")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/connections/1/resources");
  });

  it("a tile opens the Resources list filtered to its status", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(),
      permissions: ["coolify.view"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    await screen.findByText(L.tiles.degraded, { selector: "span" });
    fireEvent.click(await within(tile(L.tiles.degraded)).findByRole("button"));
    expect(await screen.findByText("api")).toBeTruthy();
    expect(screen.queryByText("web")).toBeNull();
    expect(
      screen
        .getByRole("radio", {
          name: new RegExp(`^${locales.resources.health.degraded}`),
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("refresh asks Coolify again", async () => {
    const api = stubApi();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    await screen.findByText(L.tiles.running, { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: L.refresh }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/connections/1/resources?refresh=true",
      ),
    );
  });

  it("names the cause when Coolify fails", async () => {
    const failure = Object.assign(new Error("502"), {
      response: { data: { error: "x", cause: "unauthorized" } },
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi({ resources: failure }),
      permissions: ["coolify.view"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    expect(
      await screen.findByText(locales.causes.unauthorized, { exact: false }),
    ).toBeTruthy();
  });
});
