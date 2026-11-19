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

// The actor's Termix credentials, as the credential picker reads them.
const credentialList = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listCredentials: credentialList,
}));

const manifest = manifestJson as unknown as PluginManifest;
const S = locales.sync;
const ALL = ["coolify.view", "coolify.configure"];

const connection = {
  id: 1,
  name: "Prod",
  baseUrl: "https://coolify.example.test",
  teamName: "Ops",
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
  access: "owner",
  allowPrivate: false,
  caCert: null,
  cfAccess: false,
  lastCheckedAt: null,
  steps: [],
};

function server(uuid: string, name: string, ip: string, extra = {}) {
  return {
    uuid,
    name,
    ip,
    port: 22,
    user: "root",
    isTunnel: false,
    isCoolifyHost: false,
    reachable: true,
    usable: true,
    ...extra,
  };
}

function row(srv: ReturnType<typeof server>, extra: Record<string, unknown>) {
  return {
    server: srv,
    hostId: null,
    status: "new",
    mode: "coolify",
    addressOverride: null,
    suggestedAddress: null,
    credentialId: null,
    tunnel: srv.isTunnel,
    ...extra,
  };
}

const rows = [
  row(server("srv-web1", "web-1", "203.0.113.11"), {}),
  row(
    server("srv-local", "localhost", "host.docker.internal", {
      isCoolifyHost: true,
    }),
    {
      status: "blocked",
      cause: "needs-address",
      suggestedAddress: "coolify.example.test",
    },
  ),
  row(server("srv-vps1", "vps1", "ssh-vps1.example.test", { isTunnel: true }), {
    status: "blocked",
    cause: "needs-tunnel-support",
  }),
  row(server("srv-db", "db-1", "203.0.113.20"), {
    status: "blocked",
    cause: "needs-credential",
    mode: "termix",
  }),
  row(server("srv-old", "old-box", ""), { status: "gone", hostId: 9 }),
];

function stubApi(serverRows: unknown[] = rows) {
  const mocks = {
    get: vi.fn(async (url: string) => ({
      data:
        url === "/connections"
          ? [connection]
          : url === "/connections/1/servers"
            ? serverRows
            : connection,
    })),
    post: vi.fn(async (url: string) => ({
      data: url.endsWith("/sync")
        ? [
            { uuid: "srv-web1", name: "web-1", status: "created", hostId: 3 },
            {
              uuid: "srv-local",
              name: "localhost",
              status: "created",
              hostId: 4,
            },
          ]
        : { hostId: 9, removed: false },
    })),
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

async function openSync(api = stubApi()) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: ALL,
  });
  const tab = rendered.renderTab("coolify", {
    tab: {
      id: "t1",
      type: "coolify",
      label: "Coolify",
      data: { section: "sync", connectionId: 1 },
    },
  });
  await within(tab).findByText("web-1");
  return { api, tab };
}

function rowOf(tab: HTMLElement, name: string): HTMLElement {
  const el = within(tab)
    .getByText(name)
    .closest("[data-sync-row]") as HTMLElement | null;
  if (!el) throw new Error(`no row for ${name}`);
  return el;
}

function includeBox(tab: HTMLElement, name: string): HTMLElement {
  return within(rowOf(tab, name)).getByRole("checkbox", {
    name: S.include,
  });
}

describe("sync view", () => {
  it("sync blocks coolify host until address entered", async () => {
    const { api, tab } = await openSync();
    const local = rowOf(tab, "localhost");
    expect(within(local).getByText(S.causes["needs-address"])).toBeTruthy();
    expect(includeBox(tab, "localhost").hasAttribute("disabled")).toBe(true);

    const address = within(local).getByPlaceholderText("coolify.example.test");
    fireEvent.change(address, { target: { value: "10.0.0.2" } });
    await waitFor(() =>
      expect(includeBox(tab, "localhost").hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(within(tab).getByRole("button", { name: S.apply }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/sync",
        expect.anything(),
      ),
    );
    const [, body] = api.post.mock.calls.find(([url]) =>
      String(url).endsWith("/sync"),
    ) as unknown as [string, { choices: any[] }];
    const byUuid = Object.fromEntries(body.choices.map((c) => [c.uuid, c]));
    expect(byUuid["srv-local"]).toEqual({
      uuid: "srv-local",
      include: true,
      addressOverride: "10.0.0.2",
    });
    expect(byUuid["srv-web1"].include).toBe(true);
    expect(byUuid["srv-vps1"].include).toBe(false);
    expect(byUuid["srv-db"].include).toBe(false);
    expect(byUuid["srv-old"]).toBeUndefined();

    expect(await within(tab).findByText(S.results.title)).toBeTruthy();
    expect(within(tab).getAllByText(S.resultStatus.created).length).toBe(2);
  });

  it("an address suggestion can be used with one click", async () => {
    const { tab } = await openSync();
    const local = rowOf(tab, "localhost");
    fireEvent.click(
      within(local).getByRole("button", {
        name: S.useSuggested.replace("{{address}}", "coolify.example.test"),
      }),
    );
    expect(
      (
        within(local).getByPlaceholderText(
          "coolify.example.test",
        ) as HTMLInputElement
      ).value,
    ).toBe("coolify.example.test");
  });

  it("a tunnelled server is shown with the tunnel reason and can't be included", async () => {
    const { tab } = await openSync();
    const vps = rowOf(tab, "vps1");
    expect(
      within(vps).getByText(S.causes["needs-tunnel-support"]),
    ).toBeTruthy();
    expect(within(vps).getByText(S.badges.tunnel)).toBeTruthy();
    expect(includeBox(tab, "vps1").hasAttribute("disabled")).toBe(true);
  });

  it("a server without a readable key asks for a credential", async () => {
    const { tab } = await openSync();
    const db = rowOf(tab, "db-1");
    expect(within(db).getByText(S.causes["needs-credential"])).toBeTruthy();
    expect(within(db).getByText(S.credential)).toBeTruthy();
    expect(includeBox(tab, "db-1").hasAttribute("disabled")).toBe(true);
  });

  it("a server gone from Coolify offers Keep as normal host and Remove host", async () => {
    const { api, tab } = await openSync();
    const old = rowOf(tab, "old-box");
    expect(within(old).getByText(S.status.gone)).toBeTruthy();
    fireEvent.click(within(old).getByRole("button", { name: S.keepHost }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/servers/srv-old/unlink",
        { removeHost: false },
      ),
    );
    expect(
      within(old).getByRole("button", { name: S.removeHost }),
    ).toBeTruthy();
  });

  it("every server still in Coolify takes an address override", async () => {
    const { api, tab } = await openSync();
    const web1 = rowOf(tab, "web-1");
    const address = within(web1).getByPlaceholderText("203.0.113.11");
    fireEvent.change(address, { target: { value: "10.0.0.9" } });
    expect(includeBox(tab, "web-1").hasAttribute("disabled")).toBe(false);
    expect(within(rowOf(tab, "old-box")).queryByText(S.address)).toBeNull();

    fireEvent.click(within(tab).getByRole("button", { name: S.apply }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/sync",
        expect.anything(),
      ),
    );
    const [, body] = api.post.mock.calls.find(([url]) =>
      String(url).endsWith("/sync"),
    ) as unknown as [string, { choices: any[] }];
    expect(body.choices.find((c) => c.uuid === "srv-web1")).toEqual({
      uuid: "srv-web1",
      include: true,
      addressOverride: "10.0.0.9",
    });
  });

  it.each(["credential-not-found", "credential-check-failed"])(
    "a stored credential in state %s offers the credential picker",
    async (cause) => {
      credentialList.mockResolvedValue([
        { id: 7, name: "own credential 7", authType: "key" },
      ]);
      const stale = row(server("srv-app", "app-1", "203.0.113.30"), {
        status: "blocked",
        cause,
        mode: "termix",
        credentialId: 42,
      });
      const { tab } = await openSync(stubApi([...rows, stale]));
      const app = rowOf(tab, "app-1");
      expect(within(app).getByText(S.causes[cause])).toBeTruthy();
      expect(within(app).getByText(S.credential)).toBeTruthy();
      await waitFor(() => expect(credentialList).toHaveBeenCalled());
      // A deleted credential needs a new pick; one that couldn't be checked
      // may be tried again as it is.
      expect(includeBox(tab, "app-1").hasAttribute("disabled")).toBe(
        cause === "credential-not-found",
      );
    },
  );
});

describe("the Servers section", () => {
  async function openTab(
    data: Record<string, unknown>,
    api = stubApi(),
    permissions = ALL,
  ) {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions,
    });
    const tab = rendered.renderTab("coolify", {
      tab: { id: "t1", type: "coolify", label: "Coolify", data },
    });
    return { api, tab };
  }

  it("Sync servers on a connection opens the Servers section on it", async () => {
    const { tab } = await openTab({});
    fireEvent.click(
      await within(tab).findByRole("button", { name: locales.nav.connections }),
    );
    fireEvent.click(
      await within(tab).findByRole("button", {
        name: locales.connections.actions.sync,
      }),
    );
    expect(await within(tab).findByText("web-1")).toBeTruthy();
    expect(
      within(tab).getByText(S.title.replace("{{name}}", connection.name)),
    ).toBeTruthy();
  });

  it("the import menu, with no connection id, syncs the one connection", async () => {
    const { tab } = await openTab({ section: "sync" });
    expect(await within(tab).findByText("web-1")).toBeTruthy();
  });

  it("a scoped token's Servers section says why it can't sync", async () => {
    const api = stubApi();
    const scoped = { ...connection, scoped: true };
    api.get.mockImplementation(async (url: string) => ({
      data: url === "/connections" ? [scoped] : scoped,
    }));
    const { tab } = await openTab({ section: "sync", connectionId: 1 }, api);
    expect(await within(tab).findByText(S.scopedToken)).toBeTruthy();
    expect(api.get).not.toHaveBeenCalledWith("/connections/1/servers");
  });

  it("without configure there is no Servers section and no Sync action", async () => {
    const { tab } = await openTab({}, stubApi(), ["coolify.view"]);
    fireEvent.click(
      await within(tab).findByRole("button", { name: locales.nav.connections }),
    );
    await within(tab).findByText(connection.name);
    expect(
      within(tab).queryByRole("button", { name: locales.nav.servers }),
    ).toBeNull();
    expect(
      within(tab).queryByRole("button", {
        name: locales.connections.actions.sync,
      }),
    ).toBeNull();
  });
});
