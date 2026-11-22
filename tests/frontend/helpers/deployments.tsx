import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../../src/frontend/index";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import type { stubApi } from "../fixtures";

/** View and operate: what opening build logs and rolling back need. */
export const OPERATE = ["coolify.view", "coolify.operate"];

/** The plugin's manifest plus a test tab `id` that a test registers a view in. */
export function harnessManifest(id: string, icon: string): PluginManifest {
  const real = manifestJson as unknown as PluginManifest;
  return {
    ...real,
    contributes: {
      ...real.contributes,
      tabs: [
        ...(real.contributes?.tabs ?? []),
        { id, titleKey: "tab.title", icon, openFrom: ["palette"] },
      ],
    },
  };
}

/**
 * Opens the coolify tab, the web application and its Deployments view.
 * `keep` gets the rendered app as soon as it exists, so a test's cleanup
 * deactivates it even when a later step fails.
 */
export async function openDeployments(
  manifest: PluginManifest,
  keep: (rendered: RenderedPluginApp) => void,
  api: ReturnType<typeof stubApi>,
  permissions = OPERATE,
): Promise<void> {
  const rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  keep(rendered);
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
  // The detail's tab, not the side nav's Deployments section of the same name.
  fireEvent.click(
    await waitFor(() => {
      const tab = screen
        .getAllByRole("button", { name: locales.detail.tabs.deployments })
        .find((b) => !b.closest(`[aria-label="${locales.nav.label}"]`));
      if (!tab) throw new Error("no Deployments tab");
      return tab;
    }),
  );
}
