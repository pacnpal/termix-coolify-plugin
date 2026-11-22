import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { createApi } from "../../src/frontend/api";
import { createStatusFeed } from "../../src/frontend/toolbar-status";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import { resourceRows, stubApi } from "./fixtures";

// The toolbar finds its tab through useShell(); the test host has no shell,
// so the tab list is set here.
const shell = vi.hoisted(() => ({ tabs: [] as Record<string, unknown>[] }));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>();
  return {
    ...real,
    useShell: () => ({
      tabs: {
        list: shell.tabs,
        topLevel: shell.tabs,
        activeId: "",
        ready: true,
      },
    }),
  };
});

const manifest = manifestJson as unknown as PluginManifest;
const SLOT = "terminal.toolbarStatus";
const ACTION = "coolify.toolbar-status";
const H = locales.resources.health;
const B = locales.toolbarStatus;
const S = locales.shellTab;
const CONTEXT = { hostId: 7, isConnected: true, active: true };

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  shell.tabs = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function shellTab(id: string, data: Record<string, unknown>) {
  return { id, instanceId: id, type: "coolify-shell", label: "Shell", data };
}

function rows(...statuses: [string, string][]) {
  return {
    rows: statuses.map(([uuid, status]) => ({
      ...resourceRows[0],
      uuid,
      name: `${uuid}-name`,
      status,
    })),
    fetchedAt: "2026-11-22T10:00:00.000Z",
  };
}

async function start(resources: unknown) {
  const api = stubApi({ resources });
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: ["coolify.view", "coolify.operate"],
  });
  return { api, rendered };
}

function resourceGets(api: ReturnType<typeof stubApi>) {
  return api.get.mock.calls.filter(([url]) =>
    /^\/connections\/\d+\/resources(\?|$)/.test(String(url)),
  );
}

function stat(label: string, value: string, tone: string, tooltip?: string) {
  return [
    {
      shape: "stat",
      items: [{ label, value, tone, ...(tooltip ? { tooltip } : {}) }],
    },
  ];
}

describe("terminal.toolbarStatus", () => {
  it("shows a running container's name and status", async () => {
    shell.tabs = [
      shellTab("s1", { connectionId: 1, uuid: "a", container: "web-abc" }),
    ];
    const { rendered } = await start(rows(["a", "running:healthy"]));
    const read = rendered.readDataValues(SLOT, CONTEXT, "s1");
    await waitFor(() =>
      expect(read.values()[ACTION]).toEqual(stat("web-abc", H.running, "good")),
    );
  });

  it("shows Coolify's exited as Stopped, whatever its health", async () => {
    shell.tabs = [shellTab("s1", { connectionId: 1, uuid: "a" })];
    const { rendered } = await start(rows(["a", "exited:unhealthy"]));
    const read = rendered.readDataValues(SLOT, CONTEXT, "s1");
    await waitFor(() =>
      expect(read.values()[ACTION]).toEqual(stat("a-name", H.stopped, "muted")),
    );
  });

  it("shows a bare unhealthy as degraded", async () => {
    shell.tabs = [shellTab("s1", { connectionId: 1, uuid: "a" })];
    const { rendered } = await start(rows(["a", "unhealthy"]));
    const read = rendered.readDataValues(SLOT, CONTEXT, "s1");
    await waitFor(() =>
      expect(read.values()[ACTION]).toEqual(stat("a-name", H.degraded, "warn")),
    );
  });

  it("shows a container gone from Coolify as gone, not its last status", async () => {
    shell.tabs = [
      shellTab("s1", { connectionId: 1, uuid: "a", container: "web-abc" }),
    ];
    const api = stubApi({ resources: rows(["a", "running:healthy"]) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api,
      permissions: ["coolify.view"],
    });
    const read = rendered.readDataValues(SLOT, CONTEXT, "s1");
    await waitFor(() =>
      expect(read.values()[ACTION]).toEqual(stat("web-abc", H.running, "good")),
    );
    // The next read of the cache no longer has it.
    api.get.mockImplementation(async () => ({ data: rows(["b", "running"]) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await waitFor(() =>
      expect(read.values()[ACTION]).toEqual(
        stat("web-abc", B.gone, "warn", B.goneHint),
      ),
    );
  });

  it("gives a tab that isn't a coolify-shell nothing", async () => {
    shell.tabs = [
      {
        id: "t1",
        type: "terminal",
        label: "vps1",
        data: { connectionId: 1, uuid: "a" },
      },
    ];
    const { api, rendered } = await start(rows(["a", "running:healthy"]));
    // The slot is filled, only not for this tab.
    expect(rendered.registered.slot(SLOT)).toContain(ACTION);
    const read = rendered.readDataValues(SLOT, CONTEXT, "t1");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(read.values()[ACTION] ?? null).toBeNull();
    expect(resourceGets(api)).toEqual([]);
  });

  it("shows each of two shell tabs its own container, from one read", async () => {
    shell.tabs = [
      shellTab("s1", { connectionId: 1, uuid: "a", container: "web-abc" }),
      shellTab("s2", { connectionId: 1, uuid: "b", container: "db-xyz" }),
    ];
    const { api, rendered } = await start(
      rows(["a", "running:healthy"], ["b", "exited"]),
    );
    const one = rendered.readDataValues(SLOT, CONTEXT, "s1");
    const two = rendered.readDataValues(SLOT, CONTEXT, "s2");
    await waitFor(() => {
      expect(one.values()[ACTION]).toEqual(stat("web-abc", H.running, "good"));
      expect(two.values()[ACTION]).toEqual(stat("db-xyz", H.stopped, "muted"));
    });
    expect(resourceGets(api)).toHaveLength(1);
  });
});

describe("status feed", () => {
  it("stops reading once the last tab for a connection goes", async () => {
    vi.useFakeTimers();
    const api = stubApi({ resources: rows(["a", "running"]) });
    const feed = createStatusFeed(createApi(api), 1_000);
    const stopOne = feed.subscribe(1, () => {});
    const stopTwo = feed.subscribe(1, () => {});
    await vi.advanceTimersByTimeAsync(2_500);
    expect(resourceGets(api)).toHaveLength(3);
    stopOne();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resourceGets(api)).toHaveLength(4);
    stopTwo();
    expect(feed.rows(1)).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resourceGets(api)).toHaveLength(4);
  });
});

/** What a failed axios call carries. */
function failure(status: number, data: unknown) {
  return Object.assign(new Error(`status ${status}`), {
    response: { status, data },
  });
}

function command(container: string) {
  return {
    data: {
      hostId: 7,
      title: "n8n",
      container,
      command: `docker exec -it ${container} sh`,
      fingerprints: [],
    },
  };
}

describe("terminal.toolbarStatus with the shell's own container", () => {
  it("labels two shells of one service by the container each opened", async () => {
    const data = { connectionId: 1, uuid: "svc" };
    shell.tabs = [shellTab("s1", data), shellTab("s2", data)];
    const { api, rendered } = await start(rows(["svc", "running:healthy"]));
    let calls = 0;
    api.post.mockImplementation((async () =>
      command(++calls === 1 ? "n8n-web-1" : "n8n-worker-1")) as never);
    rendered.renderTab("coolify-shell", {
      tab: { id: "s1", type: "coolify-shell", label: "Shell", data },
      isVisible: true,
    });
    const one = rendered.readDataValues(SLOT, CONTEXT, "s1");
    await waitFor(() =>
      expect(one.values()[ACTION]).toEqual(
        stat("n8n-web-1", H.running, "good"),
      ),
    );
    rendered.renderTab("coolify-shell", {
      tab: { id: "s2", type: "coolify-shell", label: "Shell", data },
      isVisible: true,
    });
    const two = rendered.readDataValues(SLOT, CONTEXT, "s2");
    await waitFor(() => {
      expect(two.values()[ACTION]).toEqual(
        stat("n8n-worker-1", H.running, "good"),
      );
      expect(one.values()[ACTION]).toEqual(
        stat("n8n-web-1", H.running, "good"),
      );
    });
  });

  it("follows a change of container", async () => {
    const data = { connectionId: 1, uuid: "svc", container: "n8n-web-1" };
    shell.tabs = [shellTab("s1", data)];
    const { api, rendered } = await start(rows(["svc", "running:healthy"]));
    api.post.mockImplementation((async (_url: string, body: unknown) => {
      const picked = (body as { container?: string }).container;
      if (picked === "n8n-web-1") {
        throw failure(409, { error: "x", cause: "not-running" });
      }
      if (!picked) {
        return {
          data: {
            choices: [
              { name: "n8n-web-1", running: false, part: null },
              { name: "n8n-worker-1", running: true, part: null },
            ],
          },
        };
      }
      return command(picked);
    }) as never);
    const tab = rendered.renderTab("coolify-shell", {
      tab: { id: "s1", type: "coolify-shell", label: "Shell", data },
      isVisible: true,
    });
    const read = rendered.readDataValues(SLOT, CONTEXT, "s1");
    await waitFor(() =>
      expect(read.values()[ACTION]).toEqual(
        stat("n8n-web-1", H.running, "good"),
      ),
    );
    fireEvent.click(
      await within(tab).findByRole("button", { name: S.changeContainer }),
    );
    fireEvent.click(await within(tab).findByLabelText("n8n-worker-1"));
    await waitFor(() =>
      expect(read.values()[ACTION]).toEqual(
        stat("n8n-worker-1", H.running, "good"),
      ),
    );
  });
});

describe("status feed timing", () => {
  it("fills the rows when every read takes longer than the poll interval", async () => {
    vi.useFakeTimers();
    const api = stubApi();
    api.get.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ data: rows(["a", "running"]) }), 25_000),
        ) as never,
    );
    const feed = createStatusFeed(createApi(api), 20_000);
    const stop = feed.subscribe(1, () => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(feed.rows(1)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feed.rows(1)).not.toBeNull();
    stop();
  });

  it("drops an answer read for a feed that has since gone", async () => {
    vi.useFakeTimers();
    const api = stubApi();
    let call = 0;
    api.get.mockImplementation(() => {
      const mine = ++call;
      const status = mine === 1 ? "exited" : "running";
      const wait = mine === 1 ? 10_000 : 1_000;
      return new Promise((resolve) =>
        setTimeout(() => resolve({ data: rows(["a", status]) }), wait),
      ) as never;
    });
    const feed = createStatusFeed(createApi(api), 20_000);
    feed.subscribe(1, () => {})();
    const stop = feed.subscribe(1, () => {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(feed.rows(1)).toEqual([
      expect.objectContaining({ status: "running" }),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(feed.rows(1)).toEqual([
      expect.objectContaining({ status: "running" }),
    ]);
    stop();
  });
});
