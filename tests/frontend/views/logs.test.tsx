import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { setWsUrl } from "../../../src/frontend/socket";
import { LogsView } from "../../../src/frontend/views/LogsView";
import type { Resource } from "../../../src/frontend/api";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { resourceRows, stubApi } from "../fixtures";

const real = manifestJson as unknown as PluginManifest;
/** The plugin's manifest plus a test tab that holds LogsView. */
const manifest: PluginManifest = {
  ...real,
  contributes: {
    ...real.contributes,
    tabs: [
      ...(real.contributes?.tabs ?? []),
      {
        id: "logs-harness",
        titleKey: "tab.title",
        icon: "ScrollText",
        openFrom: ["palette"],
      },
    ],
  },
};
const G = locales.logs;
const OPERATE = ["coolify.view", "coolify.operate"];

/** Stands in for the browser's WebSocket. */
class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** The server or the network ends the socket, with a close code. */
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.({ code, reason });
  }
}

let rendered: RenderedPluginApp | null = null;

beforeEach(() => {
  FakeWebSocket.all = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  setWsUrl(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function logsApi(answer: Record<string, unknown>) {
  const api = stubApi();
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) =>
    /\/logs(\?|$)/.test(url) ? { data: answer } : fallback(url),
  );
  return api;
}

async function render(answer: Record<string, unknown>) {
  const api = logsApi(answer);
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: OPERATE,
  });
  setWsUrl(async (path: string) => ({
    url: `ws://termix.test/plugin-ws/coolify${path}`,
    protocols: ["fake-ticket"],
  }));
  return api;
}

/** Opens the coolify tab, the web resource and its Logs view. */
async function openLogs(answer: Record<string, unknown>) {
  const api = await render(answer);
  const tab = rendered!.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await screen.findByRole("button", { name: locales.nav.resources }),
  );
  const row = await waitFor(() => {
    const found = [...tab.querySelectorAll("[data-name]")].find(
      (r) => r.getAttribute("data-name") === "web",
    );
    if (!found) throw new Error("no row yet");
    return found;
  });
  fireEvent.click(row);
  fireEvent.click(
    await screen.findByRole("button", { name: locales.detail.tabs.logs }),
  );
  return { api, tab };
}

describe("Logs view", () => {
  it("shows the lines with the source label from Coolify", async () => {
    const { api } = await openLogs({ source: "coolify", text: "one\ntwo\n" });
    expect(await screen.findByText(G.source.coolify)).toBeTruthy();
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/logs?lines=100",
    );
  });

  it("labels logs read over SSH as from the server over SSH", async () => {
    await openLogs({ source: "ssh", text: "x\n", container: "web-abc" });
    expect(await screen.findByText(G.source.ssh)).toBeTruthy();
    expect(screen.queryByText(G.source.coolify)).toBeNull();
  });

  it("asks again for a line count and timestamps, and searches the lines", async () => {
    const { api } = await openLogs({
      source: "coolify",
      text: "alpha\nbeta\ngamma\n",
    });
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: G.timestamps }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/logs?lines=100&timestamps=true",
      ),
    );
    fireEvent.change(screen.getByPlaceholderText(G.search), {
      target: { value: "ET" },
    });
    await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("keeps only the newest answer when an older request ends last", async () => {
    const api = stubApi();
    const fallback = api.get.getMockImplementation()!;
    let releaseFirst: () => void = () => {};
    api.get.mockImplementation(async (url: string) => {
      if (!/\/logs(\?|$)/.test(url)) return fallback(url);
      if (!url.includes("timestamps")) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        return { data: { source: "coolify", text: "stale line\n" } };
      }
      return { data: { source: "coolify", text: "fresh line\n" } };
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: OPERATE,
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
      await screen.findByRole("button", { name: locales.detail.tabs.logs }),
    );
    fireEvent.click(await screen.findByRole("button", { name: G.timestamps }));
    expect(await screen.findByText("fresh line")).toBeTruthy();
    await act(async () => releaseFirst());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("stale line")).toBeNull();
    expect(screen.getByText("fresh line")).toBeTruthy();
  });

  it("a follow that answers choices shows the picker and follows the chosen container", async () => {
    const { api } = await openLogs({ source: "coolify", text: "api line\n" });
    const fallback = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) =>
      url.includes("container=web-b")
        ? { data: { source: "ssh", text: "b line\n", container: "web-b" } }
        : fallback(url),
    );
    await screen.findByText("api line");
    fireEvent.click(screen.getByRole("button", { name: G.follow }));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
    const first = FakeWebSocket.all[0];
    act(() => first.open());
    act(() =>
      first.receive({
        type: "choices",
        choices: [
          { name: "web-a", running: true, part: null },
          { name: "web-b", running: true, part: null },
        ],
      }),
    );
    expect(await screen.findByText(G.pick.title)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /web-b/ }));
    expect(await screen.findByText("b line")).toBeTruthy();
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(2));
    const second = FakeWebSocket.all[1];
    act(() => second.open());
    expect(second.sent[0]).toMatchObject({
      type: "subscribe",
      container: "web-b",
    });
    expect(first.closed).toBe(true);
  });

  it("the badge says SSH once a follow over SSH starts on a Coolify snapshot", async () => {
    await openLogs({ source: "coolify", text: "c line\n" });
    expect(await screen.findByText(G.source.coolify)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: G.follow }));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
    const ws = FakeWebSocket.all[0];
    act(() => ws.open());
    act(() =>
      ws.receive({ type: "started", source: "ssh", container: "web-abc" }),
    );
    expect(await screen.findByText(G.source.ssh)).toBeTruthy();
    expect(screen.queryByText(G.source.coolify)).toBeNull();
  });

  it("explains not-linked from the route", async () => {
    const api = stubApi();
    const fallback = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) => {
      if (/\/logs(\?|$)/.test(url)) {
        throw Object.assign(new Error("409"), {
          response: {
            status: 409,
            data: { error: "Link first", cause: "not-linked" },
          },
        });
      }
      return fallback(url);
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: OPERATE,
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
      await screen.findByRole("button", { name: locales.detail.tabs.logs }),
    );
    expect(await screen.findByText(G.errors["not-linked"])).toBeTruthy();
  });

  it("follows over the socket, then stops when the detail switches away", async () => {
    await openLogs({ source: "coolify", text: "old\n" });
    await screen.findByText("old");
    fireEvent.click(screen.getByRole("button", { name: G.follow }));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
    const ws = FakeWebSocket.all[0];
    expect(ws.url).toBe("ws://termix.test/plugin-ws/coolify/logs");
    act(() => ws.open());
    expect(ws.sent[0]).toEqual({
      type: "subscribe",
      connectionId: 1,
      uuid: "app-web-uuid",
      timestamps: false,
    });
    act(() => {
      ws.receive({ type: "started", source: "ssh", container: "web-abc" });
      ws.receive({ type: "lines", lines: ["new one", "new two"] });
    });
    expect(await screen.findByText("new two")).toBeTruthy();
    expect(screen.getByText(G.following)).toBeTruthy();
    // The detail's own Overview tab, beside its Logs tab.
    const strip = screen.getByRole("button", {
      name: locales.detail.tabs.logs,
    }).parentElement!;
    fireEvent.click(
      within(strip).getByRole("button", {
        name: locales.detail.tabs.overview,
      }),
    );
    await waitFor(() => expect(ws.closed).toBe(true));
  });
});

describe("Logs follow connection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function startFollow() {
    await openLogs({ source: "coolify", text: "old\n" });
    await screen.findByText("old");
    fireEvent.click(screen.getByRole("button", { name: G.follow }));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
    const ws = FakeWebSocket.all[0];
    act(() => {
      ws.open();
      ws.receive({ type: "started", source: "ssh", container: "web-abc" });
    });
    expect(await screen.findByText(G.following)).toBeTruthy();
    return ws;
  }

  it("a 1008 close shows its cause, never retries on its own, and offers Reconnect", async () => {
    const ws = await startFollow();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => ws.drop(1008, "target-changed"));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    vi.useRealTimers();
    expect(await screen.findByText(G.errors["target-changed"])).toBeTruthy();
    expect(screen.queryByText(G.followEnded)).toBeNull();
    expect(FakeWebSocket.all).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: G.reconnect }));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(2));
  });

  it("ignores lines from a socket it has let go", async () => {
    const ws = await startFollow();
    fireEvent.click(screen.getByRole("button", { name: G.follow }));
    await waitFor(() => expect(ws.closed).toBe(true));
    act(() => ws.receive({ type: "lines", lines: ["ghost line"] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("ghost line")).toBeNull();
  });

  it("retries a lost follow at most 3 times, with growing waits, then waits for Reconnect", async () => {
    await startFollow();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = FakeWebSocket.all.length;
      const current = FakeWebSocket.all[before - 1];
      act(() => current.drop(1006));
      let waited = 0;
      while (FakeWebSocket.all.length === before && waited < 60_000) {
        await act(() => vi.advanceTimersByTimeAsync(250));
        waited += 250;
      }
      if (FakeWebSocket.all.length === before) break;
      waits.push(waited);
      act(() => FakeWebSocket.all[FakeWebSocket.all.length - 1].open());
    }
    vi.useRealTimers();
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeLessThan(waits[1]);
    expect(waits[1]).toBeLessThan(waits[2]);
    expect(await screen.findByText(G.followLost)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: G.reconnect }));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(5));
  });
});

/** LogsView in a tab whose visibility the test flips, as the shell does. */
let setVisible: (visible: boolean) => void = () => {};

function VisibilityHarness() {
  const [visible, set] = useState(true);
  useEffect(() => {
    setVisible = set;
  }, []);
  return (
    <LogsView
      connectionId={1}
      resource={resourceRows[0] as Resource}
      isVisible={visible}
    />
  );
}

describe("Logs view follow", () => {
  it("follow stops on hide and starts again when shown", async () => {
    await render({ source: "ssh", text: "a\n", container: "web-abc" });
    rendered!.app.registerTab("logs-harness", VisibilityHarness, {
      titleKey: "tab.title",
      hostless: true,
    });
    rendered!.renderTab("logs-harness");
    expect(await screen.findByText(G.source.ssh)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: G.follow }));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(1));
    const first = FakeWebSocket.all[0];
    act(() => first.open());
    expect(first.sent[0]).toMatchObject({
      type: "subscribe",
      container: "web-abc",
    });
    act(() => setVisible(false));
    await waitFor(() => expect(first.closed).toBe(true));
    expect(first.sent.at(-1)).toEqual({ type: "unsubscribe" });

    act(() => setVisible(true));
    await waitFor(() => expect(FakeWebSocket.all).toHaveLength(2));
  });
});
