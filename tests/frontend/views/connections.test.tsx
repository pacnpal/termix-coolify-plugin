import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { RenderedPluginApp } from "@termix-ssh/plugin-sdk/testing";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import locales from "../../../locales/en.json";
import {
  clickOpenPlugins,
  connectionFixture,
  fillConnectionForm,
  renderApp,
  syncRow,
  syncServer,
  stubClient,
} from "../helpers";

const L = locales.connections;

const scopedConnection = connectionFixture({
  scoped: true,
  abilities: {
    read: true,
    sensitive: false,
    keys: false,
    root: false,
    mcp: false,
  },
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
});

function stubApi(list: unknown[] = []) {
  return stubClient({
    get: async (url) => ({ data: url === "/connections" ? list : list[0] }),
    post: async () => ({ data: scopedConnection }),
    patch: async () => ({ data: scopedConnection }),
  });
}

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

/** Renders the plugin and opens the Coolify tab. */
async function openTab(api: PluginApiClient, permissions?: string[]) {
  rendered = await renderApp(api, permissions);
  return rendered.renderTab("coolify", { isVisible: true });
}

/**
 * Connects a plain (unscoped) connection through the setup step, with
 * `servers` as the sync preview, and returns the step's element.
 */
async function connectInSetup(servers: unknown[]) {
  const api = stubApi([]);
  api.get.mockImplementation(async (url: string) => ({
    data: url === "/connections/1/servers" ? servers : [],
  }));
  api.post.mockImplementation(async () => ({
    data: connectionFixture({ steps: [] }),
  }));
  rendered = await renderApp(api);
  const el = rendered.renderOnboardingStep("connect").element;
  fillConnectionForm(el);
  return { api, el };
}

describe("connections view", () => {
  it("lists connections with their version and status", async () => {
    const api = stubApi([scopedConnection]);
    await openTab(api);
    expect(await screen.findByText("Prod")).toBeTruthy();
    expect(screen.getByText(L.badges.scoped)).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/connections");
  });

  it("shows an empty state with the add button", async () => {
    await openTab(stubApi([]));
    expect(await screen.findByText(L.empty.title)).toBeTruthy();
  });

  it("add form shows probe checklist with causes", async () => {
    const api = stubApi([]);
    await openTab(api);
    fireEvent.click((await screen.findAllByRole("button", { name: L.add }))[0]);
    expect(await screen.findByText(L.form.abilitiesHint)).toBeTruthy();
    fillConnectionForm(document.body);
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
    await openTab(api);
    await screen.findByText("Prod");
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
    await openTab(api);
    await screen.findByText("Prod");
    fireEvent.click(screen.getByRole("button", { name: L.actions.probe }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/probe"),
    );
  });

  it("removes a connection after a confirm", async () => {
    const api = stubApi([scopedConnection]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const tab = await openTab(api);
    await screen.findByText("Prod");
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
    await openTab(stubApi([scopedConnection]), ["coolify.view"]);
    await screen.findByText("Prod");
    expect(screen.queryByRole("button", { name: L.add })).toBeNull();
    expect(screen.queryByRole("button", { name: L.actions.edit })).toBeNull();
    expect(screen.queryByRole("button", { name: L.actions.delete })).toBeNull();
    expect(screen.getByRole("button", { name: L.actions.probe })).toBeTruthy();
  });

  it("registers the Connect Coolify onboarding step", async () => {
    rendered = await renderApp(stubApi([]));
    expect(rendered.registered.onboardingSteps()).toContain("connect");
    const step = rendered.renderOnboardingStep("connect");
    expect(
      await within(step.element).findByText(locales.onboarding.connect.intro),
    ).toBeTruthy();
    expect(step.canContinue()).toBe(true);
  });

  it("connection setup shows the SSH Terminal check once when the instance has tunnelled servers", async () => {
    const tunnelRow = (uuid: string) =>
      syncRow(
        syncServer(uuid, uuid, `${uuid}.example.test`, { isTunnel: true }),
        { status: "blocked", cause: "needs-ssh-terminal" },
      );
    const { el } = await connectInSetup([tunnelRow("vps1"), tunnelRow("vps2")]);
    expect(await within(el).findByText(L.probe.steps.sshTerminal)).toBeTruthy();
    expect(
      within(el).getAllByText(locales.sync.causes["needs-ssh-terminal"]),
    ).toHaveLength(1);
    expect(
      within(el).getAllByRole("button", { name: locales.sync.openPlugins }),
    ).toHaveLength(1);
    await clickOpenPlugins(rendered!, el);
  });

  it("connection setup shows no SSH Terminal check without tunnelled servers", async () => {
    const { api, el } = await connectInSetup([]);
    expect(
      await within(el).findByText(
        locales.onboarding.connect.done.replace("{{name}}", "Prod"),
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/connections/1/servers"),
    );
    expect(within(el).queryByText(L.probe.steps.sshTerminal)).toBeNull();
  });
});
