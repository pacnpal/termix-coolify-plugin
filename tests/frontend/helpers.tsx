import { expect, vi, type Mock } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import {
  listHostSections,
  PluginComponent,
  SurfaceScope,
} from "@termix-ssh/plugin-sdk/ui";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { ComponentType } from "react";
import type {
  CompanionProps,
  PluginApiClient,
  PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

export const manifest = manifestJson as unknown as PluginManifest;
export const ALL = ["coolify.view", "coolify.configure"];

/** Renders the plugin with a fake app, the manifest and the locales. */
export function renderApp(
  api: PluginApiClient,
  permissions: string[] = ALL,
): Promise<RenderedPluginApp> {
  return renderWithApp(plugin, { manifest, locales, api, permissions });
}

/** A Connection as the routes answer it. */
export function connectionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    teamName: null as string | null,
    version: "v4.7.5",
    scoped: false,
    abilities: {
      read: true,
      sensitive: true,
      keys: true,
      root: false,
      mcp: false,
    },
    lastError: null,
    autoSync: false,
    access: "owner",
    allowPrivate: false,
    caCert: null,
    cfAccess: false,
    lastCheckedAt: null as string | null,
    steps: [] as { id: string; ok: boolean; cause?: string }[],
    ...overrides,
  };
}

/** A Coolify server as the sync preview answers it. */
export function syncServer(
  uuid: string,
  name: string,
  ip: string,
  extra: Record<string, unknown> = {},
) {
  return {
    uuid,
    name,
    ip,
    port: 22,
    user: "root",
    isTunnel: false,
    isCoolifyHost: false,
    reachable: true,
    usable: true,
    ...extra,
  };
}

/** One sync preview row for a server. */
export function syncRow(
  srv: ReturnType<typeof syncServer>,
  extra: Record<string, unknown> = {},
) {
  return {
    server: srv,
    hostId: null as number | null,
    status: "new",
    mode: "coolify",
    addressOverride: null,
    suggestedAddress: null,
    credentialId: null as number | null,
    tunnel: srv.isTunnel,
    viaTunnel: false,
    ...extra,
  };
}

/** Waits for a shell call, made after `since`, that opens Termix's Plugins tab. */
export async function expectOpenedPlugins(
  rendered: RenderedPluginApp,
  since = 0,
): Promise<void> {
  await waitFor(() =>
    expect(rendered.shellCalls.slice(since)).toContainEqual(
      expect.objectContaining({
        method: "openSingletonTab",
        args: expect.arrayContaining(["plugins"]),
      }),
    ),
  );
}

/** Clicks Open Plugins inside `root` and checks the Plugins tab opened. */
export async function clickOpenPlugins(
  rendered: RenderedPluginApp,
  root: HTMLElement,
): Promise<void> {
  const since = rendered.shellCalls.length;
  fireEvent.click(
    within(root).getByRole("button", { name: locales.sync.openPlugins }),
  );
  await expectOpenedPlugins(rendered, since);
}

/** Fills the connection form inside `root` and saves it. */
export function fillConnectionForm(root: HTMLElement): void {
  const L = locales.connections.form;
  const values: [string, string][] = [
    [L.namePlaceholder, "Prod"],
    [L.baseUrlPlaceholder, "https://coolify.example.test"],
    [L.tokenPlaceholder, "fake-token-ui"],
  ];
  for (const [placeholder, value] of values) {
    fireEvent.change(within(root).getByPlaceholderText(placeholder), {
      target: { value },
    });
  }
  fireEvent.click(within(root).getByRole("button", { name: L.save }));
}

/** Renders the registered Coolify host section for `host` with `shell`. */
export function renderHostSection(
  host: PluginHostRecord,
  shell: Record<string, unknown>,
) {
  const section = listHostSections().find(
    (s) => s.id === "coolify" || s.id.endsWith(":coolify"),
  );
  if (!section) throw new Error("no coolify host section");
  const Section = section.component;
  render(
    <SurfaceScope>
      <Section host={host as never} isVisible shell={shell as never} />
    </SurfaceScope>,
  );
  return section;
}

/**
 * A companion component, drawn in the plugin's scope so its SDK hooks work.
 * The test host has no renderCompanion, so it goes through registerComponent
 * and PluginComponent; `rerender` swaps the props, as the shell does when the
 * tab's host changes.
 */
export function renderCompanion(
  rendered: RenderedPluginApp,
  component: ComponentType<CompanionProps>,
  props: CompanionProps,
) {
  const id = `coolify.companion-under-test-${++companionRenders}`;
  rendered.app.registerComponent(
    id,
    component as unknown as ComponentType<Record<string, unknown>>,
  );
  const draw = (next: CompanionProps) => (
    <SurfaceScope>
      <PluginComponent id={id} {...next} />
    </SurfaceScope>
  );
  const view = render(draw(props));
  return {
    view,
    rerender: (next: CompanionProps) => view.rerender(draw(next)),
    /** Takes the companion away, as closing it does; the surface stays. */
    close: () => view.rerender(<SurfaceScope>{null}</SurfaceScope>),
  };
}
let companionRenders = 0;

type Call = (url: string, body?: unknown) => Promise<{ data: unknown }>;
type Calls = Record<"get" | "post" | "patch" | "delete" | "put", Mock<Call>>;

const empty: Call = async () => ({ data: {} });

/** A fake plugin API client: each call a vi.fn, answering `{}` unless given. */
export function stubClient(
  calls: Partial<Record<keyof Calls, Call>>,
): Calls & PluginApiClient {
  const mocks: Calls = {
    get: vi.fn(calls.get ?? empty),
    post: vi.fn(calls.post ?? empty),
    patch: vi.fn(calls.patch ?? empty),
    delete: vi.fn(calls.delete ?? empty),
    put: vi.fn(calls.put ?? empty),
  };
  return mocks as Calls & PluginApiClient;
}
