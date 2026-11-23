import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import { createApi, type ConnectionPatch } from "../../../src/frontend/api";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import {
  clickOpenPlugins,
  fillConnectionForm,
  renderApp,
  syncRow,
  syncServer,
} from "../helpers";
import { acceptConfirm } from "../helpers/confirm";

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
    { id: "logs", ok: false, skipped: "nothing-to-probe" },
    { id: "settings", ok: false, cause: "forbidden-ability" },
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
    data: { ...scopedConnection, scoped: false, steps: [] },
  }));
  rendered = await renderApp(api);
  const el = rendered.renderOnboardingStep("connect").element;
  fillConnectionForm(el);
  return { api, el };
}

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

  it("shows the last failed poll's cause on the connection", async () => {
    const api = stubApi([{ ...scopedConnection, pollError: "unreachable" }]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    expect(
      screen.getByText(
        L.poll.error.replace("{{cause}}", locales.causes.unreachable),
        { exact: false },
      ),
    ).toBeTruthy();
  });

  it("the owner keeps polling after a webhook from the editor", async () => {
    const owned = { ...scopedConnection, scoped: false, pollEnabled: false };
    const api = stubApi([owned]);
    api.patch.mockResolvedValueOnce({
      data: { ...owned, pollEnabled: true },
    } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    fireEvent.click(screen.getByRole("button", { name: L.actions.edit }));
    const toggle = await screen.findByRole("switch", { name: L.poll.label });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/connections/1", {
        pollEnabled: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: L.poll.label })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
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
    // A check with nothing to try says so, rather than reading as a refusal.
    expect(screen.getByText(L.probe.skipped["nothing-to-probe"])).toBeTruthy();
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
    await acceptConfirm(L.delete.confirm);
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

  it("the owner turns running commands in containers on from the editor, with a warning", async () => {
    const owned = { ...scopedConnection, scoped: false, execEnabled: false };
    const api = stubApi([owned]);
    api.patch.mockResolvedValueOnce({
      data: { ...owned, execEnabled: true },
    } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    fireEvent.click(screen.getByRole("button", { name: L.actions.edit }));
    const toggle = await screen.findByRole("switch", { name: L.exec.label });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(L.exec.warning)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/connections/1", {
        execEnabled: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: L.exec.label })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("shows the exec switch only to the owner of a saved connection", async () => {
    const granted = {
      ...scopedConnection,
      access: "configure",
      execEnabled: true,
    };
    const api = stubApi([granted]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    expect(screen.queryByRole("button", { name: L.actions.edit })).toBeNull();
    expect(screen.queryByRole("switch", { name: L.exec.label })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: L.add })[0]);
    await screen.findByPlaceholderText(L.form.namePlaceholder);
    expect(screen.queryByRole("switch", { name: L.exec.label })).toBeNull();
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

/** A promise the test settles by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function confirmDelete(tab: HTMLElement) {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(within(tab).getByRole("button", { name: L.actions.delete }));
  await acceptConfirm(L.delete.confirm);
}

async function fillAddForm(scope: ReturnType<typeof within>) {
  fireEvent.change(await scope.findByPlaceholderText(L.form.namePlaceholder), {
    target: { value: "Prod" },
  });
  fireEvent.change(scope.getByPlaceholderText(L.form.baseUrlPlaceholder), {
    target: { value: "https://coolify.example.test" },
  });
  fireEvent.change(scope.getByPlaceholderText(L.form.tokenPlaceholder), {
    target: { value: "fake-token-ui" },
  });
}

describe("connections view under concurrent requests", () => {
  it("lets the typed api clear the Cloudflare Access token", async () => {
    const api = stubApi([scopedConnection]);
    const patch: ConnectionPatch = { cfAccessId: null, cfAccessSecret: null };
    await createApi(api).updateConnection(1, patch);
    expect(api.patch).toHaveBeenCalledWith("/connections/1", patch);
  });

  it("keeps what was typed while a save was pending", async () => {
    const api = stubApi([scopedConnection]);
    const pending = deferred<{ data: unknown }>();
    api.patch.mockReturnValueOnce(pending.promise as never);
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
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(L.form.tokenKeep), {
      target: { value: "fake-typed-later" },
    });
    pending.resolve({ data: { ...scopedConnection, name: "Renamed" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(
      (screen.getByPlaceholderText(L.form.tokenKeep) as HTMLInputElement).value,
    ).toBe("fake-typed-later");
  });

  it("a second save after a create changes the saved connection", async () => {
    const api = stubApi([]);
    const failed = { ...scopedConnection, id: 5, lastError: "unreachable" };
    api.post.mockResolvedValueOnce({ data: failed } as never);
    // A new token is checked again, so the answer carries a new check time.
    api.patch.mockResolvedValueOnce({
      data: { ...failed, lastCheckedAt: "2026-11-19T10:05:00.000Z" },
    } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify", { isVisible: true });
    fireEvent.click((await screen.findAllByRole("button", { name: L.add }))[0]);
    await fillAddForm(within(document.body));
    fireEvent.click(screen.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    // The saved failure keeps its checklist, and the form now edits it.
    expect(await screen.findByText(L.probe.title)).toBeTruthy();
    fireEvent.change(await screen.findByPlaceholderText(L.form.tokenKeep), {
      target: { value: "fake-token-retry" },
    });
    fireEvent.click(screen.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledTimes(1);
    const [url] = api.patch.mock.calls[0] as unknown as [string];
    expect(url).toBe("/connections/5");
  });

  it("a list answer requested before a removal doesn't bring the row back", async () => {
    const api = stubApi([scopedConnection]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    const tab = rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    const stale = deferred<{ data: unknown }>();
    api.get.mockReturnValueOnce(stale.promise as never);
    // The tab and the Overview read first, so count only the list calls since.
    const listCalls = () =>
      api.get.mock.calls.filter(([url]) => url === "/connections").length;
    const before = listCalls();
    fireEvent.click(within(tab).getByRole("button", { name: L.refresh }));
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    await confirmDelete(tab);
    await waitFor(() => expect(within(tab).queryByText("Prod")).toBeNull());
    stale.resolve({ data: [scopedConnection] });
    await new Promise((r) => setTimeout(r, 20));
    expect(within(tab).queryByText("Prod")).toBeNull();
  });

  it("a probe answer that arrives after a removal doesn't bring the row back", async () => {
    const api = stubApi([scopedConnection]);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    const tab = rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    const late = deferred<{ data: unknown }>();
    api.post.mockReturnValueOnce(late.promise as never);
    fireEvent.click(within(tab).getByRole("button", { name: L.actions.probe }));
    await confirmDelete(tab);
    await waitFor(() => expect(within(tab).queryByText("Prod")).toBeNull());
    late.resolve({
      data: {
        connection: scopedConnection,
        probe: { ok: true, version: "v4.7.5", scoped: true, steps: [] },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(within(tab).queryByText("Prod")).toBeNull();
  });

  it("onboarding shows success only for a working connection, and retries the same one", async () => {
    const api = stubApi([]);
    const failed = {
      ...scopedConnection,
      id: 5,
      name: "Prod",
      lastError: "unreachable",
    };
    api.post.mockResolvedValueOnce({ data: failed } as never);
    api.patch.mockResolvedValueOnce({
      data: {
        ...failed,
        lastError: null,
        lastCheckedAt: "2026-11-19T10:05:00.000Z",
      },
    } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    const step = rendered.renderOnboardingStep("connect");
    const inStep = within(step.element);
    await fillAddForm(inStep);
    fireEvent.click(inStep.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const done = locales.onboarding.connect.done.replace("{{name}}", "Prod");
    expect(await inStep.findByText(L.probe.title)).toBeTruthy();
    expect(inStep.queryByText(done)).toBeNull();

    fireEvent.change(inStep.getByPlaceholderText(L.form.tokenKeep), {
      target: { value: "fake-token-retry" },
    });
    fireEvent.click(inStep.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledTimes(1);
    const [url] = api.patch.mock.calls[0] as unknown as [string];
    expect(url).toBe("/connections/5");
    expect(await inStep.findByText(done)).toBeTruthy();
  });

  it("onboarding keeps a form dirtied during a save visible and saveable", async () => {
    const api = stubApi([]);
    const saved = { ...scopedConnection, id: 5, name: "Prod", lastError: null };
    const pending = deferred<{ data: unknown }>();
    api.post.mockReturnValueOnce(pending.promise as never);
    api.patch.mockResolvedValueOnce({
      data: { ...saved, name: "Prod 2" },
    } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    const step = rendered.renderOnboardingStep("connect");
    const inStep = within(step.element);
    await fillAddForm(inStep);
    fireEvent.click(inStep.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    // Edited while the save is still running.
    fireEvent.change(inStep.getByPlaceholderText(L.form.namePlaceholder), {
      target: { value: "Prod 2" },
    });
    pending.resolve({ data: saved });
    await new Promise((r) => setTimeout(r, 20));

    const name = inStep.getByPlaceholderText(
      L.form.namePlaceholder,
    ) as HTMLInputElement;
    expect(name.value).toBe("Prod 2");
    fireEvent.click(inStep.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [url, body] = api.patch.mock.calls[0] as unknown as [string, object];
    expect(url).toBe("/connections/5");
    expect(body).toMatchObject({ name: "Prod 2" });
    expect(api.post).toHaveBeenCalledTimes(1);
    const done = locales.onboarding.connect.done.replace("{{name}}", "Prod 2");
    expect(await inStep.findByText(done)).toBeTruthy();
  });

  it("retrying a saved failure with no changes probes Coolify again", async () => {
    const failed = {
      ...scopedConnection,
      id: 5,
      name: "Prod",
      lastError: "unreachable",
    };
    const fixed = {
      ...failed,
      lastError: null,
      lastCheckedAt: "2026-11-19T11:00:00.000Z",
    };
    const probed = {
      data: {
        connection: fixed,
        probe: { ok: true, version: "v4.7.5", scoped: true, steps: [] },
      },
    };

    // Onboarding: the first save stores a failure; Save again rechecks it.
    const api = stubApi([]);
    api.post
      .mockResolvedValueOnce({ data: failed } as never)
      .mockResolvedValueOnce(probed as never);
    // With nothing changed, the update keeps the stored check as it was.
    api.patch.mockResolvedValue({ data: failed } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    const step = rendered.renderOnboardingStep("connect");
    const inStep = within(step.element);
    await fillAddForm(inStep);
    fireEvent.click(inStep.getByRole("button", { name: L.form.save }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await inStep.findByText(L.probe.title);
    fireEvent.click(inStep.getByRole("button", { name: L.form.save }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/5/probe"),
    );
    const done = locales.onboarding.connect.done.replace("{{name}}", "Prod");
    expect(await inStep.findByText(done)).toBeTruthy();
    await rendered.deactivate();
    rendered = null;

    // The editor: Save on an unchanged failed connection rechecks it too.
    const listed = { ...failed, id: 1 };
    const editorApi = stubApi([listed]);
    editorApi.patch.mockResolvedValue({ data: listed } as never);
    editorApi.post.mockResolvedValueOnce({
      data: { ...probed.data, connection: { ...fixed, id: 1 } },
    } as never);
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: editorApi,
      permissions: ALL,
    });
    const tab = rendered.renderTab("coolify", { isVisible: true });
    await openConnections();
    await within(tab).findByText(L.badges.error);
    fireEvent.click(within(tab).getByRole("button", { name: L.actions.edit }));
    fireEvent.click(await screen.findByRole("button", { name: L.form.save }));
    await waitFor(() =>
      expect(editorApi.post).toHaveBeenCalledWith("/connections/1/probe"),
    );
    expect(await within(tab).findByText(L.badges.ok)).toBeTruthy();
  });
});

describe("the SSH Terminal check follows the saved connection", () => {
  const tunnelRow = (cause: string) =>
    syncRow(
      syncServer("vps1", "vps1", "vps1.example.test", { isTunnel: true }),
      { status: "blocked", cause },
    );
  // A saved failure keeps the setup form open, so it can be saved again.
  const saved = (overrides: Record<string, unknown>) => ({
    data: {
      ...scopedConnection,
      scoped: false,
      steps: [],
      lastError: "unreachable",
      revision: "rev-a",
      ...overrides,
    },
  });

  /**
   * Saves a connection in the setup step, then changes its URL and saves it
   * again, answering the update with `second`. `previews` answers each sync
   * preview request in turn.
   */
  async function saveThenRetarget(
    second: Record<string, unknown>,
    previews: (call: number) => Promise<unknown>,
  ) {
    const api = stubApi([]);
    let calls = 0;
    api.get.mockImplementation(async (url: string) => ({
      data: url === "/connections/1/servers" ? await previews(++calls) : [],
    }));
    api.post.mockResolvedValue(saved({}) as never);
    // A new target is probed again, so the update answers a new check time.
    api.patch.mockResolvedValue(
      saved({ lastCheckedAt: "2026-11-19T11:00:00.000Z", ...second }) as never,
    );
    rendered = await renderApp(api);
    const el = rendered.renderOnboardingStep("connect").element;
    fillConnectionForm(el);
    await waitFor(() => expect(calls).toBe(1));
    const retarget = async () => {
      fireEvent.change(
        within(el).getByPlaceholderText(L.form.baseUrlPlaceholder),
        { target: { value: "https://coolify-new.example.test" } },
      );
      fireEvent.click(within(el).getByRole("button", { name: L.form.save }));
      await waitFor(() => expect(api.patch).toHaveBeenCalled());
      // The checklist stays on screen across the save.
      await within(el).findByText(L.probe.title);
    };
    return { el, retarget, calls: () => calls };
  }

  it("a new revision reloads the checklist with the new target's rows", async () => {
    let rows = [tunnelRow("needs-ssh-terminal")];
    const { el, retarget } = await saveThenRetarget(
      { revision: "rev-b" },
      async () => rows,
    );
    expect(
      await within(el).findByText(locales.sync.causes["needs-ssh-terminal"]),
    ).toBeTruthy();

    rows = [tunnelRow("ssh-terminal-too-old")];
    await retarget();
    expect(
      await within(el).findByText(locales.sync.causes["ssh-terminal-too-old"]),
    ).toBeTruthy();
    expect(
      within(el).queryByText(locales.sync.causes["needs-ssh-terminal"]),
    ).toBeNull();
  });

  it("switching the connection to a scoped token clears the rows", async () => {
    const { el, retarget } = await saveThenRetarget(
      { revision: "rev-b", scoped: true },
      async () => [tunnelRow("needs-ssh-terminal")],
    );
    expect(await within(el).findByText(L.probe.steps.sshTerminal)).toBeTruthy();

    await retarget();
    await waitFor(() =>
      expect(within(el).queryByText(L.probe.steps.sshTerminal)).toBeNull(),
    );
  });

  it("an older preview answer that lands late doesn't replace the newer one", async () => {
    const first = deferred<unknown>();
    const { el, retarget, calls } = await saveThenRetarget(
      { revision: "rev-b" },
      (call) =>
        call === 1
          ? first.promise
          : Promise.resolve([tunnelRow("ssh-terminal-too-old")]),
    );
    await retarget();
    expect(
      await within(el).findByText(locales.sync.causes["ssh-terminal-too-old"]),
    ).toBeTruthy();
    expect(calls()).toBe(2);

    first.resolve([tunnelRow("needs-ssh-terminal")]);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      within(el).getByText(locales.sync.causes["ssh-terminal-too-old"]),
    ).toBeTruthy();
    expect(
      within(el).queryByText(locales.sync.causes["needs-ssh-terminal"]),
    ).toBeNull();
  });
});
