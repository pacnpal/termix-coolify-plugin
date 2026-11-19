import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  checkFrameApp,
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import { listHostSections, SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type {
  PluginApiClient,
  PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import { linkOf } from "../../../src/frontend/linked";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;
const ALL = ["coolify.view", "coolify.configure"];

function host(settings: Record<string, unknown> | null): PluginHostRecord {
  return {
    id: 7,
    userId: "user-1",
    syncId: null,
    name: "web-1",
    ip: "203.0.113.11",
    port: 22,
    username: "root",
    authType: "credential",
    credentialId: 3,
    overrideCredentialUsername: true,
    connectionType: "ssh",
    tags: "coolify",
    folder: "Coolify",
    parentHostId: null,
    pin: false,
    notes: null,
    jumpHosts: [],
    enableSsh: true,
    sshPort: null,
    statusCheckEnabled: true,
    statusCheckInterval: null,
    connectionOrigin: null,
    sshOptions: {},
    pluginSettings: settings ? { coolify: settings } : {},
    status: null,
    localOnly: false,
    createdAt: null,
    updatedAt: null,
  } as unknown as PluginHostRecord;
}

const linked = host({
  coolifyLinked: true,
  coolifyConnectionId: "1",
  coolifyServerUuid: "srv-web1",
});
const ordinary = host(null);

function previewRow(reachable: boolean, tunnel = false) {
  return {
    server: {
      uuid: "srv-web1",
      name: "web-1",
      ip: tunnel ? "ssh-web1.example.test" : "203.0.113.11",
      port: 22,
      user: "root",
      isTunnel: tunnel,
      isCoolifyHost: false,
      reachable,
      usable: reachable,
    },
    hostId: 7,
    status: "linked",
    mode: "coolify",
    addressOverride: null,
    suggestedAddress: null,
    credentialId: 3,
    tunnel,
  };
}

function stubApi(reachable = true, tunnel = false) {
  const mocks = {
    get: vi.fn(async (url: string) => ({
      data: /^\/connections\/\d+\/servers$/.test(url)
        ? [previewRow(reachable, tunnel)]
        : { id: 1, name: "Prod" },
    })),
    post: vi.fn(async () => ({ data: { hostId: 7, removed: false } })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
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

describe("Linked host surfaces", () => {
  it("reads the link from the host's own settings", () => {
    expect(linkOf(linked)).toEqual({ connectionId: 1, serverUuid: "srv-web1" });
    expect(linkOf(ordinary)).toBeNull();
    expect(
      linkOf(
        host({
          coolifyLinked: false,
          coolifyConnectionId: "1",
          coolifyServerUuid: "srv-web1",
        }),
      ),
    ).toBeNull();
    expect(
      linkOf(host({ coolifyConnectionId: "", coolifyServerUuid: "" })),
    ).toBeNull();
  });

  it("registers the host section, badge, menu items and the import entry, all frame-safe", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    const kinds = registrations.map((r) => r.kind);
    expect(kinds).toContain("hostSection");
    expect(kinds).toContain("hostBadge");
    const menu = registrations
      .filter((r) => r.kind === "hostContextMenuItem")
      .map((r) => (r.data as { id: string }).id);
    expect(menu).toEqual(
      expect.arrayContaining([
        "coolify.resources",
        "coolify.sync",
        "coolify.unlink",
      ]),
    );

    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(),
      permissions: ALL,
    });
    expect(rendered.registered.slot("hosts.importMenu")).toContain(
      "coolify.import-from-coolify",
    );
    expect(rendered.registered.actions()).toContain(
      "coolify.import-from-coolify",
    );
  });

  it("shows the Coolify badge on Linked hosts only", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(),
      permissions: ALL,
    });
    const badge = rendered.renderHostItems(
      "badge",
      linked as unknown as Record<string, unknown>,
    );
    await waitFor(() =>
      expect(badge.textContent).toContain(locales.hostBadge.label),
    );
    const none = rendered.renderHostItems(
      "badge",
      ordinary as unknown as Record<string, unknown>,
    );
    expect(none.textContent ?? "").not.toContain(locales.hostBadge.label);
  });

  it("the host section names the server and connection and unlinks after a confirm", async () => {
    const api = stubApi();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    const section = listHostSections().find(
      (s) => s.id === "coolify" || s.id.endsWith(":coolify"),
    );
    if (!section) throw new Error("no coolify host section");
    expect(section.when(linked as never)).toBe(true);
    expect(section.when(ordinary as never)).toBe(false);
    const Section = section.component;
    const shell = { openSingletonTab: vi.fn() };
    render(
      <SurfaceScope>
        <Section host={linked as never} isVisible shell={shell as never} />
      </SurfaceScope>,
    );
    expect(
      await screen.findByText(
        locales.hostSection.linked
          .replace("{{server}}", "web-1")
          .replace("{{connection}}", "Prod"),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(locales.hostSection.tunnel)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: locales.hostSection.sync }),
    );
    expect(shell.openSingletonTab).toHaveBeenCalledWith("coolify", {
      data: { section: "sync", connectionId: 1, serverUuid: "srv-web1" },
    });

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: locales.hostSection.unlink }),
    );
    const dialog = await screen
      .findByRole("alertdialog", {}, { timeout: 200 })
      .catch(() => null);
    if (dialog) {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: locales.unlinkConfirm.confirm,
        }),
      );
    }
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/servers/srv-web1/unlink",
        { removeHost: false },
      ),
    );
    expect(await screen.findByText(locales.hostSection.unlinked)).toBeTruthy();
  });

  it("a tunnelled Linked host shows the tunnel line and opens its tunnel settings", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(true, true),
      permissions: ALL,
    });
    const section = listHostSections().find(
      (s) => s.id === "coolify" || s.id.endsWith(":coolify"),
    );
    if (!section) throw new Error("no coolify host section");
    const Section = section.component;
    // Its own connection id, so the preview cache of other tests isn't used.
    const tunnelled = host({
      coolifyLinked: true,
      coolifyConnectionId: "2",
      coolifyServerUuid: "srv-web1",
    });
    const shell = { openSingletonTab: vi.fn(), editHost: vi.fn() };
    render(
      <SurfaceScope>
        <Section host={tunnelled as never} isVisible shell={shell as never} />
      </SurfaceScope>,
    );
    expect(await screen.findByText(locales.hostSection.tunnel)).toBeTruthy();
    expect(screen.getByText(locales.hostSection.tunnelReadOnly)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: locales.hostSection.openTunnelSettings,
      }),
    );
    expect(shell.editHost).toHaveBeenCalledWith(7);
  });
});
