import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("registers the coolify tab and rail item", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toContain("coolify");
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({
        id: "coolify",
        permission: "coolify.view",
      }),
    ]);
  });

  it("shows an empty state in the coolify tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    rendered.renderTab("coolify", { isVisible: true });
    expect(await screen.findByText(locales.tab.empty.title)).toBeTruthy();
  });
});
