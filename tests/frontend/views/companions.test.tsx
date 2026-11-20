import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  act,
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
import type {
  PluginApiClient,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../../src/frontend/index";
import { forgetCompanions } from "../../../src/frontend/companions";
import { CompanionActions } from "../../../src/frontend/views/CompanionActions";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;
const ALL = ["coolify.view", "coolify.operate", "coolify.configure"];

const NONE_RUNNING = {
  docker: false,
  sshTerminal: false,
  files: false,
  tunnels: false,
  reverseProxy: false,
  dns: false,
  uptime: false,
  logSearch: false,
  packageManager: false,
  securityCenter: false,
  hostMetrics: false,
  databases: false,
  backups: false,
};
const ALL_RUNNING = Object.fromEntries(
  Object.keys(NONE_RUNNING).map((k) => [k, true]),
) as typeof NONE_RUNNING;

const app = {
  uuid: "app-web-uuid",
  name: "web",
  kind: "application",
  fqdns: ["https://a.example.test", "https://b.example.test/app"],
};
const database = {
  uuid: "db-main-uuid",
  name: "main-db",
  kind: "database",
  fqdns: [],
};

const linkedHost = {
  id: 7,
  userId: "user-1",
  name: "web-1",
  ip: "203.0.113.11",
  port: 22,
  username: "root",
  authType: "credential",
  pluginSettings: {
    coolify: {
      coolifyLinked: true,
      coolifyConnectionId: "1",
      coolifyServerUuid: "srv-web1",
    },
  },
};

function stubApi(running: typeof NONE_RUNNING) {
  const answers: Record<string, unknown> = {
    "/companions": running,
    "/connections/1": { id: 1, name: "Prod" },
    "/connections/1/servers": [],
    "/connections/1/resources/app-web-uuid/dns": [
      {
        id: 4,
        fqdn: "b.example.test",
        type: "A",
        content: "203.0.113.11",
        createdAt: "2026-11-19T10:00:00.000Z",
      },
    ],
    "/connections/1/resources/app-web-uuid/uptime": {
      monitors: [
        {
          id: "mon-a",
          name: "web monitor",
          url: "https://a.example.test",
          status: "down",
        },
      ],
    },
    "/connections/1/log-search?uuid=app-web-uuid": {
      source: "docker",
      query: "app-web-uuid",
      results: [
        { time: "10:00", host: "web-1", container: null, message: "GET / 200" },
      ],
    },
    "/connections/1/resources/db-main-uuid/db-login": {
      hostId: 7,
      saved: true,
      logins: [],
    },
    "/connections/1/servers/srv-web1/security": {
      hostId: 7,
      score: 82,
      critical: 2,
    },
    "/connections/1/servers/srv-web1/host-metrics": {
      hostId: 7,
      applications: 3,
      services: 1,
      databases: 2,
    },
    "/connections/1/servers/srv-web1/backups-failed": {
      hostId: 7,
      jobs: [{ id: "job-1", name: "nightly", failedAt: "03:00" }],
    },
    "/connections/1/servers/srv-web1/db-logins": {
      hostId: 7,
      databases: [
        { uuid: "db-main-uuid", name: "main-db", saved: true },
        { uuid: "svc-db", name: "postgresql", saved: false },
      ],
    },
  };
  const mocks = {
    get: vi.fn(async (url: string) => ({ data: answers[url] ?? {} })),
    post: vi.fn(async () => ({
      data: {
        id: 5,
        fqdn: "a.example.test",
        type: "A",
        content: "203.0.113.11",
        createdAt: "2026-11-19T11:00:00.000Z",
      },
    })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
  };
  return mocks as unknown as typeof mocks & PluginApiClient;
}

let rendered: RenderedPluginApp | null = null;

beforeEach(() => {
  forgetCompanions();
});

afterEach(async () => {
  cleanup();
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

async function mount(
  running: typeof NONE_RUNNING,
  permissions: string[] = ALL,
) {
  const api = stubApi(running);
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  return api;
}

function hostSection() {
  const section = listHostSections().find(
    (s) => s.id === "coolify" || s.id.endsWith(":coolify"),
  );
  if (!section) throw new Error("no coolify host section");
  return section.component;
}

const shell = () => ({ openSingletonTab: vi.fn() });

type Resource = typeof app;

/**
 * Mounts CompanionActions for `resources` inside a registered tab, the way
 * the Coolify tab draws it, so the SDK hooks have their plugin scope.
 */
async function mountActions(
  resources: Resource[],
  running: typeof NONE_RUNNING,
  permissions: string[] = ALL,
) {
  const api = stubApi(running);
  const s = shell();
  const host = {
    activate(a: TermixApp) {
      a.registerTab(
        "coolify",
        () => (
          <div>
            {resources.map((r) => (
              <CompanionActions
                key={r.uuid}
                connectionId={1}
                resource={r}
                shell={s}
              />
            ))}
          </div>
        ),
        { titleKey: "tab.title", singleton: true, hostless: true },
      );
    },
  };
  rendered = await renderWithApp(host, { manifest, locales, api, permissions });
  rendered.renderTab("coolify");
  return { api, shell: s };
}

describe("companion UI", () => {
  it("companion buttons hide when companion missing", async () => {
    const actions = await mountActions([app, database], NONE_RUNNING);
    await waitFor(() =>
      expect(actions.api.get).toHaveBeenCalledWith("/companions"),
    );
    for (const label of [
      locales.companions.dns.create,
      locales.companions.logs.search,
      locales.companions.uptime.open,
      locales.companions.databases.open,
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    cleanup();
    await rendered?.deactivate();
    forgetCompanions();

    const api = await mount(NONE_RUNNING);
    const Section = hostSection();
    render(
      <SurfaceScope>
        <Section
          host={linkedHost as never}
          isVisible
          shell={shell() as never}
        />
      </SurfaceScope>,
    );
    await screen.findByText(locales.hostSection.resources);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/companions"));
    expect(screen.queryByText(locales.companions.security.label)).toBeNull();
    expect(screen.queryByText(locales.companions.metrics.title)).toBeNull();
    expect(screen.queryByText(locales.companions.backups.title)).toBeNull();
    expect(screen.queryByText(locales.companions.databases.open)).toBeNull();
    // Only the map was read: no companion route was called.
    const companionCalls = [
      ...actions.api.get.mock.calls,
      ...api.get.mock.calls,
    ]
      .map((c) => String(c[0]))
      .filter((u) =>
        /dns|uptime|log-search|security|metrics|backups|db-login/.test(u),
      );
    expect(companionCalls).toEqual([]);
  });

  it("shows every resource action when its plugin runs", async () => {
    const { shell: s } = await mountActions([app, database], ALL_RUNNING);
    expect(await screen.findByText(locales.companions.dns.create)).toBeTruthy();
    // Both the application and the database can search their logs.
    expect(screen.getAllByText(locales.companions.logs.search)).toHaveLength(2);
    expect(await screen.findByText("web monitor")).toBeTruthy();
    expect(
      screen.getByText(locales.companions.uptime.status.down),
    ).toBeTruthy();
    expect(
      await screen.findByText(locales.companions.databases.saved),
    ).toBeTruthy();

    fireEvent.click(screen.getByText(locales.companions.uptime.open));
    expect(s.openSingletonTab).toHaveBeenCalledWith("uptime");
    fireEvent.click(screen.getByText(locales.companions.databases.open));
    expect(s.openSingletonTab).toHaveBeenCalledWith("databases");
  });

  it("hides Create DNS record without configure and Search logs without operate", async () => {
    const { shell: s } = await mountActions([app], ALL_RUNNING, [
      "coolify.view",
    ]);
    expect(await screen.findByText("web monitor")).toBeTruthy();
    expect(screen.queryByText(locales.companions.dns.create)).toBeNull();
    expect(screen.queryByText(locales.companions.logs.search)).toBeNull();
  });

  it("creates a DNS record for one of the resource's domains, and removes one", async () => {
    const { api, shell: s } = await mountActions([app], ALL_RUNNING);
    fireEvent.click(await screen.findByText(locales.companions.dns.create));
    fireEvent.click(screen.getByText(locales.companions.dns.submit));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/dns",
        { fqdn: "a.example.test" },
      ),
    );
    const removes = await screen.findAllByText(locales.companions.dns.remove);
    // Removing deletes the record in DNS, so it asks first.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(removes[0]);
    const dialog = await screen
      .findByRole("alertdialog", {}, { timeout: 200 })
      .catch(() => null);
    if (dialog) {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: locales.companions.dns.removeConfirm.confirm,
        }),
      );
    }
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/dns/4",
      ),
    );
  });

  /** CompanionActions whose resource and revision a test can switch. */
  async function mountSwitcher(
    api: ReturnType<typeof stubApi>,
    first: Resource,
  ) {
    let pick: (r: Resource, revision?: string) => void = () => {};
    function Switcher() {
      const [state, setState] = useState({ r: first, revision: "rev-1" });
      pick = (r, revision = "rev-1") => setState({ r, revision });
      return (
        <CompanionActions
          connectionId={1}
          resource={state.r}
          revision={state.revision}
          shell={shell()}
        />
      );
    }
    rendered = await renderWithApp(
      {
        activate(a: TermixApp) {
          a.registerTab("coolify", () => <Switcher />, {
            titleKey: "tab.title",
            singleton: true,
            hostless: true,
          });
        },
      },
      { manifest, locales, api, permissions: ALL },
    );
    rendered.renderTab("coolify");
    return (r: Resource, revision?: string) => act(() => pick(r, revision));
  }

  const service = {
    uuid: "svc-n8n-uuid",
    name: "n8n",
    kind: "service",
    fqdns: ["https://n8n.example.test"],
  };
  const part = {
    uuid: "svc-n8n-app",
    name: "n8n app",
    kind: "service-application",
    fqdns: ["https://n8n.example.test"],
  };

  it("switching from a service to its Part clears the logs", async () => {
    const api = stubApi(ALL_RUNNING);
    const get = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) =>
      url.includes("log-search")
        ? {
            data: {
              source: "docker",
              query: "x",
              results: [{ message: `line for ${url.split("=")[1]}` }],
            },
          }
        : get(url),
    );
    const pick = await mountSwitcher(api, service);
    fireEvent.click(await screen.findByText(locales.companions.logs.search));
    expect(await screen.findByText(/line for svc-n8n-uuid/)).toBeTruthy();
    pick(part);
    await waitFor(() =>
      expect(screen.queryByText(/line for svc-n8n-uuid/)).toBeNull(),
    );
    expect(screen.queryByText(locales.companions.logs.source)).toBeNull();
  });

  it("a late search answer for the old resource is dropped", async () => {
    const api = stubApi(ALL_RUNNING);
    const get = api.get.getMockImplementation()!;
    let answer: (v: unknown) => void = () => {};
    api.get.mockImplementation(async (url: string) =>
      url.includes("log-search")
        ? new Promise((resolve) => (answer = resolve))
        : get(url),
    );
    const pick = await mountSwitcher(api, service);
    fireEvent.click(await screen.findByText(locales.companions.logs.search));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/connections/1/log-search?uuid=svc-n8n-uuid",
      ),
    );
    pick(part);
    await act(async () => {
      answer({
        data: {
          source: "docker",
          query: "svc-n8n-uuid",
          results: [{ message: "late service line" }],
        },
      });
    });
    expect(screen.queryByText(/late service line/)).toBeNull();
    expect(screen.queryByText(locales.companions.logs.source)).toBeNull();
  });

  it("Uptime and saved-login readings never show under another resource or revision", async () => {
    const api = stubApi(ALL_RUNNING);
    const get = api.get.getMockImplementation()!;
    // After the first reads, nothing answers again.
    let first = true;
    api.get.mockImplementation(async (url: string) => {
      if (url === "/companions") return get(url);
      if (!first) return new Promise(() => {});
      return get(url.replace("db-main-uuid/uptime", "app-web-uuid/uptime"));
    });
    const db = { ...database, fqdns: app.fqdns };
    const pick = await mountSwitcher(api, db);
    expect(await screen.findByText("web monitor")).toBeTruthy();
    expect(
      await screen.findByText(locales.companions.databases.saved),
    ).toBeTruthy();
    first = false;
    pick(db, "rev-2");
    await waitFor(() => expect(screen.queryByText("web monitor")).toBeNull());
    expect(screen.queryByText(locales.companions.databases.saved)).toBeNull();
  });

  it("a DNS record of one resource is never removed under another", async () => {
    const api = stubApi(ALL_RUNNING);
    const other = { ...app, uuid: "app-two-uuid", name: "two" };
    // The other resource's list never answers, so nothing replaces A's rows.
    const get = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) =>
      url.includes("app-two-uuid") ? new Promise(() => {}) : get(url),
    );
    let pick: (r: Resource) => void = () => {};
    function Switcher() {
      const [r, setR] = useState<Resource>(app);
      pick = setR;
      return <CompanionActions connectionId={1} resource={r} shell={shell()} />;
    }
    const host = {
      activate(a: TermixApp) {
        a.registerTab("coolify", () => <Switcher />, {
          titleKey: "tab.title",
          singleton: true,
          hostless: true,
        });
      },
    };
    rendered = await renderWithApp(host, {
      manifest,
      locales,
      api,
      permissions: ALL,
    });
    rendered.renderTab("coolify");
    const confirm = async () => {
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: locales.companions.dns.removeConfirm.confirm,
        }),
      );
    };

    // A confirm opened for A, answered after the view moved to B: nothing.
    fireEvent.click(
      (await screen.findAllByText(locales.companions.dns.remove))[0],
    );
    await screen.findByRole("alertdialog");
    act(() => pick(other));
    await confirm();
    // A's rows are gone at once, before B's list answers.
    await waitFor(() =>
      expect(screen.queryByText(/b\.example\.test A/)).toBeNull(),
    );
    expect(screen.queryByText(locales.companions.dns.remove)).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("the host card never shows one server's readings for another", async () => {
    const api = await mount(ALL_RUNNING);
    const get = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) =>
      url.includes("srv-web2") ? new Promise(() => {}) : get(url),
    );
    const Section = hostSection();
    const s = shell();
    const view = (host: typeof linkedHost) => (
      <SurfaceScope>
        <Section host={host as never} isVisible shell={s as never} />
      </SurfaceScope>
    );
    const score = locales.companions.security.score.replace("{{score}}", "82");
    const { rerender } = render(view(linkedHost));
    expect(await screen.findByText(score)).toBeTruthy();
    const moved = {
      ...linkedHost,
      pluginSettings: {
        coolify: {
          ...linkedHost.pluginSettings.coolify,
          coolifyServerUuid: "srv-web2",
        },
      },
    };
    rerender(view(moved));
    await waitFor(() => expect(screen.queryByText(score)).toBeNull());
  });

  it("searches logs across servers with the resource's uuid", async () => {
    const { api, shell: s } = await mountActions([app], ALL_RUNNING);
    fireEvent.click(await screen.findByText(locales.companions.logs.search));
    expect(
      await screen.findByText(locales.companions.logs.source),
    ).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/connections/1/log-search?uuid=app-web-uuid",
    );
    expect(screen.getByText(/GET \/ 200/)).toBeTruthy();
  });

  it("the Linked host card shows Security Center, Host Metrics, Backups and Databases", async () => {
    await mount(ALL_RUNNING);
    const s = shell();
    const Section = hostSection();
    render(
      <SurfaceScope>
        <Section host={linkedHost as never} isVisible shell={s as never} />
      </SurfaceScope>,
    );
    expect(
      await screen.findByText(
        locales.companions.security.score.replace("{{score}}", "82"),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        locales.companions.security.critical.replace("{{count}}", "2"),
      ),
    ).toBeTruthy();
    expect(screen.getByText(locales.companions.metrics.title)).toBeTruthy();
    expect(
      screen.getByText(
        locales.companions.metrics.counts
          .replace("{{applications}}", "3")
          .replace("{{services}}", "1")
          .replace("{{databases}}", "2"),
      ),
    ).toBeTruthy();
    expect(screen.getByText(/nightly/)).toBeTruthy();
    expect(
      screen.getByText(
        locales.companions.databases.summary
          .replace("{{saved}}", "1")
          .replace("{{total}}", "2"),
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByText(locales.companions.databases.open));
    expect(s.openSingletonTab).toHaveBeenCalledWith("databases");
  });
});
