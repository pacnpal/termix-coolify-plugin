import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { stubApi } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const L = locales.lifecycle;
const OPERATE = ["coolify.view", "coolify.operate"];

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

async function openDetail(
  name: string,
  permissions = OPERATE,
  api = stubApi(),
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  const tab = rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await within(tab).findByRole("button", { name: locales.nav.resources }),
  );
  await within(tab).findByText("web");
  fireEvent.click(
    within(tab)
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-name") === name)!,
  );
  await screen.findByText(locales.detail.fields.coolifyStatus);
  return { tab, api };
}

/** The confirm dialog, its text, and a way to answer it. */
async function confirmDialog() {
  const dialog = await screen.findByRole("alertdialog");
  return {
    text: dialog.textContent ?? "",
    accept: (label: string) =>
      fireEvent.click(within(dialog).getByRole("button", { name: label })),
  };
}

describe("resource detail lifecycle actions", () => {
  it("stop asks for confirm naming the resource", async () => {
    const { api } = await openDetail("web");
    fireEvent.click(screen.getByRole("button", { name: L.stop }));
    const dialog = await confirmDialog();
    expect(dialog.text).toContain(
      L.stopConfirm.title.replace("{{name}}", "web"),
    );
    expect(api.post).not.toHaveBeenCalled();
    dialog.accept(L.stopConfirm.confirm);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/stop",
        {},
      ),
    );
  });

  it("deploy force rebuild confirms, naming the resource", async () => {
    const { api } = await openDetail("web");
    fireEvent.click(screen.getByRole("button", { name: L.forceRebuild }));
    const dialog = await confirmDialog();
    expect(dialog.text).toContain(
      L.forceConfirm.title.replace("{{name}}", "web"),
    );
    dialog.accept(L.forceConfirm.confirm);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/deploy",
        { force: true },
      ),
    );
  });

  it("deploy and restart run without a confirm", async () => {
    const { api } = await openDetail("web");
    fireEvent.click(screen.getByRole("button", { name: L.deploy }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/deploy",
        { force: false },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: L.restart }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/restart",
        {},
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a stopped resource offers Start instead of Stop", async () => {
    const { api } = await openDetail("cache");
    expect(screen.queryByRole("button", { name: L.stop })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: L.start }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/db-cache-uuid/start",
        {},
      ),
    );
  });

  it("a service's Parts restart one by one", async () => {
    const { api } = await openDetail("n8n");
    fireEvent.click(
      screen.getByRole("button", {
        name: L.restartPart.replace("{{name}}", "postgresql"),
      }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/part-postgres-uuid/restart",
        {},
      ),
    );
  });

  it("without coolify.operate there are no lifecycle buttons", async () => {
    await openDetail("web", ["coolify.view"]);
    for (const label of [L.deploy, L.forceRebuild, L.restart, L.stop]) {
      expect(screen.queryByRole("button", { name: label }), label).toBeNull();
    }
  });

  it("registers a Coolify: Deploy… palette entry that opens the resources", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.paletteGroups()).toContain("coolify");
    const items = await rendered.loadPaletteGroup("coolify");
    const deploy = items.find((i) => i.title === locales.palette.deploy);
    expect(deploy).toBeTruthy();
    const shell = { openSingletonTab: vi.fn() };
    deploy!.run({ shell } as never);
    expect(shell.openSingletonTab).toHaveBeenCalledWith("coolify", {
      data: { section: "resources" },
    });
  });
});
