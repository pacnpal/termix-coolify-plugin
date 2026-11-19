import { describe, expect, it } from "vitest";
import { checkFrameViews } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";
import locales from "../../locales/en.json";
import { connectionFixture } from "./helpers";

const connection = connectionFixture({ teamName: "Ops" });

// A Linked host, so the host section renders too.
const linkedHost = {
  id: 7,
  userId: "user-1",
  name: "web-1",
  ip: "203.0.113.11",
  port: 22,
  username: "root",
  authType: "credential",
  folder: "Coolify",
  tags: "coolify",
  pluginSettings: {
    coolify: {
      coolifyLinked: true,
      coolifyConnectionId: "1",
      coolifyServerUuid: "srv-web1",
    },
  },
};

describe("sandboxed frame views", () => {
  it("asks core only for what a frame may reach", async () => {
    const { refused, errors, rendered } = await checkFrameViews(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
      locales,
      permissions: ["coolify.view", "coolify.configure"],
      hosts: [linkedHost],
      respond: (method, path) => {
        if (method !== "GET") return {};
        if (/\/connections$/.test(path)) return [connection];
        if (/\/connections\/1\/servers$/.test(path)) return [];
        if (/\/connections\/1$/.test(path)) return connection;
        return {};
      },
    });
    expect(refused).toEqual([]);
    expect(errors).toEqual([]);
    expect(rendered.map(String).join(" ")).toContain("hostSection:coolify");
    expect(rendered.length).toBeGreaterThan(0);
  });
});
