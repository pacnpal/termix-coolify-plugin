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
import { acceptConfirm } from "../helpers/confirm";

const manifest = manifestJson as unknown as PluginManifest;
const L = locales.connections;
const W = locales.connections.webhook;
const ALL = ["coolify.view", "coolify.configure"];

const connection = {
  id: 1,
  name: "Prod",
  baseUrl: "https://coolify.example.test",
  teamName: "Ops team",
  version: "v4.7.5",
  scoped: false,
  abilities: {
    read: true,
    sensitive: true,
    keys: true,
    root: false,
    mcp: false,
  },
  lastError: null,
  autoSync: false,
  execEnabled: false,
  pollEnabled: true,
  pollError: null,
  access: "owner",
  allowPrivate: false,
  caCert: null,
  cfAccess: false,
  lastCheckedAt: "2026-11-19T10:00:00.000Z",
  steps: [],
  revision: "rev-1",
};

const UNSET = {
  state: "unset",
  enabled: false,
  current: null,
  base: "https://termix.example.com",
  basePrivate: false,
};

function stubApi(status: Record<string, unknown> = UNSET) {
  const mocks = {
    get: vi.fn(async (url: string) => ({
      data:
        url === "/connections"
          ? [connection]
          : url === "/connections/1/webhook"
            ? status
            : connection,
    })),
    post: vi.fn(async (url: string): Promise<{ data: unknown }> => ({
      data: url.endsWith("/webhook")
        ? { outcome: "configured", replaced: false, basePrivate: false }
        : connection,
    })),
    patch: vi.fn(async () => ({ data: connection })),
    delete: vi.fn(async () => ({ data: { outcome: "disabled" } })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return mocks as unknown as typeof mocks & PluginApiClient;
}

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

async function openEditor(api: PluginApiClient, permissions = ALL) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await screen.findByRole("button", { name: locales.nav.connections }),
  );
  await screen.findByText("Prod");
  fireEvent.click(screen.getByRole("button", { name: L.actions.edit }));
}

describe("Set up webhook in the connection's settings", () => {
  it("warns that Coolify refuses private addresses, and sets the webhook up", async () => {
    const api = stubApi();
    await openEditor(api);
    expect(await screen.findByText(W.privateWarning)).toBeTruthy();
    expect(await screen.findByText(W.state.unset)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: W.setup }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/webhook", {}),
    );
    expect(await screen.findByText(W.configured)).toBeTruthy();
  });

  it("says when this Termix's address is private", async () => {
    const api = stubApi({
      ...UNSET,
      base: "http://192.168.1.10:8080",
      basePrivate: true,
    });
    await openEditor(api);
    expect(
      await screen.findByText(
        W.basePrivate.replace("{{base}}", "http://192.168.1.10:8080"),
      ),
    ).toBeTruthy();
  });

  it("says when Termix's address isn't known", async () => {
    await openEditor(stubApi({ ...UNSET, base: null }));
    expect(await screen.findByText(W.noBase)).toBeTruthy();
  });

  it("asks before replacing someone else's webhook, and replaces it on yes", async () => {
    const api = stubApi({
      ...UNSET,
      state: "foreign",
      enabled: true,
      current: "https://hooks.example.net/[redacted]",
    });
    api.post.mockImplementation(async (url: string) => ({
      data: url.endsWith("/replace")
        ? { outcome: "configured", replaced: true, basePrivate: false }
        : {
            outcome: "replace-needed",
            current: "https://hooks.example.net/[redacted]",
            basePrivate: false,
          },
    }));
    await openEditor(api);
    fireEvent.click(await screen.findByRole("button", { name: W.setup }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        W.replace.description.replace(
          "{{current}}",
          "https://hooks.example.net/[redacted]",
        ),
      ),
    ).toBeTruthy();
    await acceptConfirm(W.replace.confirm);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/webhook/replace", {
        confirm: true,
      }),
    );
    expect(await screen.findByText(W.configured)).toBeTruthy();
  });

  it("declining the replace changes nothing and says polling stays on", async () => {
    const api = stubApi();
    api.post.mockImplementation(async () => ({
      data: {
        outcome: "replace-needed",
        current: "https://hooks.example.net/[redacted]",
        basePrivate: false,
      },
    }));
    await openEditor(api);
    fireEvent.click(await screen.findByRole("button", { name: W.setup }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: W.cancel }));
    expect(await screen.findByText(W.declined)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalledWith(
      "/connections/1/webhook/replace",
      expect.anything(),
    );
  });

  it("turns our webhook off after a confirm", async () => {
    const api = stubApi({ ...UNSET, state: "ours", enabled: true });
    await openEditor(api);
    expect(await screen.findByText(W.state.ours)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: W.disable.action }));
    await acceptConfirm(W.disable.confirm);
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(
        "/connections/1/webhook?confirm=true",
      ),
    );
    expect(await screen.findByText(W.disabled)).toBeTruthy();
  });

  it("shows a refusal's cause", async () => {
    const api = stubApi();
    api.post.mockRejectedValue({
      response: {
        status: 409,
        data: { error: "x", cause: "secrets-unreadable" },
      },
    });
    await openEditor(api);
    fireEvent.click(await screen.findByRole("button", { name: W.setup }));
    expect(
      await screen.findByText(locales.causes["secrets-unreadable"], {
        exact: false,
      }),
    ).toBeTruthy();
  });
});
