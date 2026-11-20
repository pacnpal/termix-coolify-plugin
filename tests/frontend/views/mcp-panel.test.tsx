import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;
const M = locales.connections.mcp;
const ENDPOINT = "https://termix.example.test/plugin-api/coolify/mcp";
const LEAKED = "tmx_fake_key_that_must_never_show";

function stubApi() {
  const mocks = {
    get: vi.fn(async (url: string) => ({
      data:
        url === "/mcp"
          ? {
              endpoint: ENDPOINT,
              // A backend that wrongly sent a key must still not show it.
              example: {
                mcpServers: {
                  "termix-coolify": {
                    url: ENDPOINT,
                    headers: { Authorization: `Bearer ${LEAKED}` },
                  },
                },
              },
            }
          : [],
    })),
    post: vi.fn(async () => ({ data: {} })),
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

describe("Use with an MCP client", () => {
  it("mcp panel shows endpoint and snippet with a placeholder, never a real key", async () => {
    const api = stubApi();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view", "coolify.mcp"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    expect(await screen.findByText(M.title)).toBeTruthy();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/mcp"));
    expect(
      (await screen.findAllByText(ENDPOINT, { exact: false })).length,
    ).toBeGreaterThan(0);
    const snippet = await screen.findByTestId("mcp-snippet");
    expect(snippet.textContent).toContain(M.keyPlaceholder);
    expect(snippet.textContent).toContain(ENDPOINT);
    expect(snippet.textContent).toContain("termix-coolify");
    expect(document.body.textContent).not.toContain(LEAKED);
    expect(screen.getByText(M.steps.key)).toBeTruthy();
  });

  it("is hidden without coolify.mcp, and asks nothing", async () => {
    const api = stubApi();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    rendered.renderTab("coolify", { isVisible: true });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/connections"));
    expect(screen.queryByText(M.title)).toBeNull();
    expect(api.get).not.toHaveBeenCalledWith("/mcp");
  });
});
