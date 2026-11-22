import { describe, expect, it } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { storagePaths } from "../../src/backend/companions/container-adapters.js";
import { hostnamesOf } from "../../src/backend/companions/service.js";
import type { StorageDto } from "../../src/backend/coolify/dto.js";
import { isTaskRunPath } from "../../src/backend/ops/api-generic.js";
import { baseUrlOf } from "../../src/backend/status/base-url.js";

// Each place that once used a regex that backtracks polynomially (Sonar
// S8786) answers a long hostile input within a small bound, and still
// answers the ordinary cases as before.
const BOUND_MS = 100;

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

function ctxAnswering(base: string): PluginContext {
  return { http: { baseUrl: () => base } } as unknown as PluginContext;
}

describe("baseUrlOf", () => {
  it("drops trailing slashes and refuses what isn't an http(s) address", () => {
    const cases: [string, string | null][] = [
      ["https://termix.example.test", "https://termix.example.test"],
      ["https://termix.example.test/", "https://termix.example.test"],
      ["https://termix.example.test///", "https://termix.example.test"],
      ["http://termix.example.test/sub//", "http://termix.example.test/sub"],
      ["https://termix.example.test/a//b/", "https://termix.example.test/a//b"],
      ["ftp://termix.example.test", null],
      ["https://user@termix.example.test", null],
      ["https://termix.example.test/a b", null],
      ["https://termix.example.test/?q=1", null],
      ["https:///", null],
    ];
    for (const [base, expected] of cases) {
      expect(baseUrlOf(ctxAnswering(base), {}), base).toBe(expected);
    }
  });

  it("stays linear on a long run of slashes that isn't at the end", () => {
    const base = `https://termix.example.test/${"/".repeat(50_000)}a`;
    const { value, ms } = timed(() => baseUrlOf(ctxAnswering(base), {}));
    expect(value).toBe(base);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("hostnamesOf", () => {
  it("reads the host of each domain, with or without a path", () => {
    expect(
      hostnamesOf([
        "https://App.Example.test/",
        "http://api.example.test//v1///",
        "plain.example.test",
        "",
        "not a url",
      ]),
    ).toEqual(
      new Set(["app.example.test", "api.example.test", "plain.example.test"]),
    );
  });

  it("stays linear on a path with a long run of slashes", () => {
    const fqdn = `https://app.example.test/${"/".repeat(50_000)}a`;
    const { value, ms } = timed(() => hostnamesOf([fqdn]));
    expect(value).toEqual(new Set(["app.example.test"]));
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("storagePaths", () => {
  const volume = (hostPath: string | null): StorageDto => ({
    kind: "volume",
    name: null,
    mountPath: "/data",
    hostPath,
  });

  it("normalizes host paths and drops trailing slashes", () => {
    expect(
      storagePaths(
        [
          volume("/srv/app/"),
          volume("/srv//data///"),
          volume("/"),
          volume("///"),
          volume("relative/path"),
          volume("/srv/../etc"),
        ],
        "/data/coolify/applications/x",
      ),
    ).toEqual(["/srv/app", "/srv/data"]);
  });

  it("stays linear on the longest path it takes", () => {
    const hostPath = `/srv${"/".repeat(4_000)}a`;
    const { value, ms } = timed(() =>
      storagePaths([volume(hostPath)], "/data/coolify/applications/x"),
    );
    expect(value).toEqual(["/srv/a"]);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("isTaskRunPath", () => {
  it("matches a scheduled task's execute path, as the old pattern did", () => {
    const cases: [string, boolean][] = [
      ["/applications/{uuid}/scheduled-tasks/{task_uuid}/execute", true],
      ["/services/{uuid}/scheduled-tasks/{task_uuid}/execute", true],
      ["/scheduled-tasks/{x}/execute", true],
      ["/scheduled-tasks/{a{b}/execute", true],
      ["/scheduled-tasks/{/scheduled-tasks/{x}/execute", true],
      ["x/scheduled-tasks/{}/scheduled-tasks/{y}/execute", true],
      ["/scheduled-tasks/{}/execute", false],
      ["/scheduled-tasks/{a}b}/execute", false],
      ["/scheduled-tasks/{x}/execute/", false],
      ["/scheduled-tasks/{x}/executes", false],
      ["/scheduled-tasks/x}/execute", false],
      ["/scheduled-tasks/{x/execute", false],
      ["/applications/{uuid}/scheduled-tasks", false],
      ["/applications/{uuid}/scheduled-tasks/{task_uuid}", false],
      ["}/execute", false],
      ["{x}/execute", false],
      ["", false],
    ];
    for (const [path, expected] of cases) {
      expect(isTaskRunPath(path), path).toBe(expected);
    }
  });

  it("stays linear on a long run of unclosed task segments", () => {
    const path = `${"/scheduled-tasks/{".repeat(20_000)}/execute`;
    const { value, ms } = timed(() => isTaskRunPath(path));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});
