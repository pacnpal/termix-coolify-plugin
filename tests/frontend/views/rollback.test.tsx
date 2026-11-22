import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import type { Resource } from "../../../src/frontend/api";
import { RollbackView } from "../../../src/frontend/views/RollbackView";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { resourceRows, stubApi } from "../fixtures";

const real = manifestJson as unknown as PluginManifest;
/** The plugin's manifest plus a test tab that holds RollbackView. */
const manifest: PluginManifest = {
  ...real,
  contributes: {
    ...real.contributes,
    tabs: [
      ...(real.contributes?.tabs ?? []),
      {
        id: "rollback-harness",
        titleKey: "tab.title",
        icon: "History",
        openFrom: ["palette"],
      },
    ],
  },
};
const D = locales.deployments;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

const byUuid = (uuid: string) =>
  resourceRows.find((r) => r.uuid === uuid) as unknown as Resource;
const WEB = byUuid("app-web-uuid");
const API = byUuid("app-api-uuid");
const SERVICE = byUuid("svc-n8n-uuid");

function images(uuid: string, tags: string[]) {
  return {
    uuid,
    name: uuid,
    current: tags[0] ?? null,
    images: tags.map((tag, i) => ({
      tag,
      createdAt: `2026-11-1${9 - i}T10:00:00.000000Z`,
      current: i === 0,
      source: "local",
    })),
  };
}

const IMAGES = /\/resources\/([^/]+)\/rollback-images$/;
type Answer = () => Promise<unknown>;

/** A stub whose rollback-images reads answer with `answers[uuid]`. */
function rollbackApi(answers: Record<string, Answer>) {
  const api = stubApi();
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    const match = IMAGES.exec(url);
    if (!match) return fallback(url);
    return { data: await answers[match[1]]!() };
  });
  api.post.mockImplementation(async () => ({
    data: { uuid: "app-web-uuid", image: "x", deploymentUuid: "dep-rb" },
  }));
  return api;
}

function imageReads(api: ReturnType<typeof stubApi>): string[] {
  return api.get.mock.calls
    .map(([url]) => String(url))
    .filter((url) => IMAGES.test(url));
}

const controls = {
  setResource: (_r: Resource) => {},
  setMounted: (_m: boolean) => {},
};

function Harness() {
  const [resource, setResource] = useState<Resource>(WEB);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    controls.setResource = setResource;
    controls.setMounted = setMounted;
  }, []);
  return mounted ? <RollbackView connectionId={1} resource={resource} /> : null;
}

async function renderHarness(api: ReturnType<typeof stubApi>) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: OPERATE,
  });
  rendered.app.registerTab("rollback-harness", Harness, {
    titleKey: "tab.title",
    hostless: true,
  });
  rendered.renderTab("rollback-harness");
}

const rollTo = (tag: string) => D.rollbackImages.action.replace("{{tag}}", tag);

describe("rollback view", () => {
  it("lists an app's images, marks the current one and offers the others", async () => {
    const api = rollbackApi({
      "app-web-uuid": async () =>
        images("app-web-uuid", ["abc1234", "0ld3r00", "0ld3st0"]),
    });
    await renderHarness(api);
    expect(await screen.findByText("0ld3r00")).toBeTruthy();
    expect(imageReads(api)).toEqual([
      "/connections/1/resources/app-web-uuid/rollback-images",
    ]);
    expect(screen.getByText(D.rollbackImages.current)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: rollTo("abc1234") }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: rollTo("0ld3r00") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: rollTo("0ld3st0") }),
    ).toBeTruthy();
  });

  it("offers nothing and reads nothing for a service", async () => {
    const api = rollbackApi({});
    await renderHarness(api);
    act(() => controls.setResource(SERVICE));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Roll back to/ })).toBeNull();
    // Only the first render's app was read; the service never is.
    expect(imageReads(api).every((u) => u.includes("app-web-uuid"))).toBe(true);
  });

  it("rolls back only after a confirm that names the tag", async () => {
    const api = rollbackApi({
      "app-web-uuid": async () =>
        images("app-web-uuid", ["abc1234", "0ld3r00"]),
    });
    await renderHarness(api);
    fireEvent.click(
      await screen.findByRole("button", { name: rollTo("0ld3r00") }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("0ld3r00");
    expect(dialog.textContent).toContain("web");
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: D.rollbackConfirm.confirm.replace("{{tag}}", "0ld3r00"),
      }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/rollback",
        { image: "0ld3r00" },
      ),
    );
  });

  it("never shows app A's late image list after switching to app B", async () => {
    let releaseA: (value: unknown) => void = () => {};
    const api = rollbackApi({
      "app-web-uuid": () => new Promise((resolve) => (releaseA = resolve)),
      "app-api-uuid": async () =>
        images("app-api-uuid", ["b-current", "b-older"]),
    });
    await renderHarness(api);
    await waitFor(() => expect(imageReads(api)).toHaveLength(1));
    act(() => controls.setResource(API));
    expect(await screen.findByText("b-older")).toBeTruthy();
    await act(async () =>
      releaseA(images("app-web-uuid", ["a-current", "a-older"])),
    );
    await act(async () => {});
    expect(screen.queryByText("a-older")).toBeNull();
    expect(screen.queryByText("a-current")).toBeNull();
    expect(screen.getByText("b-older")).toBeTruthy();
  });

  it("switching apps while the confirm is open sends nothing", async () => {
    const api = rollbackApi({
      "app-web-uuid": async () =>
        images("app-web-uuid", ["abc1234", "0ld3r00"]),
      "app-api-uuid": async () => images("app-api-uuid", ["b-current"]),
    });
    await renderHarness(api);
    fireEvent.click(
      await screen.findByRole("button", { name: rollTo("0ld3r00") }),
    );
    const dialog = await screen.findByRole("alertdialog");
    act(() => controls.setResource(API));
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: D.rollbackConfirm.confirm.replace("{{tag}}", "0ld3r00"),
      }),
    );
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalled();
  });

  it("unmounting while the confirm is open sends nothing", async () => {
    const api = rollbackApi({
      "app-web-uuid": async () =>
        images("app-web-uuid", ["abc1234", "0ld3r00"]),
    });
    await renderHarness(api);
    fireEvent.click(
      await screen.findByRole("button", { name: rollTo("0ld3r00") }),
    );
    const dialog = await screen.findByRole("alertdialog");
    act(() => controls.setMounted(false));
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: D.rollbackConfirm.confirm.replace("{{tag}}", "0ld3r00"),
      }),
    );
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalled();
  });
});

/** Opens the coolify tab, the web application and its Deployments view. */
async function openDeployments(
  api: ReturnType<typeof stubApi>,
  permissions = OPERATE,
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await screen.findByRole("button", { name: locales.nav.resources }),
  );
  fireEvent.click(
    await waitFor(() => {
      const r = document.querySelector('[data-name="web"]');
      if (!r) throw new Error("no row");
      return r;
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: locales.detail.tabs.deployments,
    }),
  );
}

function deploymentsApi() {
  const api = rollbackApi({
    "app-web-uuid": async () => images("app-web-uuid", ["abc1234", "0ld3r00"]),
  });
  const inner = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (/\/deployments\?/.test(url)) {
      return { data: { rows: [], count: 0, skip: 0, take: 10 } };
    }
    return inner(url);
  });
  return api;
}

describe("rollback in the Deployments tab", () => {
  it("opens from the Deployments toolbar for an operator", async () => {
    const api = deploymentsApi();
    await openDeployments(api);
    fireEvent.click(
      await screen.findByRole("button", { name: D.rollbackOpen }),
    );
    expect(await screen.findByText("0ld3r00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: D.back }));
    expect(await screen.findByText(D.empty)).toBeTruthy();
  });

  it("is not offered without operate", async () => {
    const api = deploymentsApi();
    await openDeployments(api, ["coolify.view"]);
    expect(await screen.findByText(D.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: D.rollbackOpen })).toBeNull();
    expect(imageReads(api)).toEqual([]);
  });
});
