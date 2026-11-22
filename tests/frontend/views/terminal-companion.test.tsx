import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentType } from "react";
import {
  checkFrameApp,
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type {
  CompanionOptions,
  CompanionProps,
  PluginHostRecord,
  PluginTabRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import locales from "../../../locales/en.json";
import { connection, resourceAnswer, resourceRows } from "../fixtures";
import { manifest, renderCompanion, stubClient } from "../helpers";

const L = locales.terminalCompanion;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function host(
  id: number,
  settings: Record<string, unknown> | null,
): PluginHostRecord {
  return {
    id,
    userId: "user-1",
    name: `host-${id}`,
    ip: "203.0.113.11",
    port: 22,
    username: "root",
    authType: "credential",
    pluginSettings: settings ? { coolify: settings } : {},
  } as unknown as PluginHostRecord;
}

/** web-1 is on vps1 (connection 1), edge-1 on edge (connection 2). */
const vps1 = host(7, {
  coolifyLinked: true,
  coolifyConnectionId: "1",
  coolifyServerUuid: "srv-vps1-uuid",
});
const edge = host(8, {
  coolifyLinked: true,
  coolifyConnectionId: "2",
  coolifyServerUuid: "srv-edge-uuid",
});
const ordinary = host(9, null);

const edgeConnection = { ...connection, id: 2, name: "Edge", revision: "e1" };

/** Connection 2's own answer: only edge-api, on the edge server. */
const edgeAnswer = {
  ...resourceAnswer,
  rows: [
    {
      ...resourceRows.find((r) => r.name === "api")!,
      uuid: "app-edge-api-uuid",
      name: "edge-api",
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A client answering connections 1 and 2 and their resources. */
function client(
  opts: {
    access?: string;
    resources?: Record<number, Promise<unknown>>;
  } = {},
) {
  return stubClient({
    get: async (url) => {
      const res = /^\/connections\/(\d+)\/resources(\?|$)/.exec(url);
      if (res) {
        const pending = opts.resources?.[Number(res[1])];
        if (pending) return { data: await pending };
        return { data: res[1] === "2" ? edgeAnswer : resourceAnswer };
      }
      if (url === "/connections/1") {
        return { data: { ...connection, access: opts.access ?? "owner" } };
      }
      if (url === "/connections/2") return { data: edgeConnection };
      return { data: {} };
    },
  });
}

const terminalTab = (h?: PluginHostRecord) =>
  ({
    id: 1,
    type: "terminal",
    label: "t",
    host: h,
  }) as never as PluginTabRecord;

function props(h: PluginHostRecord | undefined): CompanionProps {
  return {
    tab: terminalTab(h),
    host: h,
    getHandle: () => null,
    side: "right",
    isVisible: true,
    close: () => undefined,
    setSide: () => undefined,
  };
}

interface Registered {
  component: ComponentType<CompanionProps>;
  options: CompanionOptions;
}

/**
 * Runs the plugin with the test app, keeping what it passed to
 * registerCompanion for "coolify" on the way through.
 */
async function activateCapturing(
  api: ReturnType<typeof client>,
  permissions: string[],
): Promise<Registered> {
  let found: Registered | null = null;
  const capturing = {
    activate(app: TermixApp) {
      const seen = new Proxy(app, {
        get(target, key, receiver) {
          if (key === "registerCompanion") {
            return (
              id: string,
              component: ComponentType<CompanionProps>,
              options: CompanionOptions = {},
            ) => {
              if (id === "coolify") found = { component, options };
              return target.registerCompanion(id, component, options);
            };
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      return plugin.activate(seen);
    },
  };
  rendered = await renderWithApp(capturing, {
    manifest,
    locales,
    api,
    permissions,
  });
  if (!found) throw new Error("no coolify companion registered");
  return found;
}

async function show(
  h: PluginHostRecord | undefined,
  api = client(),
  permissions = OPERATE,
) {
  const { component } = await activateCapturing(api, permissions);
  const { view, rerender } = renderCompanion(rendered!, component, props(h));
  return {
    view,
    rerender: (next: PluginHostRecord | undefined) => rerender(props(next)),
    api,
    r: rendered!,
  };
}

const label = (text: string, name: string) => text.replace("{{name}}", name);

describe("terminal companion panel", () => {
  it("registers beside terminals, frame-safe", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    const companion = registrations.find((r) => r.kind === "companion");
    expect(companion).toBeTruthy();
    expect(companion!.data).toMatchObject({
      id: "coolify",
      tabTypes: ["terminal"],
    });
  });

  it("applies to Linked hosts only", async () => {
    const { options } = await activateCapturing(client(), OPERATE);
    expect(options.tabTypes).toEqual(["terminal"]);
    expect(options.when?.(terminalTab(vps1), vps1)).toBe(true);
    expect(options.when?.(terminalTab(ordinary), ordinary)).toBe(false);
    expect(options.when?.(terminalTab(), undefined)).toBe(false);
  });

  it("lists only the Linked host's server's resources", async () => {
    const { view, api } = await show(vps1);
    await within(view.container).findByText("web");
    expect(within(view.container).getByText("main-db")).toBeTruthy();
    // api runs on the edge server, not this one.
    expect(within(view.container).queryByText("api")).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/connections/1");
  });

  it("draws nothing on an unlinked host and asks nothing", async () => {
    const { view, api } = await show(ordinary);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(view.container.textContent).toBe("");
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("draws nothing without a host", async () => {
    const { view, api } = await show(undefined);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(view.container.textContent).toBe("");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("drops the previous host's rows as soon as the host changes", async () => {
    const edgeRows = deferred<unknown>();
    const api = client({ resources: { 2: edgeRows.promise } });
    const { view, rerender } = await show(vps1, api);
    await within(view.container).findByText("web");
    rerender(edge);
    // Before edge answers, nothing read for vps1 is left: not its rows, and
    // not connection 1's row for the edge server either.
    expect(within(view.container).queryByText("web")).toBeNull();
    expect(within(view.container).queryByText("main-db")).toBeNull();
    expect(within(view.container).queryByText("api")).toBeNull();
    await act(async () => edgeRows.resolve(edgeAnswer));
    await within(view.container).findByText("edge-api");
    expect(within(view.container).queryByText("web")).toBeNull();
    expect(within(view.container).queryByText("api")).toBeNull();
  });

  it("ignores the previous host's late answer", async () => {
    const vpsRows = deferred<unknown>();
    const api = client({ resources: { 1: vpsRows.promise } });
    const { view, rerender } = await show(vps1, api);
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/connections/1/resources"),
    );
    rerender(edge);
    await within(view.container).findByText("edge-api");
    // vps1's answer lands now; it holds web, and api on the edge server.
    await act(async () => vpsRows.resolve(resourceAnswer));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(within(view.container).queryByText("web")).toBeNull();
    expect(within(view.container).queryByText("api")).toBeNull();
    expect(within(view.container).getByText("edge-api")).toBeTruthy();
  });

  it("hides the actions without coolify.operate", async () => {
    const { view } = await show(vps1, client(), ["coolify.view"]);
    await within(view.container).findByText("web");
    for (const text of [L.shell, L.logs, L.restart, L.deploy]) {
      expect(
        within(view.container).queryByRole("button", {
          name: label(text, "web"),
        }),
      ).toBeNull();
    }
  });

  it("hides the actions on a connection shared only to view", async () => {
    const { view } = await show(vps1, client({ access: "view" }));
    await within(view.container).findByText("web");
    for (const text of [L.shell, L.logs, L.restart, L.deploy]) {
      expect(
        within(view.container).queryByRole("button", {
          name: label(text, "web"),
        }),
      ).toBeNull();
    }
  });

  it("offers the actions with effective operate; a Part has no Deploy", async () => {
    const { view } = await show(vps1);
    await within(view.container).findByText("web");
    for (const text of [L.shell, L.logs, L.restart, L.deploy]) {
      expect(
        await within(view.container).findByRole("button", {
          name: label(text, "web"),
        }),
      ).toBeTruthy();
    }
    expect(
      within(view.container).getByRole("button", {
        name: label(L.restart, "n8n-main"),
      }),
    ).toBeTruthy();
    expect(
      within(view.container).queryByRole("button", {
        name: label(L.deploy, "n8n-main"),
      }),
    ).toBeNull();
  });

  it("Shell opens a coolify-shell tab for that resource", async () => {
    const { view, r } = await show(vps1);
    fireEvent.click(
      await within(view.container).findByRole("button", {
        name: label(L.shell, "main-db"),
      }),
    );
    const call = r.shellCalls.find((c) => c.method === "openTab");
    expect(call).toBeTruthy();
    expect(call!.args[1]).toBe("coolify-shell");
    expect((call!.args[2] as { data: unknown }).data).toEqual({
      connectionId: 1,
      uuid: "db-main-uuid",
      console: "shell",
      revision: "rev-before",
    });
  });

  it("Restart confirms first, then runs the lifecycle action", async () => {
    const { view, api } = await show(vps1);
    fireEvent.click(
      await within(view.container).findByRole("button", {
        name: label(L.restart, "web"),
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(label(L.restartConfirm.title, "web"));
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: L.restartConfirm.confirm }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/restart",
        {},
      ),
    );
  });

  it("Deploy confirms first, and a cancel sends nothing", async () => {
    const { view, api } = await show(vps1);
    fireEvent.click(
      await within(view.container).findByRole("button", {
        name: label(L.deploy, "web"),
      }),
    );
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(label(L.deployConfirm.title, "web"));
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.click(
      within(view.container).getByRole("button", {
        name: label(L.deploy, "web"),
      }),
    );
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: L.deployConfirm.confirm }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/deploy",
        { force: false },
      ),
    );
  });

  it("Logs opens that resource's logs in the panel, and Back returns", async () => {
    const { view, api } = await show(vps1);
    fireEvent.click(
      await within(view.container).findByRole("button", {
        name: label(L.logs, "web"),
      }),
    );
    await waitFor(() =>
      expect(
        api.get.mock.calls.some(([url]) =>
          String(url).startsWith("/connections/1/resources/app-web-uuid/logs"),
        ),
      ).toBe(true),
    );
    fireEvent.click(
      within(view.container).getByRole("button", { name: L.back }),
    );
    await within(view.container).findByText("main-db");
  });

  it("covers every fixture row's server", () => {
    // The tests above rely on vps1 holding web and edge holding api.
    expect(resourceRows.find((r) => r.name === "web")?.serverUuid).toBe(
      "srv-vps1-uuid",
    );
    expect(resourceRows.find((r) => r.name === "api")?.serverUuid).toBe(
      "srv-edge-uuid",
    );
  });
});
