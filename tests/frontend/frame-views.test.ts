import { describe, expect, it } from "vitest";
import { checkFrameViews } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";
import locales from "../../locales/en.json";
import { resourceAnswer, resourceRows } from "./fixtures";
import { connectionFixture } from "./helpers";

const connection = connectionFixture({ teamName: "Ops" });

// What the sidebar panel reads: one connection with a degraded resource.
const attention = {
  connections: [
    {
      id: 1,
      name: "Prod",
      access: "owner",
      scoped: false,
      running: [],
      failed: [],
      degraded: [
        {
          uuid: "app-api-uuid",
          name: "api",
          kind: "application",
          status: "running:unhealthy",
          serverName: "edge",
          projectName: "Shop",
          environmentName: "production",
        },
      ],
      unreachable: [],
      error: null,
    },
  ],
  counts: { running: 0, failed: 0, degraded: 1, unreachable: 0 },
  badge: 0,
  fetchedAt: "2026-11-22T10:00:00.000Z",
};

const allCompanions = Object.fromEntries(
  [
    "docker",
    "sshTerminal",
    "files",
    "tunnels",
    "reverseProxy",
    "dns",
    "uptime",
    "logSearch",
    "packageManager",
    "securityCenter",
    "hostMetrics",
    "databases",
    "backups",
  ].map((key) => [key, true]),
);

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
      permissions: ["coolify.view", "coolify.configure", "coolify.mcp"],
      hosts: [linkedHost],
      respond: (method, path) => {
        if (method !== "GET") return {};
        // Every companion runs, so the host card asks for their parts too.
        if (/\/companions$/.test(path)) return allCompanions;
        if (/\/connections$/.test(path)) return [connection];
        if (/\/connections\/1\/servers$/.test(path)) return [];
        if (/\/resources(\?|$)/.test(path)) return resourceAnswer;
        if (/\/resources\/[^/]+$/.test(path)) return resourceRows[0];
        if (/\/mcp$/.test(path)) {
          return {
            endpoint: "https://termix.example.test/plugin-api/coolify/mcp",
          };
        }
        if (/\/connections\/1$/.test(path)) return connection;
        if (/\/attention(\?|$)/.test(path)) return attention;
        return {};
      },
    });
    expect(refused).toEqual([]);
    expect(errors).toEqual([]);
    expect(rendered.map(String).join(" ")).toContain("hostSection:coolify");
    expect(rendered.map(String)).toContain("panel:coolify-activity");
    expect(rendered.length).toBeGreaterThan(0);
  });
});
