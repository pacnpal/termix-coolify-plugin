import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  configure,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";

// The console renders the whole operation list; under a loaded parallel run one
// step can pass the default 1 s wait (#50). Nothing here is timing-sensitive.
configure({ asyncUtilTimeout: 3000 });

const manifest = manifestJson as unknown as PluginManifest;
const L = locales.apiConsole;
const ENV_VALUE = "fake-env-value-console-ui";

function connection(sensitive: boolean) {
  return {
    id: 1,
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    teamName: "Ops",
    version: "v4.7.5",
    scoped: false,
    abilities: { read: true, sensitive, keys: false, root: false, mcp: false },
    lastError: null,
    autoSync: false,
    access: "owner",
    allowPrivate: false,
    caCert: null,
    cfAccess: false,
    lastCheckedAt: null,
    steps: [],
  };
}

const OPERATIONS = [
  {
    id: "list-servers",
    method: "GET",
    path: "/servers",
    minVersion: "4.4.0",
    permission: "coolify.view",
    sensitive: false,
    summary: "List",
    params: [],
    body: null,
  },
  {
    id: "list-envs-by-application-uuid",
    method: "GET",
    path: "/applications/{uuid}/envs",
    minVersion: "4.4.0",
    permission: "coolify.view",
    sensitive: true,
    summary: "List Envs",
    params: [{ name: "uuid", in: "path", required: true, type: "string" }],
    body: null,
  },
  {
    id: "deploy-by-tag-or-uuid",
    method: "POST",
    path: "/deploy",
    minVersion: "4.4.0",
    permission: "coolify.operate",
    sensitive: false,
    summary: "Deploy",
    params: [{ name: "uuid", in: "query", required: false, type: "string" }],
    body: null,
  },
  {
    id: "delete-application-by-uuid",
    method: "DELETE",
    path: "/applications/{uuid}",
    minVersion: "4.4.0",
    permission: "coolify.administer",
    sensitive: true,
    summary: "Delete",
    params: [{ name: "uuid", in: "path", required: true, type: "string" }],
    body: null,
  },
  {
    id: "update-server-proxy",
    method: "PATCH",
    path: "/servers/{uuid}/proxy",
    minVersion: "4.4.0",
    permission: "coolify.configure",
    sensitive: false,
    summary: "Update proxy",
    params: [{ name: "uuid", in: "path", required: true, type: "string" }],
    body: [
      { name: "redirect_url", type: "string", nullable: true, required: false },
    ],
  },
];

/** A promise and the function that settles it, for ordering answers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stubApi(sensitive = true) {
  const mocks = {
    get: vi.fn(async (url: string) => {
      if (url === "/connections") return { data: [connection(sensitive)] };
      if (url === "/connections/1/api/operations") {
        return { data: { operations: OPERATIONS } };
      }
      if (url === "/mcp") return { data: { endpoint: "https://t.test/mcp" } };
      return { data: {} };
    }),
    post: vi.fn(async (url: string, body: { operationId?: string }) => {
      if (url === "/connections/1/api/reveal") {
        return { data: { value: ENV_VALUE } };
      }
      if (body?.operationId === "list-envs-by-application-uuid") {
        return {
          data: {
            method: "GET",
            operationId: "list-envs-by-application-uuid",
            path: "/applications/{uuid}/envs",
            request: { params: { uuid: "app-web-uuid" } },
            data: [{ key: "API_SECRET", value: "[redacted]" }],
            masked: [[0, "value"]],
          },
        };
      }
      return {
        data: {
          method: "GET",
          operationId: body?.operationId,
          path: "/servers",
          request: { params: {} },
          data: [{ uuid: "srv-1", name: "one" }],
          masked: [],
        },
      };
    }),
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

async function openConsole(permissions: string[], sensitive = true) {
  const api = stubApi(sensitive);
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click((await screen.findAllByRole("button", { name: L.title }))[0]);
  await screen.findByText("list-servers");
  return api;
}

function fillUuid() {
  fireEvent.change(screen.getByPlaceholderText("uuid"), {
    target: { value: "app-web-uuid" },
  });
}

/** Runs the env list read, confirms it, and waits for its masked values. */
async function runEnvs() {
  await openOperation("list-envs-by-application-uuid");
  fillUuid();
  fireEvent.click(screen.getByRole("button", { name: L.run }));
  fireEvent.click(await screen.findByRole("button", { name: L.confirmLabel }));
  expect(await screen.findByText(L.masked)).toBeTruthy();
}

async function openOperation(id: string) {
  fireEvent.click(screen.getByText(id));
  await screen.findByRole("button", { name: L.run });
}

const VIEW = ["coolify.view"];
const CONFIGURE = ["coolify.view", "coolify.operate", "coolify.configure"];
const ADMIN = [...CONFIGURE, "coolify.administer"];

describe("API console", () => {
  it("lists the operations the backend offers for the connection", async () => {
    const api = await openConsole(VIEW);
    expect(api.get).toHaveBeenCalledWith("/connections/1/api/operations");
    expect(screen.getByText("list-envs-by-application-uuid")).toBeTruthy();
  });

  it("a GET operation runs without confirm", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = await openConsole(VIEW);
    await openOperation("list-servers");
    fireEvent.click(screen.getByRole("button", { name: L.run }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/api/call", {
        operationId: "list-servers",
        params: {},
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: L.confirmLabel })).toBeNull();
    expect(await screen.findByText(/srv-1/)).toBeTruthy();
  });

  it("builds the request from the generated form; a read of secrets asks first", async () => {
    const api = await openConsole(VIEW);
    await openOperation("list-envs-by-application-uuid");
    fillUuid();
    fireEvent.click(screen.getByRole("button", { name: L.run }));
    const prompt = await screen.findByRole("button", { name: L.confirmLabel });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(prompt);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/api/call", {
        operationId: "list-envs-by-application-uuid",
        params: { uuid: "app-web-uuid" },
        confirmed: true,
      }),
    );
  });

  it("a change asks for a confirm before it runs", async () => {
    const api = await openConsole(CONFIGURE);
    await openOperation("deploy-by-tag-or-uuid");
    fireEvent.click(screen.getByRole("button", { name: L.run }));
    const prompt = await screen.findByRole("button", { name: L.confirmLabel });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(prompt);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/api/call",
        expect.objectContaining({
          operationId: "deploy-by-tag-or-uuid",
          confirmed: true,
        }),
      ),
    );
  });

  it("DELETE needs typed confirm and coolify.administer", async () => {
    {
      const api = await openConsole(CONFIGURE);
      await openOperation("delete-application-by-uuid");
      expect(screen.getByText(L.needsPermission)).toBeTruthy();
      const run = screen.getByRole("button", { name: L.run });
      expect((run as HTMLButtonElement).disabled).toBe(true);
      expect(api.post).not.toHaveBeenCalled();
      await rendered!.deactivate();
      rendered = null;
      cleanup();
    }
    const api = await openConsole(ADMIN);
    await openOperation("delete-application-by-uuid");
    fillUuid();
    const run = screen.getByRole("button", { name: L.run });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(L.typeToConfirmPlaceholder), {
      target: { value: "delete" },
    });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(L.typeToConfirmPlaceholder), {
      target: { value: "delete-application-by-uuid" },
    });
    expect((run as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/api/call", {
        operationId: "delete-application-by-uuid",
        params: { uuid: "app-web-uuid" },
        confirmed: true,
        confirmText: "delete-application-by-uuid",
      }),
    );
  });

  it("values are masked with a reveal button only for configure plus a sensitive token", async () => {
    const api = await openConsole(CONFIGURE);
    await runEnvs();
    expect(screen.queryByText(ENV_VALUE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: L.reveal }));
    expect(await screen.findByText(ENV_VALUE)).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/connections/1/api/reveal", {
      operationId: "list-envs-by-application-uuid",
      params: { uuid: "app-web-uuid" },
      pointer: [0, "value"],
    });
    fireEvent.click(screen.getByRole("button", { name: L.hide }));
    expect(screen.queryByText(ENV_VALUE)).toBeNull();
  });

  it.each([
    ["without coolify.configure", VIEW, true, L.revealNeedsConfigure],
    [
      "when the token can't read secrets",
      CONFIGURE,
      false,
      L.revealNeedsSensitive,
    ],
  ])("offers no reveal %s", async (_case, permissions, sensitive, reason) => {
    await openConsole(permissions, sensitive);
    await runEnvs();
    expect(screen.queryByRole("button", { name: L.reveal })).toBeNull();
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it("an earlier reveal that finishes after a later reveal and hide shows nothing", async () => {
    const api = await openConsole(CONFIGURE);
    await runEnvs();
    const first = deferred<{ data: { value: string } }>();
    const base = api.post.getMockImplementation()!;
    let reveals = 0;
    api.post.mockImplementation(async (url: string, body: never) => {
      if (url === "/connections/1/api/reveal") {
        reveals++;
        return reveals === 1 ? first.promise : { data: { value: "value-B" } };
      }
      return base(url, body);
    });
    fireEvent.click(screen.getByRole("button", { name: L.reveal }));
    await waitFor(() => expect(reveals).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: L.reveal }));
    expect(await screen.findByText("value-B")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: L.hide }));
    first.resolve({ data: { value: "value-A" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("value-A")).toBeNull();
    expect(screen.queryByText("value-B")).toBeNull();
  });

  it("a connection's operation list that answers after switching away is dropped", async () => {
    const api = stubApi();
    const base = api.get.getMockImplementation()!;
    const stale = deferred<{ data: { operations: unknown[] } }>();
    (api.get as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        if (url === "/connections") {
          return {
            data: [connection(true), { ...connection(true), id: 2, name: "B" }],
          };
        }
        if (url === "/connections/1/api/operations") return stale.promise;
        if (url === "/connections/2/api/operations") {
          return { data: { operations: OPERATIONS } };
        }
        return base(url);
      },
    );
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: VIEW,
    });
    rendered.renderTab("coolify", { isVisible: true });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: L.title }))[0],
    );
    const picker = await screen.findByRole("combobox", { name: L.connection });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/connections/1/api/operations"),
    );
    // A Radix select: open it from the keyboard and pick B. jsdom has no
    // scrollIntoView, which the open list calls.
    Element.prototype.scrollIntoView = () => {};
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "B" }));
    expect(await screen.findByText("list-servers")).toBeTruthy();
    stale.resolve({
      data: { operations: [{ ...OPERATIONS[0], id: "stale-operation" }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("stale-operation")).toBeNull();
    expect(screen.getByText("list-servers")).toBeTruthy();
  });

  it("Refresh loads the connections again after they failed to load", async () => {
    const api = stubApi();
    const base = api.get.getMockImplementation()!;
    let offline = false;
    api.get.mockImplementation(async (url: string) => {
      if (url === "/connections" && offline) throw new Error("offline");
      return base(url);
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: VIEW,
    });
    rendered.renderTab("coolify", { isVisible: true });
    const nav = (await screen.findAllByRole("button", { name: L.title }))[0];
    offline = true;
    fireEvent.click(nav);
    expect(await screen.findByText(L.loadFailed)).toBeTruthy();
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(await screen.findByText("list-servers")).toBeTruthy();
  });

  it("a nullable field can send null, apart from leaving it out", async () => {
    const api = await openConsole(CONFIGURE);
    await openOperation("update-server-proxy");
    fillUuid();
    fireEvent.click(
      screen.getByRole("switch", {
        name: L.sendNull.replace("{{field}}", "redirect_url"),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: L.run }));
    fireEvent.click(
      await screen.findByRole("button", { name: L.confirmLabel }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/connections/1/api/call", {
        operationId: "update-server-proxy",
        params: { uuid: "app-web-uuid" },
        body: { redirect_url: null },
        confirmed: true,
      }),
    );
  });
});
