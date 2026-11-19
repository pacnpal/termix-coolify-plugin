import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;
const L = locales.connections;
const ALL = ["coolify.view", "coolify.configure"];

const scopedConnection = {
  id: 1,
  name: "Prod",
  baseUrl: "https://coolify.example.test",
  teamName: null,
  version: "v4.7.5",
  scoped: true,
  abilities: {
    read: true,
    sensitive: false,
    keys: false,
    root: false,
    mcp: false,
  },
  lastError: null,
  autoSync: false,
  access: "owner",
  allowPrivate: false,
  caCert: null,
  cfAccess: false,
  lastCheckedAt: "2026-11-19T10:00:00.000Z",
  steps: [
    { id: "health", ok: true },
    { id: "version", ok: true },
    { id: "team", ok: true },
    { id: "projects", ok: true },
    { id: "keys", ok: false, cause: "forbidden-ability" },
    { id: "logs", ok: false, cause: "forbidden-ability" },
    { id: "root", ok: false, cause: "forbidden-ability" },
  ],
};

function stubApi(list: unknown[] = []) {
  const mocks = {
    get: vi.fn(async (url: string) => ({
      data: url === "/connections" ? list : list[0],
    })),
    post: vi.fn(async () => ({ data: scopedConnection })),
    patch: vi.fn(async () => ({ data: scopedConnection })),
    delete: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return mocks as unknown as typeof mocks & PluginApiClient;
}

let rendered: RenderedPluginApp | null = null;

/** With a connection the tab opens on Overview; these tests use Connections. */
async function openConnections() {
  fireEvent.click(
    await screen.findByRole("button", { name: locales.nav.connections }),
  );
  return screen.findByText("Prod");
}

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

describe("connections view", () => {
  it("lists connections with their version and status", async () => {
    const api = stubApi([scopedConnection]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    expect(await openConnections()).toBeTruthy();
    expect(screen.getByText(L.badges.scoped)).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/connections");
  });

  it("shows an empty state with the add button", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ALL,
      api: stubApi([]),
    });
    rendered.renderTab("coolify", { isVisible: true });
    expect(await screen.findByText(L.empty.title)).toBeTruthy();
  });

  it("add form shows probe checklist with causes", async () => {
    const api = stubApi([]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    fireEvent.click((await screen.findAllByRole("button", { name: L.add }))[0]);
    expect(await screen.findByText(L.form.abilitiesHint)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(L.form.namePlaceholder), {
      target: { value: "Prod" },
    });
    fireEvent.change(screen.getByPlaceholderText(L.form.baseUrlPlaceholder), {
      target: { value: "https://coolify.example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText(L.form.tokenPlaceholder), {
      target: { value: "fake-token-ui" },
    });
    fireEvent.click(screen.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith(
      "/connections",
      expect.objectContaining({
        name: "Prod",
        baseUrl: "https://coolify.example.test",
        token: "fake-token-ui",
      }),
    );
    expect(await screen.findByText(L.probe.scoped)).toBeTruthy();
    expect(screen.getByText(L.probe.steps.keys)).toBeTruthy();
    expect(
      screen.getAllByText(locales.causes["forbidden-ability"]).length,
    ).toBeGreaterThan(0);
  });

  it("secret field empty keeps token", async () => {
    const api = stubApi([{ ...scopedConnection, scoped: false }]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    fireEvent.click(screen.getByRole("button", { name: L.actions.edit }));
    const name = await screen.findByPlaceholderText(L.form.namePlaceholder);
    expect((name as HTMLInputElement).value).toBe("Prod");
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [url, body] = api.patch.mock.calls[0] as unknown as [string, object];
    expect(url).toBe("/connections/1");
    expect(body).toMatchObject({ name: "Renamed" });
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("cfAccessId");
    expect(body).not.toHaveProperty("cfAccessSecret");
  });

  it("probes a connection again from its row", async () => {
    const api = stubApi([scopedConnection]);
    api.post.mockResolvedValueOnce({
      data: {
        connection: scopedConnection,
        probe: { ok: true, version: "v4.7.5", scoped: true, steps: [] },
      },
    } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    fireEvent.click(screen.getByRole("button", { name: L.actions.probe }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/probe"),
    );
  });

  it("removes a connection after a confirm", async () => {
    const api = stubApi([scopedConnection]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    const tab = rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    fireEvent.click(
      within(tab).getByRole("button", { name: L.actions.delete }),
    );
    const card = await screen
      .findByRole("alertdialog", {}, { timeout: 200 })
      .catch(() => null);
    if (card) {
      fireEvent.click(
        within(card).getByRole("button", { name: L.delete.confirm }),
      );
    }
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/connections/1"),
    );
  });

  it("hides add, edit and remove without coolify.configure", async () => {
    const api = stubApi([scopedConnection]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    expect(screen.queryByRole("button", { name: L.add })).toBeNull();
    expect(screen.queryByRole("button", { name: L.actions.edit })).toBeNull();
    expect(screen.queryByRole("button", { name: L.actions.delete })).toBeNull();
    expect(screen.getByRole("button", { name: L.actions.probe })).toBeTruthy();
  });

  it("registers the Connect Coolify onboarding step", async () => {
    const api = stubApi([]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    expect(rendered.registered.onboardingSteps()).toContain("connect");
    const step = rendered.renderOnboardingStep("connect");
    expect(
      await within(step.element).findByText(locales.onboarding.connect.intro),
    ).toBeTruthy();
    expect(step.canContinue()).toBe(true);
  });
});
