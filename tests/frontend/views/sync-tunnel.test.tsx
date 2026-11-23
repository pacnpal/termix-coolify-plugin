import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import type { Api, Connection, SyncRow } from "../../../src/frontend/api";
import { SyncView } from "../../../src/frontend/views/SyncView";
import locales from "../../../locales/en.json";
import {
  ALL,
  connectionFixture,
  manifest,
  stubClient,
  syncRow,
  syncServer,
} from "../helpers";

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

const LOCAL = syncRow(
  syncServer("srv-local", "localhost", "host.docker.internal", {
    isCoolifyHost: true,
  }),
  {
    status: "blocked",
    cause: "needs-address",
    suggestedAddress: "coolify.example.test",
  },
) as SyncRow;

async function mount(api: Partial<Api>) {
  const contributes = manifest.contributes ?? {};
  rendered = await renderWithApp(plugin, {
    manifest: {
      ...manifest,
      contributes: {
        ...contributes,
        tabs: [
          ...(contributes.tabs ?? []),
          { id: "coolify-sync-tunnel", titleKey: "tab.title", icon: "Rocket" },
        ],
      },
    } as PluginManifest,
    locales,
    api: stubClient({}),
    permissions: ALL,
  });
  rendered.app.registerTab(
    "coolify-sync-tunnel",
    () => (
      <SyncView
        api={api as Api}
        connection={connectionFixture({}) as unknown as Connection}
      />
    ),
    { titleKey: "tab.title" },
  );
  rendered.renderTab("coolify-sync-tunnel", {
    tab: { id: "t1", type: "coolify-sync-tunnel", label: "Tunnel" },
  });
}

describe("Servers: Reach through a Cloudflare tunnel", () => {
  it("sends viaTunnel with the tunnel hostname, and offers no Coolify suggestion", async () => {
    const syncApply = vi.fn<Api["syncApply"]>().mockResolvedValue([]);
    await mount({
      syncPreview: vi.fn<Api["syncPreview"]>().mockResolvedValue([LOCAL]),
      syncApply,
    });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: locales.sync.viaTunnel }),
    );
    expect(
      screen.queryByRole("button", {
        name: locales.sync.useSuggested.replace(
          "{{address}}",
          "coolify.example.test",
        ),
      }),
    ).toBeNull();
    expect(screen.getByText(locales.sync.tunnelHostname)).toBeTruthy();
    fireEvent.change(
      screen.getByPlaceholderText(locales.sync.tunnelHostnamePlaceholder),
      {
        target: { value: "ssh-coolify.example.test" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: locales.sync.apply }));
    await waitFor(() => expect(syncApply).toHaveBeenCalled());
    expect(syncApply.mock.calls[0][1]).toEqual([
      {
        uuid: "srv-local",
        include: true,
        addressOverride: "ssh-coolify.example.test",
        viaTunnel: true,
      },
    ]);
  });

  it("turning off a stored tunnel blocked on SSH Terminal includes the row again", async () => {
    const blocked = syncRow(
      syncServer("srv-local", "localhost", "host.docker.internal", {
        isCoolifyHost: true,
      }),
      {
        status: "blocked",
        cause: "needs-ssh-terminal",
        addressOverride: "203.0.113.5",
        viaTunnel: true,
        tunnel: true,
      },
    ) as SyncRow;
    const syncApply = vi.fn<Api["syncApply"]>().mockResolvedValue([]);
    await mount({
      syncPreview: vi.fn<Api["syncPreview"]>().mockResolvedValue([blocked]),
      syncApply,
    });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: locales.sync.viaTunnel }),
    );
    fireEvent.click(screen.getByRole("button", { name: locales.sync.apply }));
    await waitFor(() => expect(syncApply).toHaveBeenCalled());
    expect(syncApply.mock.calls[0][1]).toEqual([
      { uuid: "srv-local", include: true, viaTunnel: false },
    ]);
  });

  it("a tunnel hostname never stands in for a needed credential", async () => {
    const needsKey = syncRow(syncServer("srv-web1", "web-1", "203.0.113.11"), {
      status: "blocked",
      cause: "needs-credential",
      mode: "termix",
    }) as SyncRow;
    await mount({
      syncPreview: vi.fn<Api["syncPreview"]>().mockResolvedValue([needsKey]),
    });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: locales.sync.viaTunnel }),
    );
    fireEvent.change(
      screen.getByPlaceholderText(locales.sync.tunnelHostnamePlaceholder),
      { target: { value: "ssh-web1.example.test" } },
    );
    expect(
      screen.getByRole("checkbox", { name: locales.sync.include }),
    ).toHaveProperty("disabled", true);
  });

  it("is not offered for a server Coolify already tunnels", async () => {
    const tunnelled = syncRow(
      syncServer("srv-vps1", "vps1", "ssh-vps1.example.test", {
        isTunnel: true,
      }),
    ) as SyncRow;
    await mount({
      syncPreview: vi.fn<Api["syncPreview"]>().mockResolvedValue([tunnelled]),
    });
    expect(await screen.findByText("vps1")).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: locales.sync.viaTunnel }),
    ).toBeNull();
  });
});
