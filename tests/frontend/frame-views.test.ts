import { describe, expect, it } from "vitest";
import { checkFrameViews } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";
import locales from "../../locales/en.json";
import { resourceAnswer, resourceRows } from "./fixtures";

const connection = {
  id: 1,
  name: "Prod",
  baseUrl: "https://coolify.example.test",
  teamName: "Ops",
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
  lastCheckedAt: null,
  steps: [],
};

describe("sandboxed frame views", () => {
  it("asks core only for what a frame may reach", async () => {
    const { refused, errors, rendered } = await checkFrameViews(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
      locales,
      permissions: ["coolify.view", "coolify.configure", "coolify.mcp"],
      respond: (method, path) => {
        if (method !== "GET") return {};
        if (/\/connections$/.test(path)) return [connection];
        if (/\/resources(\?|$)/.test(path)) return resourceAnswer;
        if (/\/resources\/[^/]+$/.test(path)) return resourceRows[0];
        if (/\/mcp$/.test(path)) {
          return {
            endpoint: "https://termix.example.test/plugin-api/coolify/mcp",
          };
        }
        return {};
      },
    });
    expect(refused).toEqual([]);
    expect(errors).toEqual([]);
    expect(rendered.length).toBeGreaterThan(0);
  });
});
