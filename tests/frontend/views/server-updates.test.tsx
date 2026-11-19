import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

const manifest = manifestJson as unknown as PluginManifest;
const ALL = [
  "coolify.view",
  "coolify.operate",
  "coolify.configure",
  "coolify.administer",
];
const U = locales.updates;

const linked = {
  id: 7,
  userId: "user-1",
  name: "web-1",
  ip: "203.0.113.11",
  port: 22,
  username: "root",
  pluginSettings: {
    coolify: {
      coolifyLinked: true,
      coolifyConnectionId: "1",
      coolifyServerUuid: "srv-web1",
    },
  },
};

const coolifyPatch = {
  updates: 3,
  security: 1,
  rebootRequired: true,
  checkedAt: "2026-11-18T10:00:00.000Z",
  error: null,
  items: [
    {
      package: "docker-ce",
      newVersion: "5:27.0.1",
      currentVersion: "5:26.1.0",
      security: false,
      risk: "docker",
    },
    {
      package: "openssl",
      newVersion: "3.0.2-0ubuntu1.18",
      currentVersion: "3.0.2-0ubuntu1.17",
      security: true,
      risk: null,
    },
    {
      package: "linux-image-generic",
      newVersion: "5.15.0.130",
      currentVersion: "5.15.0.125",
      security: false,
      risk: "kernel",
    },
  ],
};

function status(overrides: Record<string, unknown> = {}) {
  return {
    server: { uuid: "srv-web1", name: "web-1" },
    hostId: 7,
    coolify: coolifyPatch,
    fresh: null,
    via: null,
    ...overrides,
  };
}

function stubApi(answer = status()) {
  const mocks = {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith("/updates")
        ? answer
        : url === "/connections/1/servers"
          ? []
          : { id: 1, name: "Prod" },
    })),
    post: vi.fn(async (url: string, _body?: unknown) => ({
      data: url.endsWith("/updates/check")
        ? {
            via: "ssh",
            fresh: {
              ...coolifyPatch,
              updates: 1,
              security: 0,
              rebootRequired: false,
              items: [coolifyPatch.items[0]],
              checkedAt: "2026-11-19T09:00:00.000Z",
            },
          }
        : url.endsWith("/updates/install")
          ? {
              via: "package-manager",
              summary: "Upgraded all packages",
              changed: true,
              pending: false,
              output: "",
            }
          : { via: "ssh", summary: "Rebooting web-1" },
    })),
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

async function renderSection(
  api: ReturnType<typeof stubApi>,
  permissions = ALL,
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions,
  });
  const section = listHostSections().find(
    (s) => s.id === "coolify" || s.id.endsWith(":coolify"),
  );
  if (!section) throw new Error("no coolify host section");
  const Section = section.component;
  render(
    <SurfaceScope>
      <Section
        host={linked as never}
        isVisible
        shell={{ openSingletonTab: vi.fn() } as never}
      />
    </SurfaceScope>,
  );
  return screen.findByTestId("coolify-updates");
}

describe("server updates in the host section", () => {
  it("shows Coolify's update summary: counts, security, reboot and when it was checked", async () => {
    const card = await renderSection(stubApi());
    await waitFor(() =>
      expect(card.textContent).toContain(
        U.summary.replace("{{count}}", "3").replace("{{security}}", "1"),
      ),
    );
    expect(card.textContent).toContain(U.rebootRequired);
    expect(card.textContent).toContain(U.dockerRisk.replace("{{count}}", "1"));
    expect(card.textContent).toContain(U.source.coolify.split("{{")[0]);
  });

  it("check now shows the fresh result and which path ran", async () => {
    const api = stubApi();
    const card = await renderSection(api);
    fireEvent.click(await within(card).findByRole("button", { name: U.check }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/servers/srv-web1/updates/check",
        {},
      ),
    );
    await waitFor(() =>
      expect(card.textContent).toContain(U.source.ssh.split("{{")[0]),
    );
    expect(card.textContent).toContain(
      U.summary.replace("{{count}}", "1").replace("{{security}}", "0"),
    );
  });

  it("updates install confirm lists packages and flags docker risk", async () => {
    const api = stubApi();
    const card = await renderSection(api);
    fireEvent.click(
      await within(card).findByRole("button", { name: U.install }),
    );
    const confirm = await within(card).findByRole("group", {
      name: U.installConfirm.title
        .replace("{{count}}", "3")
        .replace("{{server}}", "web-1"),
    });
    const rows = within(confirm).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-package"))).toEqual([
      "docker-ce",
      "openssl",
      "linux-image-generic",
    ]);
    const docker = rows[0];
    expect(docker.getAttribute("data-risk")).toBe("docker");
    expect(docker.textContent).toContain(U.risk.docker);
    expect(rows[1].getAttribute("data-risk")).toBeNull();
    expect(rows[1].textContent).not.toContain(U.risk.docker);
    expect(confirm.textContent).toContain(U.installConfirm.dockerWarning);
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.click(
      within(confirm).getByRole("button", { name: U.installConfirm.confirm }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/servers/srv-web1/updates/install",
        { confirm: true },
      ),
    );
    await waitFor(() =>
      expect(card.textContent).toContain(
        U.installed["package-manager"].replace(
          "{{summary}}",
          "Upgraded all packages",
        ),
      ),
    );
  });

  it("reboot needs typed server name and warns that every app goes down", async () => {
    const api = stubApi();
    const card = await renderSection(api);
    fireEvent.click(
      await within(card).findByRole("button", { name: U.reboot }),
    );
    const confirm = await within(card).findByRole("group", {
      name: U.rebootConfirm.title.replace("{{server}}", "web-1"),
    });
    expect(confirm.textContent).toContain(
      U.rebootConfirm.warning.replace("{{server}}", "web-1"),
    );
    const go = within(confirm).getByRole("button", {
      name: U.rebootConfirm.confirm,
    }) as HTMLButtonElement;
    const input = within(confirm).getByLabelText(
      U.rebootConfirm.typeName.replace("{{server}}", "web-1"),
    );
    expect(go.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "web-2" } });
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "web-1" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connections/1/servers/srv-web1/reboot",
        { confirmName: "web-1" },
      ),
    );
  });

  it("hides install without operate and reboot without administer", async () => {
    const card = await renderSection(stubApi(), ["coolify.view"]);
    await waitFor(() =>
      expect(card.textContent).toContain(
        U.summary.replace("{{count}}", "3").replace("{{security}}", "1"),
      ),
    );
    expect(within(card).queryByRole("button", { name: U.install })).toBeNull();
    expect(within(card).queryByRole("button", { name: U.check })).toBeNull();
    expect(within(card).queryByRole("button", { name: U.reboot })).toBeNull();
  });
});
