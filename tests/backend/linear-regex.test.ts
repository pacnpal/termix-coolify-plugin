import { describe, expect, it } from "vitest";
import { growth, LINEAR_GROWTH, linearLimit } from "../shared/linear-cost.js";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { storagePaths } from "../../src/backend/companions/container-adapters.js";
import { hostnamesOf } from "../../src/backend/companions/service.js";
import type { StorageDto } from "../../src/backend/coolify/dto.js";
import { isTaskRunPath } from "../../src/backend/ops/api-generic.js";
import { baseUrlOf } from "../../src/backend/status/base-url.js";
import { HEAVY_TEST_MS } from "../shared/timing.js";

// Each place that once used a regex that backtracks polynomially (Sonar
// S8786) answers a long hostile input in linear time, and still answers the
// ordinary cases as before. Linear by growth, not by milliseconds, so a busy
// machine can't fail it (#105): `scaled(scale)` is the call at that share of
// the full hostile input.
function grows<T>(
  scaled: (scale: number) => () => T,
  factor?: number,
): {
  value: T;
  grew: number;
} {
  return { value: scaled(1)(), grew: growth(scaled, factor) };
}

// storagePaths refuses a path over 4096 characters, so its input can't grow.
// At that size a quadratic trim costs only a few times the linear work, so
// it is compared against a 32nd of the path, not an 8th, where the quadratic
// part has all but vanished: a planted one then clears the bound by about 2x.
const STORAGE_FACTOR = 32;

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

  // Fixed work: growth() samples both sizes for a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on a long run of slashes that isn't at the end",
    () => {
      const hostile = (scale: number) =>
        `https://termix.example.test/${"/".repeat(50_000 * scale)}a`;
      const { value, grew } = grows((scale) => {
        const ctx = ctxAnswering(hostile(scale));
        return () => baseUrlOf(ctx, {});
      });
      expect(value).toBe(hostile(1));
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
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

  // Fixed work: growth() samples both sizes for a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on a path with a long run of slashes",
    () => {
      const { value, grew } = grows((scale) => {
        const fqdn = `https://app.example.test/${"/".repeat(50_000 * scale)}a`;
        return () => hostnamesOf([fqdn]);
      });
      expect(value).toEqual(new Set(["app.example.test"]));
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
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

  // Fixed work: growth() samples both sizes for a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on the longest path it takes",
    () => {
      const { value, grew } = grows((scale) => {
        const hostPath = `/srv${"/".repeat(4_088 * scale)}a`;
        return () =>
          storagePaths([volume(hostPath)], "/data/coolify/applications/x");
      }, STORAGE_FACTOR);
      expect(value).toEqual(["/srv/a"]);
      expect(grew).toBeLessThan(linearLimit(STORAGE_FACTOR));
    },
    HEAVY_TEST_MS,
  );
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

  // Fixed work: growth() samples both sizes for a few tenths
  // of a second of CPU; an explicit timeout keeps a busy machine from failing
  // it on Vitest's 5 s (#105).
  it(
    "stays linear on a long run of unclosed task segments",
    () => {
      const { value, grew } = grows((scale) => {
        const path = `${"/scheduled-tasks/{".repeat(20_000 * scale)}/execute`;
        return () => isTaskRunPath(path);
      });
      expect(value).toBe(false);
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
});
