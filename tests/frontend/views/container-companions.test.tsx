import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import { forgetCompanions } from "../../../src/frontend/companions";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { stubApi } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const C = locales.containerCompanions;
const OPERATE = ["coolify.view", "coolify.operate"];

const host = {
  id: 7,
  userId: "user-1",
  name: "vps1",
  ip: "203.0.113.5",
  port: 22,
  username: "deploy",
  authType: "credential",
  folder: "Coolify",
  tags: "coolify",
  pluginSettings: {
    coolify: {
      coolifyLinked: true,
      coolifyConnectionId: "1",
      coolifyServerUuid: "srv-vps1-uuid",
    },
  },
};

const NONE = {
  files: false,
  tunnels: false,
  reverseProxy: false,
  dns: false,
  uptime: false,
  logSearch: false,
  packageManager: false,
  securityCenter: false,
  hostMetrics: false,
  databases: false,
  backups: false,
};

const PATHS = {
  hostId: 7,
  dataDir: "/data/coolify/applications/app-web-uuid",
  composeFile: "/data/coolify/applications/app-web-uuid/docker-compose.yaml",
  volumes: ["/srv/uploads"],
};

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  forgetCompanions();
  vi.restoreAllMocks();
});

/** The usual stub, plus /companions, /paths, /tunnel and /web-ui. */
function companionApi(running: Partial<typeof NONE>) {
  const api = stubApi();
  const get = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (url === "/companions") return { data: { ...NONE, ...running } };
    if (/\/resources\/app-web-uuid\/paths/.test(url)) return { data: PATHS };
    return get(url);
  });
  const post = async (url: string) => {
    if (/\/tunnel$/.test(url)) {
      return {
        data: {
          name: "web:7:coolify-app-web-uuid",
          hostId: 7,
          targetPort: 3000,
          bindHost: "127.0.0.1",
          bindPort: 41234,
        },
      };
    }
    if (/\/web-ui$/.test(url)) {
      return { data: { url: "https://e-1.apps.example.test/?once=fake" } };
    }
    return { data: {} };
  };
  api.post.mockImplementation(post as never);
  return api;
}

async function openWeb(running: Partial<typeof NONE>, permissions = OPERATE) {
  const api = companionApi(running);
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
    hosts: [host],
  });
  const tab = rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await within(tab).findByRole("button", { name: locales.nav.resources }),
  );
  await within(tab).findByText("web");
  fireEvent.click(
    within(tab)
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-name") === "web")!,
  );
  await screen.findByText(locales.detail.fields.coolifyStatus);
  return { api, rendered };
}

const button = (name: string) => screen.queryByRole("button", { name });

describe("container companion buttons", () => {
  it("buttons hide when a plugin is missing", async () => {
    const all = { files: true, tunnels: true, reverseProxy: true };
    const buttons = {
      files: [C.browse, C.editCompose],
      tunnels: [C.reach],
      reverseProxy: [C.webUi],
    };
    for (const missing of Object.keys(buttons) as Array<keyof typeof all>) {
      await openWeb({ ...all, [missing]: false });
      const shown = Object.entries(buttons)
        .filter(([key]) => key !== missing)
        .flatMap(([, names]) => names);
      for (const name of shown) {
        expect(await screen.findByRole("button", { name })).toBeTruthy();
      }
      for (const name of buttons[missing]) expect(button(name)).toBeNull();
      await rendered?.deactivate();
      rendered = null;
      cleanup();
      forgetCompanions();
    }
    // With none running, none show.
    await openWeb({});
    await waitFor(() => expect(button(C.browse)).toBeNull());
    expect(button(C.editCompose)).toBeNull();
    expect(button(C.reach)).toBeNull();
    expect(button(C.webUi)).toBeNull();
  });

  it("shows only the buttons of the plugins that run", async () => {
    await openWeb({ files: true });
    expect(await screen.findByRole("button", { name: C.browse })).toBeTruthy();
    expect(button(C.editCompose)).toBeTruthy();
    expect(button(C.reach)).toBeNull();
    expect(button(C.webUi)).toBeNull();
  });

  it("shows tunnel and web UI buttons when Tunnels and Reverse Proxy run", async () => {
    await openWeb({ tunnels: true, reverseProxy: true });
    expect(await screen.findByRole("button", { name: C.reach })).toBeTruthy();
    expect(button(C.webUi)).toBeTruthy();
    expect(button(C.browse)).toBeNull();
  });

  it("hides every companion button without coolify.operate", async () => {
    await openWeb({ files: true, tunnels: true, reverseProxy: true }, [
      "coolify.view",
    ]);
    await waitFor(() => expect(button(C.browse)).toBeNull());
    expect(button(C.reach)).toBeNull();
    expect(button(C.webUi)).toBeNull();
  });

  it("browse files invokes files.openHost with the data folder", async () => {
    const { rendered: r } = await openWeb({ files: true });
    // File Manager stands in: its actions record what they were asked.
    const calls: unknown[][] = [];
    for (const id of ["files.openHost", "files.openEditor"]) {
      r.app.registerAction(id, (...args: unknown[]) => {
        calls.push([id, ...args]);
      });
    }
    const invoked = () => calls;
    const browse = await screen.findByRole("button", { name: C.browse });
    await waitFor(() => expect(browse.hasAttribute("disabled")).toBe(false));
    fireEvent.click(browse);
    await waitFor(() => expect(invoked().length).toBe(1));
    expect(invoked()[0]![0]).toBe("files.openHost");
    expect(String((invoked()[0]![1] as { id: unknown }).id)).toBe("7");
    expect(invoked()[0]![2]).toBe("/data/coolify/applications/app-web-uuid");

    fireEvent.click(screen.getByRole("button", { name: C.editCompose }));
    await waitFor(() => expect(invoked().length).toBe(2));
    expect(invoked()[1]![0]).toBe("files.openEditor");
    expect(invoked()[1]![2]).toBe(
      "/data/coolify/applications/app-web-uuid/docker-compose.yaml",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: C.volume.replace("{{path}}", "/srv/uploads"),
      }),
    );
    await waitFor(() => expect(invoked().length).toBe(3));
    expect(invoked()[2]).toEqual([
      "files.openHost",
      expect.anything(),
      "/srv/uploads",
    ]);
  });

  it("reach from here forwards a port and stop closes it", async () => {
    const { api } = await openWeb({ tunnels: true });
    fireEvent.click(await screen.findByRole("button", { name: C.reach }));
    fireEvent.change(screen.getByLabelText(C.port), {
      target: { value: "3000" },
    });
    fireEvent.click(screen.getByRole("button", { name: C.forward }));
    expect(
      await screen.findByText(
        C.listening
          .replace("{{bindHost}}", "127.0.0.1")
          .replace("{{bindPort}}", "41234"),
      ),
    ).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/tunnel",
      { port: 3000 },
    );
    fireEvent.click(screen.getByRole("button", { name: C.stop }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/tunnel/3000",
      ),
    );
  });

  it("open web UI shows the one-time link, and the reason when the proxy isn't set up", async () => {
    const { api } = await openWeb({ reverseProxy: true });
    fireEvent.click(await screen.findByRole("button", { name: C.webUi }));
    fireEvent.change(screen.getByLabelText(C.port), {
      target: { value: "8080" },
    });
    fireEvent.click(screen.getByRole("button", { name: C.open }));
    const link = await screen.findByRole("link", { name: C.openLink });
    expect(link.getAttribute("href")).toBe(
      "https://e-1.apps.example.test/?once=fake",
    );
    api.post.mockRejectedValueOnce(
      Object.assign(new Error("status 409"), {
        response: {
          status: 409,
          data: { cause: "proxy-not-configured", error: "x" },
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: C.open }));
    expect(await screen.findByText(C.errors.proxyNotConfigured)).toBeTruthy();
  });
});

describe("Coolify view in the Tunnels tab", () => {
  it("adds a Coolify view to tunnels.views that forwards a resource's port", async () => {
    const api = companionApi({ tunnels: true });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: OPERATE,
      hosts: [host],
    });
    const r = rendered;
    await waitFor(() =>
      expect(r.registered.extensions("tunnels.views")).toEqual([
        "coolify.resources",
      ]),
    );
    const view = rendered.renderExtension(
      "tunnels.views",
      "coolify.resources",
      "view",
      { host },
    );
    // Only resources on this host's Coolify server, with a port to forward.
    const row = await within(view).findByRole("group", { name: "web" });
    expect(within(view).queryByRole("group", { name: "api" })).toBeNull();
    fireEvent.change(within(row).getByLabelText(C.port), {
      target: { value: "3000" },
    });
    fireEvent.click(within(row).getByRole("button", { name: C.forward }));
    expect(
      await within(row).findByText(
        C.listening
          .replace("{{bindHost}}", "127.0.0.1")
          .replace("{{bindPort}}", "41234"),
      ),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: C.stop }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/tunnel/3000",
      ),
    );
    expect(within(view).getByText(C.localNote)).toBeTruthy();
  });

  it("isn't added without coolify.operate", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: companionApi({ tunnels: true }),
      permissions: ["coolify.view"],
      hosts: [host],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rendered.registered.extensions("tunnels.views")).toEqual([]);
  });

  it("says Tunnels is needed when it isn't running", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: companionApi({}),
      permissions: OPERATE,
      hosts: [host],
    });
    const r = rendered;
    await waitFor(() =>
      expect(r.registered.extensions("tunnels.views")).toHaveLength(1),
    );
    const view = rendered.renderExtension(
      "tunnels.views",
      "coolify.resources",
      "view",
      { host },
    );
    expect(await within(view).findByText(C.tunnelsMissing)).toBeTruthy();
    expect(within(view).queryByRole("button", { name: C.forward })).toBeNull();
  });
});
