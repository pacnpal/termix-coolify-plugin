import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { Resource } from "../../../src/frontend/api";
import { forgetCompanions } from "../../../src/frontend/companions";
import { ContainerCompanions } from "../../../src/frontend/views/ContainerCompanions";
import manifestJson from "../../../manifest.json";
import locales from "../../../locales/en.json";
import { stubApi } from "../fixtures";

const manifest = manifestJson as unknown as PluginManifest;
const C = locales.containerCompanions;
const ALL = ["coolify.view", "coolify.operate"];

const app = {
  uuid: "app-web-uuid",
  name: "web",
  kind: "application",
  fqdns: [],
} as unknown as Resource;

const RUNNING = { tunnels: true, reverseProxy: true, files: false };

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
  return stub;
}

/** ContainerCompanions whose revision a test can switch. */
async function mount(stub: ReturnType<typeof stubApi>) {
  let pick: (revision: string) => void = () => {};
  function Switcher() {
    const [revision, setRevision] = useState("rev-1");
    pick = setRevision;
    return (
      <ContainerCompanions
        connectionId={1}
        resource={app}
        revision={revision}
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
    { manifest, locales, api: stub, permissions: ALL },
  );
  rendered.renderTab("coolify");
  return (revision: string) => act(() => pick(revision));
}

const listening = C.listening
  .replace("{{bindHost}}", "127.0.0.1")
  .replace("{{bindPort}}", "41234");

describe("container companions follow their target", () => {
  it("an open forward doesn't carry over to a changed target", async () => {
    const stub = api();
    stub.post.mockResolvedValue({
      data: {
        name: "web:7:coolify-app-web-uuid",
        hostId: 7,
        targetPort: 3000,
        bindHost: "127.0.0.1",
        bindPort: 41234,
      },
    } as never);
    const pick = await mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: C.reach }));
    fireEvent.change(screen.getByLabelText(C.port), {
      target: { value: "3000" },
    });
    fireEvent.click(screen.getByRole("button", { name: C.forward }));
    expect(await screen.findByText(listening)).toBeTruthy();
    pick("rev-2");
    await waitFor(() => expect(screen.queryByText(listening)).toBeNull());
    expect(screen.queryByRole("button", { name: C.stop })).toBeNull();
  });

  it("a late web UI link for the old target is dropped", async () => {
    const stub = api();
    let answer: (v: unknown) => void = () => {};
    stub.post.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)) as never,
    );
    const pick = await mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: C.webUi }));
    fireEvent.click(screen.getByRole("button", { name: C.open }));
    await waitFor(() => expect(stub.post).toHaveBeenCalled());
    pick("rev-2");
    await act(async () => {
      answer({ data: { url: "https://e-1.apps.example.test/?once=old" } });
    });
    expect(screen.queryByRole("link", { name: C.openLink })).toBeNull();
  });
});
