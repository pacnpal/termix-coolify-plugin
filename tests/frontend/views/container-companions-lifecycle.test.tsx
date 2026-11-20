import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactElement } from "react";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type {
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { Resource } from "../../../src/frontend/api";
import { forgetCompanions } from "../../../src/frontend/companions";
import { ContainerCompanions } from "../../../src/frontend/views/ContainerCompanions";
import { TunnelsCoolifyView } from "../../../src/frontend/views/TunnelsCoolifyView";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { stubApi } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const C = locales.containerCompanions;
const ALL = ["coolify.view", "coolify.operate"];
const RUNNING = { tunnels: true, reverseProxy: true, files: false };

const app = {
  uuid: "app-web-uuid",
  name: "web",
  kind: "application",
  fqdns: [],
} as unknown as Resource;

const FORWARD = {
  name: "web:7:coolify-app-web-uuid",
  hostId: 7,
  targetPort: 3000,
  bindHost: "127.0.0.1",
  bindPort: 41234,
};
const listening = C.listening
  .replace("{{bindHost}}", "127.0.0.1")
  .replace("{{bindPort}}", "41234");

function linked(id: number, connectionId: string): PluginHostRecord {
  return {
    id,
    name: `host-${id}`,
    ip: "203.0.113.5",
    port: 22,
    username: "deploy",
    pluginSettings: {
      coolify: {
        coolifyLinked: true,
        coolifyConnectionId: connectionId,
        coolifyServerUuid: "srv-vps1-uuid",
      },
    },
  } as unknown as PluginHostRecord;
}

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  forgetCompanions();
  vi.restoreAllMocks();
});

function api() {
  const stub = stubApi();
  const get = stub.get.getMockImplementation()!;
  stub.get.mockImplementation(async (url: string) =>
    url === "/companions" ? { data: RUNNING } : get(url),
  );
  stub.post.mockResolvedValue({ data: FORWARD } as never);
  return stub;
}

async function mountTab(
  stub: ReturnType<typeof stubApi>,
  View: () => ReactElement,
) {
  rendered = await renderWithApp(
    {
      activate(a: TermixApp) {
        a.registerTab("coolify", () => <View />, {
          titleKey: "tab.title",
          singleton: true,
          hostless: true,
        });
      },
    },
    { manifest, locales, api: stub, permissions: ALL },
  );
  rendered.renderTab("coolify");
}

describe("container companion state outlives its panel", () => {
  it("an open forward is still shown, with Stop, after switching panels", async () => {
    const stub = api();
    await mountTab(stub, () => (
      <ContainerCompanions connectionId={1} resource={app} revision="rev-1" />
    ));
    fireEvent.click(await screen.findByRole("button", { name: C.reach }));
    fireEvent.change(screen.getByLabelText(C.port), {
      target: { value: "3000" },
    });
    fireEvent.click(screen.getByRole("button", { name: C.forward }));
    expect(await screen.findByText(listening)).toBeTruthy();
    // Switch to Open web UI, then back.
    fireEvent.click(screen.getByRole("button", { name: C.webUi }));
    await waitFor(() => expect(screen.queryByText(listening)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: C.reach }));
    expect(await screen.findByText(listening)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: C.stop }));
    await waitFor(() =>
      expect(stub.delete).toHaveBeenCalledWith(
        "/connections/1/resources/app-web-uuid/tunnel/3000",
      ),
    );
  });
});

describe("the Tunnels view follows its host", () => {
  it("drops the old host's resources as soon as the host changes", async () => {
    const stub = api();
    const get = stub.get.getMockImplementation()!;
    let connectionReads = 0;
    stub.get.mockImplementation(async (url: string) => {
      // The second host's connection list never answers.
      if (url === "/connections" && ++connectionReads > 1) {
        return new Promise(() => {});
      }
      return get(url);
    });
    let pick: (host: PluginHostRecord) => void = () => {};
    function Switcher() {
      const [host, setHost] = useState(linked(7, "1"));
      pick = setHost;
      return <TunnelsCoolifyView host={host} />;
    }
    await mountTab(stub, Switcher);
    expect(await screen.findByRole("group", { name: "web" })).toBeTruthy();
    act(() => pick(linked(8, "2")));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "web" })).toBeNull(),
    );
    expect(
      within(document.body).queryByRole("button", { name: C.forward }),
    ).toBeNull();
  });
});
