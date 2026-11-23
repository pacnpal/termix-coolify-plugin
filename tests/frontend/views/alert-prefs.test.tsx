import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { RenderedPluginApp } from "@termix-ssh/plugin-sdk/testing";
import locales from "../../../locales/en.json";
import { DEFAULT_ALERT_KINDS } from "../../../src/shared/alerts";
import { connectionFixture, renderApp } from "../helpers";
import { stubApi } from "../fixtures";

const P = locales.alerts.prefs;
const KINDS = locales.alerts.kinds;
const AVAILABLE = Object.keys(KINDS);

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function prefs(connectionId: number, kinds: string[] | null) {
  return {
    connectionId,
    kinds: kinds ?? [...DEFAULT_ALERT_KINDS],
    isDefault: kinds === null,
    defaults: [...DEFAULT_ALERT_KINDS],
    available: AVAILABLE,
  };
}

/** The tab on Connections, with these connections listed. */
async function open(
  connections: unknown[],
  answer: (url: string) => Promise<unknown> | unknown,
  permissions = ["coolify.view"],
) {
  const api = stubApi({ connections });
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (/\/alert-prefs$/.test(url)) return { data: await answer(url) };
    return fallback(url);
  });
  (api.put as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (url: string, body: unknown) => {
      const id = Number(/connections\/(\d+)\//.exec(url)![1]);
      const { kinds } = body as { kinds: string[] | null };
      return { data: prefs(id, kinds) };
    },
  );
  rendered = await renderApp(api, permissions);
  rendered.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await screen.findByRole("button", { name: locales.nav.connections }),
  );
  return api;
}

function switchFor(kind: string) {
  return screen.getByRole("switch", {
    name: (KINDS as Record<string, string>)[kind],
  });
}

describe("alert preferences", () => {
  it("opens from a shared connection's row, without configure", async () => {
    await open([connectionFixture({ access: "view" })], () => prefs(1, null));
    fireEvent.click(await screen.findByRole("button", { name: P.open }));
    expect(
      await screen.findByText(P.title.replace("{{name}}", "Prod")),
    ).toBeTruthy();
    expect(await screen.findByText(P.usingDefaults)).toBeTruthy();
    for (const kind of AVAILABLE) {
      expect(switchFor(kind).getAttribute("aria-checked")).toBe(
        String(DEFAULT_ALERT_KINDS.includes(kind as never)),
      );
    }
  });

  it("saves the picked kinds, and resets to the defaults", async () => {
    const api = await open([connectionFixture()], () => prefs(1, null));
    fireEvent.click(await screen.findByRole("button", { name: P.open }));
    await screen.findByText(P.usingDefaults);
    fireEvent.click(switchFor("deployment-finished"));
    fireEvent.click(switchFor("high-disk"));
    fireEvent.click(screen.getByRole("button", { name: P.save }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [url, body] = api.put.mock.calls[0] as unknown as [
      string,
      { kinds: string[] },
    ];
    expect(url).toBe("/connections/1/alert-prefs");
    expect(body.kinds).toContain("deployment-finished");
    expect(body.kinds).not.toContain("high-disk");
    expect(await screen.findByText(P.saved)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: P.reset }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put.mock.calls[1]).toEqual([
      "/connections/1/alert-prefs",
      { kinds: null },
    ]);
    expect(await screen.findByText(P.usingDefaults)).toBeTruthy();
  });

  it("links to the Alerts delivery channels", async () => {
    await open([connectionFixture()], () => prefs(1, null));
    const calls: unknown[] = [];
    rendered!.app.registerAction("alerts.openChannels", () => {
      calls.push("open");
    });
    fireEvent.click(await screen.findByRole("button", { name: P.open }));
    fireEvent.click(await screen.findByRole("button", { name: P.channels }));
    await waitFor(() => expect(calls).toEqual(["open"]));
  });

  it("never shows one connection's answer for another", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    await open(
      [connectionFixture(), connectionFixture({ id: 2, name: "Staging" })],
      async (url) => {
        if (url.startsWith("/connections/1/")) {
          await first;
          return prefs(1, ["high-disk"]);
        }
        return prefs(2, ["backup-failed"]);
      },
    );
    const [one, two] = await screen.findAllByRole("button", { name: P.open });
    fireEvent.click(one);
    await screen.findByText(P.title.replace("{{name}}", "Prod"));
    fireEvent.click(two);
    await screen.findByText(P.title.replace("{{name}}", "Staging"));
    await waitFor(() =>
      expect(switchFor("backup-failed").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchFor("high-disk").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("backup-failed").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("says so when the preferences can't be read", async () => {
    await open([connectionFixture()], () => {
      throw new Error("down");
    });
    fireEvent.click(await screen.findByRole("button", { name: P.open }));
    expect(await screen.findByText(P.loadFailed)).toBeTruthy();
    expect(screen.queryByRole("button", { name: P.save })).toBeNull();
  });
});

describe("an alert's link", () => {
  it("opens the subject in the Coolify tab", async () => {
    const { alertTabData } = await import("../../../src/shared/alerts");
    const api = stubApi();
    rendered = await renderApp(api, ["coolify.view"]);
    rendered.renderTab("coolify", {
      isVisible: true,
      tab: {
        data: alertTabData({
          connectionId: 1,
          resourceUuid: "app-api-uuid",
          serverUuid: "srv-vps1-uuid",
        }),
      },
    });
    expect(
      await screen.findByText(locales.detail.fields.coolifyStatus),
    ).toBeTruthy();
    expect(within(document.body).getAllByText("api").length).toBeGreaterThan(0);
  });
});
