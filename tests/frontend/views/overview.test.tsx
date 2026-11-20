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
import { connection, resourceRows, stubApi } from "../fixtures";

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

  it("editing the selected connection's target reloads the resources list", async () => {
    // After the token change the connection has a new revision and Coolify
    // shows only one running application to the new token.
    const edited = { ...connection, revision: "rev-after-token-change" };
    const narrower = {
      rows: [resourceRows[0]],
      counts: { running: 1, degraded: 0, stopped: 0, deploying: 0 },
      fetchedAt: "2026-11-19T10:05:00.000Z",
    };
    let saved = false;
    const api = stubApi();
    const answer = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) => {
      if (saved && url === "/connections") return { data: [edited] };
      if (saved && /^\/connections\/1\/resources(\?|$)/.test(url)) {
        return { data: narrower };
      }
      return answer(url);
    });
    api.patch.mockImplementation(async () => {
      saved = true;
      return { data: edited };
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view", "coolify.configure"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    await screen.findByText(L.tiles.running, { selector: "span" });
    await waitFor(() =>
      expect(within(tile(L.tiles.running)).getByText("3")).toBeTruthy(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: locales.nav.connections }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: locales.connections.actions.edit,
      }),
    );
    fireEvent.change(
      await screen.findByPlaceholderText(locales.connections.form.tokenKeep),
      { target: { value: "fake-token-narrower" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: locales.connections.form.save }),
    );
    await waitFor(() => expect(api.patch).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: locales.nav.overview }));
    await waitFor(() =>
      expect(within(tile(L.tiles.running)).getByText("1")).toBeTruthy(),
    );
    expect(within(tile(L.tiles.degraded)).getByText("0")).toBeTruthy();
  });

  it("a failed connections reload keeps the list and says so", async () => {
    const api = stubApi();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    await waitFor(() =>
      expect(within(tile(L.tiles.running)).getByText("3")).toBeTruthy(),
    );
    const answer = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) => {
      if (url === "/connections") throw new Error("offline");
      return answer(url);
    });
    fireEvent.click(
      screen.getByRole("button", { name: locales.nav.resources }),
    );
    expect(
      await screen.findByText(locales.connections.loadFailed),
    ).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.queryByText(locales.tab.noConnection.title)).toBeNull();
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
