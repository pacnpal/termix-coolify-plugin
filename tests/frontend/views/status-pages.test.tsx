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
import { resourceAnswer } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const S = locales.statusPages;
const ALL = ["coolify.view", "coolify.configure"];
const PAGE_URL =
  "https://termix.example.test/plugin-api/coolify/status/AAAAfakefakefakefakefakefakefakefakefakefak";

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

const page = {
  id: 5,
  connectionId: 1,
  title: "Shop status",
  resources: ["app-web-uuid"],
  createdAt: "2026-11-19T10:00:00.000Z",
};

function stubApi(pages: unknown[] = [page]) {
  const mocks = {
    get: vi.fn(async (url: string) => {
      if (url === "/connections") return { data: [connection] };
      if (url === "/connections/1/status-pages") {
        return { data: { allowed: true, pages } };
      }
      if (url.startsWith("/connections/1/resources")) {
        return { data: resourceAnswer };
      }
      return { data: {} };
    }),
    post: vi.fn(async (url: string) => ({
      data: url.endsWith("/rotate")
        ? { id: 5, url: `${PAGE_URL}-rotated` }
        : { ...page, id: 6, title: "New page", url: PAGE_URL },
    })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: { id: 5 } })),
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

async function openStatusPages(api: ReturnType<typeof stubApi>) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: ALL,
  });
  const tab = rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await screen.findByRole("button", { name: locales.nav.connections }),
  );
  await screen.findByText("Prod");
  fireEvent.click(within(tab).getByRole("button", { name: S.open }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith("/connections/1/status-pages"),
  );
  return tab;
}

describe("status page management", () => {
  it("lists the connection's pages", async () => {
    const api = stubApi();
    await openStatusPages(api);
    expect(await screen.findByText("Shop status")).toBeTruthy();
  });

  it("resource picker saves chosen uuids", async () => {
    const api = stubApi([]);
    await openStatusPages(api);
    fireEvent.change(
      await screen.findByPlaceholderText(S.form.titlePlaceholder),
      {
        target: { value: "New page" },
      },
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "api" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "web" }));
    fireEvent.click(screen.getByRole("button", { name: S.form.create }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/status-pages", {
        title: "New page",
        resources: ["app-web-uuid", "app-api-uuid"],
      }),
    );
  });

  it("token shown once after create", async () => {
    const api = stubApi([]);
    await openStatusPages(api);
    fireEvent.change(
      await screen.findByPlaceholderText(S.form.titlePlaceholder),
      {
        target: { value: "New page" },
      },
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "web" }));
    fireEvent.click(screen.getByRole("button", { name: S.form.create }));
    expect(await screen.findByText(PAGE_URL)).toBeTruthy();
    expect(screen.getByText(S.created.description)).toBeTruthy();
    expect(screen.getByRole("button", { name: S.created.copy })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: S.created.done }));
    await waitFor(() => expect(screen.queryByText(PAGE_URL)).toBeNull());
    expect(document.body.textContent).not.toContain(PAGE_URL);
  });

  it("rotate confirms and shows the new link once", async () => {
    const api = stubApi();
    await openStatusPages(api);
    await screen.findByText("Shop status");
    fireEvent.click(screen.getByRole("button", { name: S.rotate.action }));
    const prompt = await screen.findByRole("alertdialog");
    expect(
      within(prompt).getByText(
        S.rotate.title.replace("{{name}}", "Shop status"),
      ),
    ).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(
      within(prompt).getByRole("button", { name: S.rotate.confirm }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/status-pages/5/rotate"),
    );
    expect(await screen.findByText(`${PAGE_URL}-rotated`)).toBeTruthy();
  });

  it("revoke confirms", async () => {
    const api = stubApi();
    await openStatusPages(api);
    await screen.findByText("Shop status");
    fireEvent.click(screen.getByRole("button", { name: S.revoke.action }));
    const prompt = await screen.findByRole("alertdialog");
    expect(
      within(prompt).getByText(
        S.revoke.title.replace("{{name}}", "Shop status"),
      ),
    ).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: S.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: S.revoke.action }));
    const again = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(again).getByRole("button", { name: S.revoke.confirm }),
    );
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/status-pages/5"),
    );
    await waitFor(() => expect(screen.queryByText("Shop status")).toBeNull());
  });

  it("says when an admin turned status pages off", async () => {
    const api = stubApi();
    api.get.mockImplementation(async (url: string) => {
      if (url === "/connections") return { data: [connection] };
      if (url === "/connections/1/status-pages") {
        return { data: { allowed: false, pages: [] } };
      }
      return { data: resourceAnswer };
    });
    await openStatusPages(api);
    expect(await screen.findByText(S.off)).toBeTruthy();
    expect(screen.queryByRole("button", { name: S.form.create })).toBeNull();
  });
});
