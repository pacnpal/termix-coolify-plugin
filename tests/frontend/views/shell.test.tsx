import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
const S = locales.shellTab;
const OPERATE = ["coolify.view", "coolify.operate"];
const COMMAND = "docker exec -it web-abc bash";
const FINGERPRINT = "SHA256:fake-host-key-fingerprint";

const host = {
  id: 7,
  userId: "user-1",
  name: "vps1",
  ip: "203.0.113.5",
  port: 22,
  username: "deploy",
  authType: "credential",
  folder: "Coolify",
  tags: "coolify",
};

const answer = {
  hostId: 7,
  title: "web",
  container: "web-abc",
  command: COMMAND,
  fingerprints: [FINGERPRINT],
};

/** What a failed axios call carries. */
function failure(status: number, data: unknown) {
  return Object.assign(new Error(`status ${status}`), {
    response: { status, data },
  });
}

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.restoreAllMocks();
});

function terminalStub() {
  const seen: Record<string, unknown>[] = [];
  function Terminal(props: Record<string, unknown>) {
    seen.push(props);
    return (
      <div data-testid="terminal-view">{String(props.executeCommand)}</div>
    );
  }
  return { Terminal, seen };
}

async function openShell(
  post: (url: string, body?: unknown) => Promise<{ data: unknown }>,
  options: { terminal?: boolean; data?: Record<string, unknown> } = {},
) {
  const api = stubApi();
  api.post.mockImplementation(post as never);
  const stub = terminalStub();
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    api,
    permissions: OPERATE,
    hosts: [host],
    others:
      options.terminal === false
        ? undefined
        : { components: { "terminal.view": stub.Terminal } },
  });
  const tab = rendered.renderTab("coolify-shell", {
    tab: {
      id: "s1",
      type: "coolify-shell",
      label: "web",
      data: options.data ?? { connectionId: 1, uuid: "app-web-uuid" },
    },
    isVisible: true,
  });
  return { api, tab, stub, rendered };
}

describe("coolify-shell tab", () => {
  it("shell tab renders terminal.view with executeCommand", async () => {
    const { api, tab, stub } = await openShell(async () => ({ data: answer }));
    await within(tab).findByTestId("terminal-view");
    expect(api.post).toHaveBeenCalledWith(
      "/connections/1/resources/app-web-uuid/shell",
      { console: "shell" },
    );
    const props = stub.seen.at(-1)!;
    expect(props.executeCommand).toBe(COMMAND);
    expect(String((props.hostConfig as { id: unknown }).id)).toBe("7");
    expect(props.isVisible).toBe(true);
  });

  it("without ssh-terminal shows NoticePanel and copyable command", async () => {
    const { tab } = await openShell(async () => ({ data: answer }), {
      terminal: false,
    });
    expect(await within(tab).findByText(S.noTerminal.title)).toBeTruthy();
    expect(within(tab).getByText(COMMAND)).toBeTruthy();
    expect(within(tab).getByRole("button", { name: S.copy })).toBeTruthy();
  });

  it("host-key error shows trust button and fingerprint", async () => {
    const { tab, rendered: r } = await openShell(async () => {
      throw failure(409, {
        error: "Open a server terminal once to trust this host's key.",
        cause: "host-key",
        hostId: 7,
        fingerprints: [FINGERPRINT],
      });
    });
    expect(await within(tab).findByText(S.errors["host-key"])).toBeTruthy();
    expect(within(tab).getByText(FINGERPRINT)).toBeTruthy();
    fireEvent.click(within(tab).getByRole("button", { name: S.trust }));
    await waitFor(() =>
      expect(r.shellCalls.some((c) => c.method === "connectHost")).toBe(true),
    );
  });

  it("not-linked and not-running say what to do", async () => {
    const linked = await openShell(async () => {
      throw failure(409, { error: "x", cause: "not-linked" });
    });
    expect(
      await within(linked.tab).findByText(S.errors["not-linked"]),
    ).toBeTruthy();
    await rendered?.deactivate();
    const running = await openShell(async () => {
      throw failure(409, { error: "x", cause: "not-running" });
    });
    expect(
      await within(running.tab).findByText(S.errors["not-running"]),
    ).toBeTruthy();
  });

  it("choices response shows container picker", async () => {
    const choices = [
      { name: "n8n-a", running: true, part: "part-n8n-uuid" },
      { name: "worker-a", running: true, part: "part-worker-uuid" },
    ];
    const { api, tab, stub } = await openShell(
      async (_url, body) => {
        const picked = (body as { container?: string }).container;
        if (!picked) throw failure(300, { choices });
        return {
          data: {
            ...answer,
            container: picked,
            command: `docker exec -it ${picked} bash`,
          },
        };
      },
      { data: { connectionId: 1, uuid: "svc-n8n-uuid" } },
    );
    expect(await within(tab).findByText(S.pick.title)).toBeTruthy();
    fireEvent.click(within(tab).getByRole("button", { name: /worker-a/ }));
    await within(tab).findByTestId("terminal-view");
    expect(api.post).toHaveBeenLastCalledWith(
      "/connections/1/resources/svc-n8n-uuid/shell",
      { console: "shell", container: "worker-a" },
    );
    expect(stub.seen.at(-1)!.executeCommand).toBe(
      "docker exec -it worker-a bash",
    );
  });
});

describe("open shell from a resource", () => {
  async function openDetail(permissions: string[], name: string) {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(),
      permissions,
    });
    const tab = rendered.renderTab("coolify", { isVisible: true });
    fireEvent.click(
      await within(tab).findByRole("button", { name: locales.nav.resources }),
    );
    await within(tab).findByText("web");
    fireEvent.click(
      within(tab)
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-name") === name)!,
    );
    await screen.findByText(locales.detail.fields.coolifyStatus);
    return rendered;
  }

  it("a database opens its console in a coolify-shell tab", async () => {
    const r = await openDetail(OPERATE, "main-db");
    expect(
      screen.getByRole("button", { name: locales.detail.actions.shell }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: locales.detail.actions.console }),
    );
    const call = r.shellCalls.find((c) => c.method === "openTab");
    expect(call).toBeTruthy();
    expect(call!.args[1]).toBe("coolify-shell");
    expect((call!.args[2] as { data: unknown }).data).toEqual({
      connectionId: 1,
      uuid: "db-main-uuid",
      console: "db",
    });
  });

  it("an application has a shell but no database console", async () => {
    await openDetail(OPERATE, "web");
    expect(
      screen.getByRole("button", { name: locales.detail.actions.shell }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: locales.detail.actions.console }),
    ).toBeNull();
  });

  it("offers no shell without coolify.operate", async () => {
    await openDetail(["coolify.view"], "web");
    expect(
      screen.queryByRole("button", { name: locales.detail.actions.shell }),
    ).toBeNull();
  });
});
