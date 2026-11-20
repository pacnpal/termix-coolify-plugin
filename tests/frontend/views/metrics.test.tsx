import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import { listHostSections, SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { connection, resourceAnswer } from "../fixtures";

class FakeLive {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  push(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
}

const live = vi.hoisted(() => ({
  socket: null as unknown,
  open: null as unknown as (path: string) => Promise<unknown>,
}));

vi.mock("../../../src/frontend/socket", () => ({
  setWsUrl: () => undefined,
  keepSocketTarget: () => undefined,
  openSocket: (path: string) => live.open(path),
}));

const manifest = manifestJson as unknown as PluginManifest;
const L = locales.metrics;
const DIMS = locales.ops.fields.trafficDim;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function refusal(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error("refused"), { response: { status, data } });
}

type Answer = unknown | (() => unknown);

/** The plugin's routes: the first pattern matching a GET path answers. */
function stubApi(routes: Array<[RegExp, Answer]>) {
  const all: Array<[RegExp, Answer]> = [
    ...routes,
    [/^\/connections$/, [connection]],
    [/^\/connections\/1\/resources(\?|$)/, resourceAnswer],
    [/^\/connections\/1\/servers$/, []],
  ];
  const mocks = {
    get: vi.fn(async (url: string) => {
      for (const [pattern, answer] of all) {
        if (pattern.test(url)) {
          if (typeof answer === "function") return answer();
          return { data: answer };
        }
      }
      return { data: connection };
    }),
    post: vi.fn(async () => ({ data: { enabled: true } })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return mocks as unknown as typeof mocks & PluginApiClient;
}

const ALL = ["coolify.view", "coolify.operate", "coolify.configure"];

async function setup(api: PluginApiClient, permissions = ALL) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
}

/** Opens a resource's detail from the Resources section, on one of its tabs. */
async function openDetail(name: string, tabLabel?: string) {
  const tab = rendered!.renderTab("coolify", { isVisible: true });
  fireEvent.click(
    await within(tab).findByRole("button", { name: locales.nav.resources }),
  );
  await within(tab).findByText(name);
  fireEvent.click(
    within(tab)
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-name") === name)!,
  );
  if (tabLabel) {
    fireEvent.click(await screen.findByRole("button", { name: tabLabel }));
  }
  return tab;
}

/** Answers a confirm, whether it shows as a dialog or window.confirm. */
async function acceptConfirm(label: string) {
  const dialog = await screen
    .findByRole("alertdialog", {}, { timeout: 300 })
    .catch(() => null);
  if (dialog) {
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
  }
}

const HISTORY = {
  source: "sentinel",
  minutes: 60,
  cpu: [
    [1763546400000, 10],
    [1763546460000, 20],
  ],
  memory: [
    [1763546400000, 1048576],
    [1763546460000, 2097152],
  ],
};

describe("resource detail tabs", () => {
  it("offers Stats with coolify.operate, and Traffic only on applications", async () => {
    await setup(stubApi([]));
    await openDetail("web");
    expect(
      screen.getByRole("button", { name: locales.detail.tabs.stats }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: locales.detail.tabs.traffic }),
    ).toBeTruthy();
    await rendered!.deactivate();
    cleanup();

    await setup(stubApi([]));
    await openDetail("main-db");
    expect(
      screen.getByRole("button", { name: locales.detail.tabs.stats }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: locales.detail.tabs.traffic }),
    ).toBeNull();
    await rendered!.deactivate();
    cleanup();

    await setup(stubApi([]), ["coolify.view"]);
    await openDetail("web");
    expect(
      screen.queryByRole("button", { name: locales.detail.tabs.stats }),
    ).toBeNull();
  });
});

describe("Stats tab", () => {
  it("live stats with several containers shows a picker and subscribes again with the choice", async () => {
    const socket = new FakeLive();
    live.open = vi.fn(async () => socket);
    const api = stubApi([[/\/resources\/app-web-uuid\/metrics/, HISTORY]]);
    await setup(api);
    await openDetail("web", locales.detail.tabs.stats);
    await waitFor(() =>
      expect(socket.sent).toEqual([{ connectionId: 1, uuid: "app-web-uuid" }]),
    );
    socket.push({
      type: "choices",
      choices: [
        { name: "web-a", running: true, part: null },
        { name: "web-b", running: true, part: null },
      ],
    });
    expect(await screen.findByText(locales.logs.pick.title)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "web-b" }));
    await waitFor(() =>
      expect(socket.sent.at(-1)).toEqual({
        connectionId: 1,
        uuid: "app-web-uuid",
        container: "web-b",
      }),
    );
    socket.push({
      type: "stats",
      container: "web-b",
      cpu: 7.5,
      memPct: 1,
      memBytes: 1024,
      netRx: 1,
      netTx: 1,
      at: 1,
    });
    expect(await screen.findByText("7.5%")).toBeTruthy();
    // The choice stays while the range changes.
    const before = socket.sent.length;
    fireEvent.click(screen.getByRole("radio", { name: L.ranges["7d"] }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/metrics?minutes=10080",
      ),
    );
    for (const m of socket.sent.slice(before)) {
      expect(m).toMatchObject({ container: "web-b" });
    }
  });

  it("charts the container's history and shows the live readout", async () => {
    const socket = new FakeLive();
    live.open = vi.fn(async () => socket);
    const api = stubApi([[/\/resources\/app-web-uuid\/metrics/, HISTORY]]);
    await setup(api);
    await openDetail("web", locales.detail.tabs.stats);
    expect(await screen.findByText(L.cpu)).toBeTruthy();
    expect(screen.getByText(L.memory)).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/metrics?minutes=60",
    );
    await waitFor(() => expect(live.open).toHaveBeenCalledWith("/stats"));
    await waitFor(() =>
      expect(socket.sent).toEqual([{ connectionId: 1, uuid: "app-web-uuid" }]),
    );
    socket.push({
      type: "stats",
      container: "web-abc",
      cpu: 12.5,
      memPct: 3.1,
      memBytes: 64 * 1024 * 1024,
      netRx: 1500,
      netTx: 2_000_000,
      at: 1,
    });
    expect(await screen.findByText("12.5%")).toBeTruthy();
    expect(screen.getByText("64.0 MiB")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: L.ranges["7d"] }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/metrics?minutes=10080",
      ),
    );
    // Leaving the tab closes the socket.
    fireEvent.click(
      screen.getByRole("button", { name: locales.detail.tabs.traffic }),
    );
    await waitFor(() => expect(socket.closed).toBe(true));
  });

  it("metrics off shows the enable button only with canEnable, and confirms first", async () => {
    live.open = vi.fn(async () => null);
    const noEnable = stubApi([
      [
        /\/metrics/,
        () => {
          throw refusal(409, {
            error: "off",
            cause: "metrics-off",
            canEnable: false,
          });
        },
      ],
    ]);
    await setup(noEnable);
    await openDetail("web", locales.detail.tabs.stats);
    expect(await screen.findByText(L.off.title)).toBeTruthy();
    expect(screen.queryByRole("button", { name: L.off.enable })).toBeNull();
    await rendered!.deactivate();
    cleanup();

    let enabled = false;
    const canEnable = stubApi([
      [
        /\/resources\/app-web-uuid\/metrics/,
        () => {
          if (enabled) return { data: HISTORY };
          throw refusal(409, {
            error: "off",
            cause: "metrics-off",
            canEnable: true,
          });
        },
      ],
    ]);
    canEnable.post.mockImplementation(async () => {
      enabled = true;
      return { data: { enabled: true } };
    });
    await setup(canEnable);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await openDetail("web", locales.detail.tabs.stats);
    fireEvent.click(await screen.findByRole("button", { name: L.off.enable }));
    expect(canEnable.post).not.toHaveBeenCalled();
    await acceptConfirm(L.enableConfirm.confirm);
    await waitFor(() =>
      expect(canEnable.post).toHaveBeenCalledWith(
        "/connections/1/servers/srv-vps1-uuid/metrics/enable",
        { confirm: true },
      ),
    );
    expect(await screen.findByText(L.cpu)).toBeTruthy();
  });
});

describe("Traffic tab", () => {
  const routes: Array<[RegExp, Answer]> = [
    [
      /view=overview/,
      {
        view: "overview",
        range: "24h",
        ipsHidden: true,
        data: { requests: 1200, unique_visitors: 42, bytes_out: 2048 },
      },
    ],
    [
      /view=series/,
      {
        view: "series",
        range: "24h",
        ipsHidden: true,
        data: [
          { bucket: 1763546400000, requests: 5 },
          { bucket: 1763550000000, requests: 9 },
        ],
      },
    ],
    [
      /view=paths/,
      {
        view: "paths",
        range: "24h",
        ipsHidden: true,
        data: [{ path: "/checkout", requests: 800 }],
      },
    ],
    [
      /view=breakdown&dim=status/,
      {
        view: "breakdown",
        dim: "status",
        range: "24h",
        ipsHidden: true,
        data: [{ value: "200", requests: 1100 }],
      },
    ],
    [
      /view=breakdown&dim=country/,
      {
        view: "breakdown",
        dim: "country",
        range: "24h",
        ipsHidden: true,
        data: [{ value: "NL", requests: 700 }],
      },
    ],
  ];

  it("shows requests over time, top paths and breakdowns, with no IP option when hidden", async () => {
    const api = stubApi(routes);
    await setup(api);
    await openDetail("web", locales.detail.tabs.traffic);
    expect(await screen.findByText("/checkout")).toBeTruthy();
    expect(screen.getByText(L.traffic.requestsOverTime)).toBeTruthy();
    expect(screen.getByText("1200")).toBeTruthy();
    expect(await screen.findByText("200")).toBeTruthy();
    expect(screen.getByText(L.traffic.ipsHidden)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: DIMS.ip })).toBeNull();
    for (const dim of ["status", "country", "browser", "bot"] as const) {
      expect(screen.getByRole("radio", { name: DIMS[dim] })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("radio", { name: DIMS.country }));
    expect(await screen.findByText("NL")).toBeTruthy();
  });

  it("says when traffic analytics is off", async () => {
    const api = stubApi([
      [
        /traffic/,
        () => {
          throw refusal(409, { error: "off", cause: "traffic-off" });
        },
      ],
    ]);
    await setup(api);
    await openDetail("web", locales.detail.tabs.traffic);
    expect(await screen.findByText(L.traffic.off.title)).toBeTruthy();
  });
});

describe("Linked host section metrics", () => {
  const linked = {
    id: 7,
    name: "web-1",
    ip: "203.0.113.11",
    pluginSettings: {
      coolify: {
        coolifyLinked: true,
        coolifyConnectionId: "1",
        coolifyServerUuid: "srv-web1",
      },
    },
  };

  function renderSection() {
    const section = listHostSections().find(
      (s) => s.id === "coolify" || s.id.endsWith(":coolify"),
    );
    if (!section) throw new Error("no coolify host section");
    const Section = section.component;
    return render(
      <SurfaceScope>
        <Section
          host={linked as never}
          isVisible
          shell={{ openSingletonTab: vi.fn() } as never}
        />
      </SurfaceScope>,
    );
  }

  it("shows the server's current metrics and where they came from", async () => {
    const api = stubApi([
      [
        /\/servers\/srv-web1\/metrics/,
        {
          source: "mcp",
          minutes: 60,
          current: {
            cpu_percent: 21.5,
            memory_used_bytes: 1073741824,
            memory_total_bytes: 4294967296,
            disk_used_percent: 40,
            load1: 0.5,
          },
          series: { cpu_percent: [[1763546400000, 20]] },
        },
      ],
    ]);
    await setup(api);
    renderSection();
    expect(await screen.findByText("21.5%")).toBeTruthy();
    expect(screen.getByText(L.source.mcp)).toBeTruthy();
    expect(screen.getByText("1.0 GiB / 4.0 GiB")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/servers/srv-web1/metrics?minutes=60",
    );
  });

  it("metrics off shows enable button only with canEnable", async () => {
    for (const canEnable of [false, true]) {
      const api = stubApi([
        [
          /\/servers\/srv-web1\/metrics/,
          () => {
            throw refusal(409, {
              error: "off",
              cause: "metrics-off",
              canEnable,
            });
          },
        ],
      ]);
      await setup(api);
      const view = renderSection();
      expect(await screen.findByText(L.off.title)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: L.off.enable }) !== null,
      ).toBe(canEnable);
      view.unmount();
      await rendered?.deactivate();
      rendered = null;
    }
  });
});
