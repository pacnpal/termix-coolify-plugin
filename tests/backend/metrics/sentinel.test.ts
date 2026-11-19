import { describe, expect, it } from "vitest";
import type { PluginSshExecResult } from "@termix-ssh/plugin-sdk/backend";
import {
  containerHistoryPath,
  isSentinelPath,
  SentinelError,
  sentinelCommand,
  sentinelGet,
  trafficPath,
} from "../../../src/backend/metrics/sentinel.js";
import type { SshRunner } from "../../../src/backend/ssh.js";

function result(stdout: string, code = 0): PluginSshExecResult {
  return { stdout, stderr: "", code, truncated: false, timedOut: false };
}

function runner(stdout: string, code = 0) {
  const commands: string[] = [];
  const run: SshRunner = async (_hostId, command) => {
    commands.push(command);
    return result(stdout, code);
  };
  return { run, commands };
}

const WINDOW = {
  from: new Date("2026-11-19T10:00:00.000Z"),
  to: new Date("2026-11-19T11:00:00.000Z"),
  bucketMs: 60_000,
};

/** The parts of a shell line outside single quotes. */
function unquoted(command: string): string {
  return command.replace(/'[^']*'/g, "");
}

describe("Sentinel over SSH", () => {
  it("container history path is /api/container/<uuid>/cpu/history", () => {
    expect(containerHistoryPath("k8sappweb1", "cpu", WINDOW)).toBe(
      "/api/container/k8sappweb1/cpu/history?from=2026-11-19T10:00:00Z&to=2026-11-19T11:00:00Z&bucket_ms=60000",
    );
    expect(containerHistoryPath("k8sappweb1", "memory", WINDOW)).toMatch(
      /^\/api\/container\/k8sappweb1\/memory\/history\?/,
    );
  });

  it("a uuid that isn't a safe segment never becomes a path", () => {
    for (const bad of ["../summary", "a/b", "a-b", "a b", "", "x;reboot"]) {
      expect(() => containerHistoryPath(bad, "cpu", WINDOW)).toThrow(
        SentinelError,
      );
      expect(() =>
        trafficPath(bad, { view: "overview", range: "24h" }, WINDOW.to),
      ).toThrow(SentinelError);
    }
  });

  it("sentinel path outside the allowlist is refused", async () => {
    for (const bad of [
      "/health",
      "/api/../etc",
      "/api/x;reboot",
      "/api/x y",
      "/api/x'$(id)'",
      "/api/x`id`",
      "/api/x|id",
      "/api/x\nid",
      "http://elsewhere/api/x",
    ]) {
      expect(isSentinelPath(bad), bad).toBe(false);
      expect(() => sentinelCommand(bad, { sudo: false }), bad).toThrow(
        SentinelError,
      );
    }
    const { run, commands } = runner("{}");
    await expect(sentinelGet(run, 7, "/api/x;reboot")).rejects.toThrow(
      SentinelError,
    );
    expect(commands).toEqual([]);
    expect(isSentinelPath("/api/summary")).toBe(true);
  });

  it("a path with several query parameters reaches curl as one argument", async () => {
    const { run, commands } = runner(`[{"bucket":1,"requests":2}]`);
    const rows = await sentinelGet(
      run,
      7,
      "/api/traffic/series?from=1&to=2&dim=path",
    );
    expect(rows).toEqual([{ bucket: 1, requests: 2 }]);
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toContain(
      "'http://localhost:8888/api/traffic/series?from=1&to=2&dim=path'",
    );
    expect(unquoted(command)).not.toContain("&");
    expect(command.startsWith("docker exec coolify-sentinel ")).toBe(true);
    // Sentinel's token stays inside the container: read there, sent on stdin.
    expect(command).toContain('"$TOKEN"');
    expect(command).toContain("-H @-");
  });

  it("runs docker through sudo when the SSH user needs it", () => {
    expect(sentinelCommand("/api/summary", { sudo: true })).toMatch(
      /^sudo -n docker exec coolify-sentinel /,
    );
  });

  it("a failed curl or a Sentinel error is a SentinelError with no output in it", async () => {
    const failed = runner("curl: (7) Failed to connect", 7);
    const err = await sentinelGet(failed.run, 7, "/api/summary").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SentinelError);
    expect((err as Error).message).not.toContain("curl");
    const refused = runner(`{"error":"unauthorized"}`);
    await expect(sentinelGet(refused.run, 7, "/api/summary")).rejects.toThrow(
      SentinelError,
    );
    const notJson = runner("<html>");
    await expect(sentinelGet(notJson.run, 7, "/api/summary")).rejects.toThrow(
      SentinelError,
    );
  });

  it("builds the traffic paths from a fixed template", () => {
    const now = new Date("2026-11-19T11:00:00.000Z");
    expect(
      trafficPath("k8sappweb1", { view: "overview", range: "24h" }, now),
    ).toBe(
      "/api/resource/k8sappweb1/traffic/overview?from=2026-11-18T11:00:00Z&to=2026-11-19T11:00:00Z",
    );
    expect(
      trafficPath("k8sappweb1", { view: "series", range: "7d" }, now),
    ).toBe("/api/resource/k8sappweb1/traffic/series?range=7d");
    expect(
      trafficPath(
        "k8sappweb1",
        { view: "breakdown", dim: "country", range: "24h", limit: 20 },
        now,
      ),
    ).toBe(
      "/api/resource/k8sappweb1/traffic/breakdown/country?from=2026-11-18T11:00:00Z&to=2026-11-19T11:00:00Z&limit=20",
    );
    expect(() =>
      trafficPath(
        "k8sappweb1",
        { view: "breakdown", dim: "secrets", range: "24h" } as never,
        now,
      ),
    ).toThrow(SentinelError);
  });
});
