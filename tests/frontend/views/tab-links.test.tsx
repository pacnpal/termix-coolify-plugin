import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
const OPERATE = ["coolify.view", "coolify.operate"];
const DETAIL = "/connections/1/resources/app-api-uuid/deployments/dep-failed";

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

/** The stub, with the queue and one deployment's build log routed. */
function linkApi() {
  const api = stubApi();
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (/^\/connections\/1\/deployments/.test(url)) {
      return { data: { running: [], recent: [], fetchedAt: null } };
    }
    if (url === DETAIL) {
      return {
        data: {
          deployment: {
            uuid: "dep-failed",
            resourceUuid: "app-api-uuid",
            status: "failed",
            commit: null,
            commitMessage: null,
            pullRequestId: 0,
            rollback: false,
            serverName: null,
            createdAt: "2026-11-22T10:00:00.000Z",
            updatedAt: null,
            finishedAt: null,
          },
          log: { lines: [], truncated: false },
          final: true,
          cancellable: false,
        },
      };
    }
    return fallback(url);
  });
  return api;
}

async function openWith(
  data: Record<string, unknown>,
  permissions = OPERATE,
  api = linkApi(),
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  rendered.renderTab("coolify", { isVisible: true, tab: { data } });
  return api;
}

describe("the coolify tab, opened from the sidebar panel", () => {
  it("opens a resource's detail by its uuid", async () => {
    await openWith({
      section: "resources",
      connectionId: 1,
      uuid: "app-api-uuid",
    });
    expect(
      await screen.findByText(locales.detail.fields.coolifyStatus),
    ).toBeTruthy();
    expect(screen.getAllByText("api").length).toBeGreaterThan(0);
  });

  it("opens a deployment's build log with operate", async () => {
    const api = await openWith({
      section: "deployments",
      connectionId: 1,
      resourceUuid: "app-api-uuid",
      deploymentUuid: "dep-failed",
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(DETAIL));
    expect(
      await screen.findByRole("button", {
        name: locales.deploymentsSection.back,
      }),
    ).toBeTruthy();
  });

  it("opens the Deployments list, not the build log, without operate", async () => {
    const api = await openWith(
      {
        section: "deployments",
        connectionId: 1,
        resourceUuid: "app-api-uuid",
        deploymentUuid: "dep-failed",
      },
      ["coolify.view"],
    );
    expect(
      await screen.findByText(locales.deploymentsSection.running),
    ).toBeTruthy();
    expect(api.get).not.toHaveBeenCalledWith(DETAIL);
  });
});
