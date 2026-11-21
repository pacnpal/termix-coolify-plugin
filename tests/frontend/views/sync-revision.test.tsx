import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import type { Api, Connection, SyncRow } from "../../../src/frontend/api";
import { SyncView } from "../../../src/frontend/views/SyncView";
import locales from "../../../locales/en.json";
import {
  ALL,
  connectionFixture,
  manifest,
  renderApp,
  renderHostSection,
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

function rowsNamed(name: string): SyncRow[] {
  return [syncRow(syncServer(`srv-${name}`, name, "203.0.113.11")) as SyncRow];
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("sync preview after a target change (#39)", () => {
  async function mountSync(syncPreview: Api["syncPreview"]) {
    // A test-only tab type that renders the view, so its connection can change.
    const contributes = manifest.contributes ?? {};
    rendered = await renderWithApp(plugin, {
      manifest: {
        ...manifest,
        contributes: {
          ...contributes,
          tabs: [
            ...(contributes.tabs ?? []),
            { id: "coolify-sync-probe", titleKey: "tab.title", icon: "Rocket" },
          ],
        },
      } as PluginManifest,
      locales,
      api: stubClient({}),
      permissions: ALL,
    });
    const api = { syncPreview } as unknown as Api;
    let retarget: (revision: string) => void = () => {};
    function Probe() {
      const [revision, setRevision] = useState("rev-a");
      retarget = setRevision;
      return (
        <SyncView
          api={api}
          connection={connectionFixture({ revision }) as unknown as Connection}
        />
      );
    }
    rendered.app.registerTab("coolify-sync-probe", Probe, {
      titleKey: "tab.title",
    });
    rendered.renderTab("coolify-sync-probe", {
      tab: { id: "p1", type: "coolify-sync-probe", label: "Probe" },
    });
    return { retarget: (revision: string) => act(() => retarget(revision)) };
  }

  it("the Servers preview reloads and clears the old rows when the revision changes", async () => {
    const next = deferred<SyncRow[]>();
    const syncPreview = vi
      .fn<Api["syncPreview"]>()
      .mockResolvedValueOnce(rowsNamed("old-target"))
      .mockReturnValueOnce(next.promise);
    const { retarget } = await mountSync(syncPreview);
    expect(await screen.findByText("old-target")).toBeTruthy();

    retarget("rev-b");
    await waitFor(() => expect(syncPreview).toHaveBeenCalledTimes(2));
    // The old target's rows are gone while the new preview loads.
    expect(screen.queryByText("old-target")).toBeNull();
    await act(async () => next.resolve(rowsNamed("new-target")));
    expect(await screen.findByText("new-target")).toBeTruthy();
  });

  it("a late answer for the old revision is dropped", async () => {
    const old = deferred<SyncRow[]>();
    const syncPreview = vi
      .fn<Api["syncPreview"]>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(rowsNamed("new-target"));
    const { retarget } = await mountSync(syncPreview);
    retarget("rev-b");
    expect(await screen.findByText("new-target")).toBeTruthy();
    await act(async () => old.resolve(rowsNamed("old-target")));
    expect(screen.queryByText("old-target")).toBeNull();
    expect(screen.getByText("new-target")).toBeTruthy();
  });
});

function linkedHost(connectionId: number): PluginHostRecord {
  return {
    id: 7,
    name: "web",
    ip: "203.0.113.11",
    port: 22,
    pluginSettings: {
      coolify: {
        coolifyLinked: true,
        coolifyConnectionId: String(connectionId),
        coolifyServerUuid: "srv-web1",
      },
    },
  } as unknown as PluginHostRecord;
}

describe("Linked host card after a target change (#39)", () => {
  it("a new revision does not reuse the cached preview of the old target", async () => {
    // Its own connection id, so other tests' cached previews aren't used.
    const id = 41;
    let target = { revision: "rev-a", server: "old-name" };
    const client = stubClient({
      get: async (url) => ({
        data: url.endsWith("/servers")
          ? [
              syncRow(syncServer("srv-web1", target.server, "203.0.113.11"), {
                status: "linked",
                hostId: 7,
              }),
            ]
          : { id, name: "Prod", revision: target.revision },
      }),
    });
    rendered = await renderApp(client);
    const linkedText = (server: string) =>
      locales.hostSection.linked
        .replace("{{server}}", server)
        .replace("{{connection}}", "Prod");

    renderHostSection(linkedHost(id), {});
    expect(await screen.findByText(linkedText("old-name"))).toBeTruthy();
    cleanup();

    // The connection's address or token changed: a new revision, new servers.
    target = { revision: "rev-b", server: "new-name" };
    renderHostSection(linkedHost(id), {});
    expect(await screen.findByText(linkedText("new-name"))).toBeTruthy();
  });
});
