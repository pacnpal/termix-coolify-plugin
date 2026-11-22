import { describe, expect, it, vi } from "vitest";
import type {
  HostContextMenuItemContribution,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { activate } from "../../src/frontend/index";
import { stubClient } from "./helpers";

/**
 * The host menu's Unlink runs in the background frame with the link it read
 * when it was clicked. Its confirm is over the main area, not a view, so
 * what can go stale while it is open is the host itself: unlinked, linked to
 * another server, or deleted. It reads the host again after the confirm and
 * sends nothing unless its link is still the one the confirm named (#86).
 */

function host(id: number, serverUuid: string | null): PluginHostRecord {
  return {
    id,
    name: `host-${id}`,
    ip: "203.0.113.11",
    pluginSettings: serverUuid
      ? {
          coolify: {
            coolifyLinked: true,
            coolifyConnectionId: "1",
            coolifyServerUuid: serverUuid,
          },
        }
      : {},
  } as unknown as PluginHostRecord;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Activates the plugin on a minimal app and returns the Unlink menu item. */
function setup(listHosts: () => Promise<PluginHostRecord[]>) {
  const client = stubClient({
    post: async () => ({ data: { hostId: 7, removed: false } }),
  });
  const answer = deferred<boolean>();
  const items = new Map<string, HostContextMenuItemContribution>();
  const known: Record<string | symbol, unknown> = {
    api: client,
    t: (key: string) => key,
    hasPermission: async () => false,
    confirm: vi.fn(() => answer.promise),
    listHosts: vi.fn(listHosts),
    getHost: () => undefined,
    onDispose: () => {},
    wsUrl: async () => null,
    tabs: { openSingletonTab: vi.fn() },
    registerHostContextMenuItem: (item: HostContextMenuItemContribution) => {
      items.set(item.id, item);
      return () => {};
    },
  };
  const app = new Proxy(known, {
    get: (target, prop) =>
      prop in target
        ? target[prop]
        : prop === "then"
          ? undefined
          : () => () => {},
  }) as unknown as TermixApp;
  activate(app);
  const unlink = items.get("coolify.unlink");
  if (!unlink) throw new Error("no unlink menu item");
  return { client, answer, unlink, app: known };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("host menu Unlink (#86)", () => {
  it("unlinks when the host still has the link the confirm named", async () => {
    const clicked = host(7, "srv-web1");
    const { client, answer, unlink } = setup(async () => [clicked]);
    unlink.run(clicked, {} as never);
    answer.resolve(true);
    await settle();
    expect(client.post).toHaveBeenCalledWith(
      "/connections/1/servers/srv-web1/unlink",
      { removeHost: false },
    );
  });

  it("sends nothing when the confirm is declined", async () => {
    const clicked = host(7, "srv-web1");
    const { client, answer, unlink, app } = setup(async () => [clicked]);
    unlink.run(clicked, {} as never);
    answer.resolve(false);
    await settle();
    expect(client.post).not.toHaveBeenCalled();
    expect(app.listHosts).not.toHaveBeenCalled();
  });

  it("sends nothing when the host was linked to another server meanwhile", async () => {
    const clicked = host(7, "srv-web1");
    const { client, answer, unlink } = setup(async () => [host(7, "srv-web2")]);
    unlink.run(clicked, {} as never);
    answer.resolve(true);
    await settle();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("sends nothing when the host was unlinked meanwhile", async () => {
    const clicked = host(7, "srv-web1");
    const { client, answer, unlink } = setup(async () => [host(7, null)]);
    unlink.run(clicked, {} as never);
    answer.resolve(true);
    await settle();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("sends nothing when the host was deleted meanwhile", async () => {
    const clicked = host(7, "srv-web1");
    const { client, answer, unlink } = setup(async () => [host(8, "srv-web1")]);
    unlink.run(clicked, {} as never);
    answer.resolve(true);
    await settle();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("sends nothing when the hosts can't be read again", async () => {
    const clicked = host(7, "srv-web1");
    const { client, answer, unlink } = setup(async () => {
      throw new Error("offline");
    });
    unlink.run(clicked, {} as never);
    answer.resolve(true);
    await settle();
    expect(client.post).not.toHaveBeenCalled();
  });
});
