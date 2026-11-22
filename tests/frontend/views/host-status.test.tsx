import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import {
  checkFrameApp,
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import locales from "../../../locales/en.json";
import { manifest, renderApp, stubClient } from "../helpers";
import { stubApi } from "../fixtures";

/**
 * The host dot reads a per connection cache that outlives a test, so each
 * test uses its own connection id.
 */
function host(
  id: number,
  link: { connectionId: number; serverUuid: string } | null,
): PluginHostRecord {
  return {
    id,
    name: `host-${id}`,
    ip: `203.0.113.${id}`,
    port: 22,
    username: "root",
    pluginSettings: link
      ? {
          coolify: {
            coolifyLinked: true,
            coolifyConnectionId: String(link.connectionId),
            coolifyServerUuid: link.serverUuid,
          },
        }
      : {},
  } as unknown as PluginHostRecord;
}

type Health = {
  servers: { uuid: string; reachable: boolean; usable: boolean }[] | null;
  degraded: Record<string, number> | null;
};

function healthApi(health: Health) {
  return stubClient({
    get: async (url) => ({
      data: /^\/connections\/\d+\/server-health$/.test(url) ? health : {},
    }),
  });
}

const healthCalls = (api: ReturnType<typeof healthApi>) =>
  api.get.mock.calls.filter(([url]) => /\/server-health$/.test(String(url)));

/** The status indicator's dot for a host: its tone and label, or null. */
function dotOf(r: RenderedPluginApp, h: PluginHostRecord) {
  const el = r.renderHostItems(
    "status",
    h as unknown as Record<string, unknown>,
  );
  return el;
}

function readDot(el: HTMLElement) {
  const dot = el.querySelector("[data-data-dot]");
  return dot
    ? {
        tone: dot.getAttribute("data-data-dot"),
        label: dot.getAttribute("aria-label"),
      }
    : null;
}

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

describe("host status dot", () => {
  it("an unlinked host gets no action, no dot and makes no call", async () => {
    const api = healthApi({ servers: [], degraded: {} });
    rendered = await renderApp(api);
    const plain = host(1, null);
    expect(rendered.registered.hostActionsFor(plain)).toEqual([]);
    const status = dotOf(rendered, plain);
    const badge = rendered.renderHostItems(
      "badge",
      plain as unknown as Record<string, unknown>,
    );
    // Give any effect a chance to fetch.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readDot(status)).toBeNull();
    expect(readDot(badge)).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("warns when a resource on the host's server is degraded", async () => {
    const api = healthApi({
      servers: [{ uuid: "srv-a", reachable: true, usable: true }],
      degraded: { "srv-a": 2, "srv-b": 0 },
    });
    rendered = await renderApp(api);
    const el = dotOf(
      rendered,
      host(2, { connectionId: 102, serverUuid: "srv-a" }),
    );
    await waitFor(() =>
      expect(readDot(el)).toEqual({
        tone: "warn",
        label: locales.hostDot.resourcesDegraded.replace("{{count}}", "2"),
      }),
    );
  });

  it("alarms when Coolify can't reach the server", async () => {
    const api = healthApi({
      servers: [{ uuid: "srv-a", reachable: false, usable: false }],
      degraded: { "srv-a": 1 },
    });
    rendered = await renderApp(api);
    const el = dotOf(
      rendered,
      host(3, { connectionId: 103, serverUuid: "srv-a" }),
    );
    await waitFor(() =>
      expect(readDot(el)).toEqual({
        tone: "bad",
        label: locales.hostDot.unreachable,
      }),
    );
  });

  it("shows nothing when the server's resources are only stopped or exited", async () => {
    // The backend counts exited as stopped, so the server has no degraded.
    const api = healthApi({
      servers: [{ uuid: "srv-a", reachable: true, usable: true }],
      degraded: { "srv-a": 0 },
    });
    rendered = await renderApp(api);
    const el = dotOf(
      rendered,
      host(4, { connectionId: 104, serverUuid: "srv-a" }),
    );
    await waitFor(() => expect(healthCalls(api)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readDot(el)).toBeNull();
  });

  it("two hosts on one connection cost one fetch", async () => {
    const api = healthApi({
      servers: [
        { uuid: "srv-a", reachable: true, usable: true },
        { uuid: "srv-b", reachable: false, usable: false },
      ],
      degraded: { "srv-a": 1 },
    });
    rendered = await renderApp(api);
    const a = host(5, { connectionId: 105, serverUuid: "srv-a" });
    const b = host(6, { connectionId: 105, serverUuid: "srv-b" });
    const elA = dotOf(rendered, a);
    const elB = dotOf(rendered, b);
    rendered.renderHostItems("badge", a as unknown as Record<string, unknown>);
    await waitFor(() => expect(readDot(elA)?.tone).toBe("warn"));
    await waitFor(() => expect(readDot(elB)?.tone).toBe("bad"));
    expect(healthCalls(api)).toEqual([["/connections/105/server-health"]]);
  });

  it("registers the host action and status indicator frame-safe", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    const kinds = registrations.map((r) => r.kind);
    expect(kinds).toContain("hostAction");
    expect(kinds).toContain("hostStatusIndicator");
  });
});

describe("host action", () => {
  it("opens the coolify tab filtered to the host's server, and the filter clears", async () => {
    const api = stubApi();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    const linked = host(7, { connectionId: 1, serverUuid: "srv-edge-uuid" });
    const actions = rendered.registered.hostActionsFor(linked);
    expect(actions.map((a) => a.titleKey)).toEqual([
      "coolify:hostAction.title",
    ]);
    const shell = { openSingletonTab: vi.fn(), openTab: vi.fn() };
    actions[0].run?.(linked, shell as never);
    expect(shell.openSingletonTab).toHaveBeenCalledWith("coolify", {
      data: {
        section: "resources",
        connectionId: 1,
        serverUuid: "srv-edge-uuid",
      },
    });

    const data = shell.openSingletonTab.mock.calls[0][1].data;
    const tab = rendered.renderTab("coolify", {
      isVisible: true,
      tab: { id: "t1", type: "coolify", label: "Coolify", data },
    });
    await within(tab).findByText("api");
    const names = () =>
      within(tab)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.getAttribute("data-name"));
    expect(names()).toEqual(["api"]);
    const clear = within(tab).getByRole("button", {
      name: locales.resources.serverFilter.clear,
    });
    expect(
      within(tab).getByText(
        locales.resources.serverFilter.label.replace("{{server}}", "edge"),
      ),
    ).toBeTruthy();
    // The health counts are the server's: edge runs only the degraded api.
    const running = () =>
      within(tab).getByRole("radio", {
        name: new RegExp(`^${locales.resources.health.running}`),
      }).textContent;
    expect(running()).toContain("0");
    fireEvent.click(clear);
    await waitFor(() => expect(names()).toContain("web"));
    expect(names()).toContain("api");
    expect(running()).toContain("3");
    expect(
      within(tab).queryByRole("button", {
        name: locales.resources.serverFilter.clear,
      }),
    ).toBeNull();
  });
});
