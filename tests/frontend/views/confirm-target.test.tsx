import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentType } from "react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import { PluginComponent, SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import * as plugin from "../../../src/frontend/index";
import {
  createApi,
  type Connection,
  type Resource,
} from "../../../src/frontend/api";
import { HostSection } from "../../../src/frontend/views/HostSection";
import { MetricsOff } from "../../../src/frontend/views/metrics-parts";
import { ConnectionsView } from "../../../src/frontend/views/ConnectionsView";
import { SyncView } from "../../../src/frontend/views/SyncView";
import { StatusPagesView } from "../../../src/frontend/views/StatusPagesView";
import { ResourceDetail } from "../../../src/frontend/views/ResourceDetail";
import locales from "../../../locales/en.json";
import { resourceRows, stubApi } from "../fixtures";
import {
  ALL,
  connectionFixture,
  manifest,
  stubClient,
  syncRow,
  syncServer,
} from "../helpers";

/**
 * #86: a confirm accepted after its view moved to another target, or went
 * away, sends nothing. Each test opens the confirm, changes the target (or
 * unmounts the view) while it is open, accepts, and expects no request.
 */

const OPERATE_ALL = [...ALL, "coolify.operate"];

let rendered: RenderedPluginApp | null = null;
let draws = 0;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

async function app(
  client: ReturnType<typeof stubClient> | ReturnType<typeof stubApi>,
  permissions = OPERATE_ALL,
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api: client,
    permissions,
  });
  return rendered;
}

/**
 * Draws `component` in the plugin's scope inside one surface, so its SDK
 * hooks work and its confirm stays open when the component goes: `rerender`
 * swaps its props (a new target) and `close` takes it away.
 */
function draw<P extends object>(
  where: RenderedPluginApp,
  component: ComponentType<P>,
  props: P,
) {
  const id = `coolify.confirm-target-${++draws}`;
  where.app.registerComponent(
    id,
    component as unknown as ComponentType<Record<string, unknown>>,
  );
  const tree = (next: P) => (
    <SurfaceScope>
      <PluginComponent id={id} {...(next as Record<string, unknown>)} />
    </SurfaceScope>
  );
  const view = render(tree(props));
  return {
    rerender: (next: P) => act(() => view.rerender(tree(next))),
    close: () => act(() => view.rerender(<SurfaceScope>{null}</SurfaceScope>)),
  };
}

/** Accepts the open confirm with its `label` button. */
async function accept(dialog: HTMLElement, label: string) {
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
  await act(async () => {});
  await new Promise((r) => setTimeout(r, 20));
}

function linkedHost(id: number, serverUuid: string): PluginHostRecord {
  return {
    id,
    name: `host-${id}`,
    ip: "203.0.113.11",
    pluginSettings: {
      coolify: {
        coolifyLinked: true,
        coolifyConnectionId: "1",
        coolifyServerUuid: serverUuid,
      },
    },
  } as unknown as PluginHostRecord;
}

describe("a confirm answered after its target changed sends nothing (#86)", () => {
  it("HostSection: unlink confirmed after the card moved to another host", async () => {
    const client = stubClient({
      get: async () => ({ data: { id: 1, name: "Prod", revision: "rev-a" } }),
    });
    const where = await app(client);
    const shell = { openSingletonTab: vi.fn() };
    const view = draw(
      where,
      HostSection as ComponentType<never>,
      {
        host: linkedHost(7, "srv-web1"),
        shell,
        isVisible: true,
      } as never,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: locales.hostSection.unlink }),
    );
    const dialog = await screen.findByRole("alertdialog");
    view.rerender({
      host: linkedHost(8, "srv-web2"),
      shell,
      isVisible: true,
    } as never);
    await accept(dialog, locales.unlinkConfirm.confirm);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("HostSection: unlink confirmed after the card closed", async () => {
    const client = stubClient({
      get: async () => ({ data: { id: 1, name: "Prod", revision: "rev-a" } }),
    });
    const where = await app(client);
    const view = draw(
      where,
      HostSection as ComponentType<never>,
      {
        host: linkedHost(7, "srv-web1"),
        shell: { openSingletonTab: vi.fn() },
        isVisible: true,
      } as never,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: locales.hostSection.unlink }),
    );
    const dialog = await screen.findByRole("alertdialog");
    view.close();
    await accept(dialog, locales.unlinkConfirm.confirm);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("MetricsOff: enable confirmed after the view moved to another server", async () => {
    const client = stubClient({});
    const where = await app(client);
    const api = createApi(client);
    const props = (serverUuid: string) => ({
      api,
      connectionId: 1,
      serverUuid,
      serverName: serverUuid,
      canEnable: true,
      onEnabled: () => {},
    });
    const view = draw(where, MetricsOff, props("srv-a"));
    fireEvent.click(
      await screen.findByRole("button", { name: locales.metrics.off.enable }),
    );
    const dialog = await screen.findByRole("alertdialog");
    view.rerender(props("srv-b"));
    await accept(dialog, locales.metrics.enableConfirm.confirm);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("ConnectionsView: remove confirmed after the list closed", async () => {
    const client = stubApi();
    const where = await app(client);
    const view = draw(where, ConnectionsView, {});
    fireEvent.click(
      await screen.findByRole("button", {
        name: locales.connections.actions.delete,
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    view.close();
    await accept(dialog, locales.connections.delete.confirm);
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("SyncView: remove host confirmed after the connection's target changed", async () => {
    const gone = syncRow(syncServer("srv-old", "old-box", "203.0.113.30"), {
      hostId: 9,
      status: "gone",
    });
    const client = stubClient({
      get: async (url) => ({
        data: url.endsWith("/servers") ? [gone] : [],
      }),
    });
    const where = await app(client);
    const api = createApi(client);
    const props = (revision: string) => ({
      api,
      connection: connectionFixture({ revision }) as unknown as Connection,
    });
    const view = draw(where, SyncView, props("rev-a"));
    fireEvent.click(
      await screen.findByRole("button", { name: locales.sync.removeHost }),
    );
    const dialog = await screen.findByRole("alertdialog");
    view.rerender(props("rev-b"));
    await accept(dialog, locales.sync.removeConfirm.confirm);
    expect(client.post).not.toHaveBeenCalled();
  });

  describe("StatusPagesView", () => {
    const page = {
      id: 5,
      connectionId: 1,
      title: "Shop status",
      resources: ["app-web-uuid"],
      createdAt: "2026-11-19T10:00:00.000Z",
    };

    async function open() {
      const client = stubClient({
        get: async (url) => ({
          data: url.endsWith("/status-pages")
            ? { allowed: true, pages: [page] }
            : { rows: [] },
        }),
      });
      const where = await app(client);
      const api = createApi(client);
      const props = (id: number, revision: string) => ({
        api,
        connection: connectionFixture({
          id,
          revision,
        }) as unknown as Connection,
        onClose: () => {},
      });
      const view = draw(where, StatusPagesView, props(1, "rev-a"));
      await screen.findByText("Shop status");
      return { client, view, props };
    }

    it("rotate confirmed after the view moved to another connection", async () => {
      const { client, view, props } = await open();
      fireEvent.click(
        screen.getByRole("button", { name: locales.statusPages.rotate.action }),
      );
      const dialog = await screen.findByRole("alertdialog");
      view.rerender(props(2, "rev-a"));
      await accept(dialog, locales.statusPages.rotate.confirm);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("revoke confirmed after the view closed", async () => {
      const { client, view } = await open();
      fireEvent.click(
        screen.getByRole("button", { name: locales.statusPages.revoke.action }),
      );
      const dialog = await screen.findByRole("alertdialog");
      view.close();
      await accept(dialog, locales.statusPages.revoke.confirm);
      expect(client.delete).not.toHaveBeenCalled();
      expect(client.post).not.toHaveBeenCalled();
    });
  });

  describe("ResourceActions", () => {
    const byUuid = (uuid: string) =>
      resourceRows.find((r) => r.uuid === uuid) as unknown as Resource;
    const rows = resourceRows as unknown as Resource[];

    async function open(resource: Resource) {
      const client = stubApi();
      const where = await app(client);
      const props = (r: Resource, revision: string) => ({
        resource: r,
        rows,
        onOpen: () => {},
        onClose: () => {},
        connectionId: 1,
        canOperate: true,
        onChanged: () => {},
        revision,
      });
      const view = draw(where, ResourceDetail, props(resource, "rev-a"));
      return { client, view, props };
    }

    const lifecyclePosts = (client: ReturnType<typeof stubApi>) =>
      (client.post.mock.calls as unknown as [string][]).filter(([url]) =>
        /\/resources\/[^/]+\/(stop|deploy|restart|start)/.test(url),
      );

    it("stop confirmed after the detail moved to another resource", async () => {
      const web = byUuid("app-web-uuid");
      const { client, view, props } = await open(web);
      fireEvent.click(
        await screen.findByRole("button", { name: locales.lifecycle.stop }),
      );
      const dialog = await screen.findByRole("alertdialog");
      view.rerender(props(byUuid("app-api-uuid"), "rev-a"));
      await accept(dialog, locales.lifecycle.stopConfirm.confirm);
      expect(lifecyclePosts(client)).toEqual([]);
    });

    it("force rebuild confirmed after the connection's target changed", async () => {
      const web = byUuid("app-web-uuid");
      const { client, view, props } = await open(web);
      fireEvent.click(
        await screen.findByRole("button", {
          name: locales.lifecycle.forceRebuild,
        }),
      );
      const dialog = await screen.findByRole("alertdialog");
      view.rerender(props(web, "rev-b"));
      await accept(dialog, locales.lifecycle.forceConfirm.confirm);
      expect(lifecyclePosts(client)).toEqual([]);
    });

    it("stop still runs when nothing changed", async () => {
      const web = byUuid("app-web-uuid");
      const { client } = await open(web);
      fireEvent.click(
        await screen.findByRole("button", { name: locales.lifecycle.stop }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await accept(dialog, locales.lifecycle.stopConfirm.confirm);
      await waitFor(() => expect(lifecyclePosts(client)).toHaveLength(1));
    });
  });
});
