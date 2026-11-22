import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditLogExits,
  functionsOf,
  parseLogExits,
  type LogExit,
} from "./helpers/log-exits.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Every backend function that touches log or command text (helpers/log-exits.ts
 * lists where such text enters), and what it does with it, in
 * tests/backend/log-exits.json (`path#function` to `{ kind, what, into?,
 * from?, issue? }`). A function that returns it to a caller is an exit and
 * must call redactLog, or a helper that runs every line through it
 * (redactLogFields, keyBlockCarry, lineSplitter, redactLogStream, buildLog),
 * with the connection snapshot's own secrets. A new place that reads log
 * text fails the audit until it is listed there. parseLogExits checks every
 * entry's shape as it loads.
 */
const LOG_EXITS = parseLogExits(
  JSON.parse(readFileSync(join(root, "tests/backend/log-exits.json"), "utf8")),
);

function backendFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return backendFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Every backend source but the Coolify client, which only fetches. */
function sources(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of backendFiles(join(root, "src/backend"))) {
    const rel = relative(root, path).split("\\").join("/");
    if (rel.startsWith("src/backend/coolify/")) continue;
    files[rel] = readFileSync(path, "utf8");
  }
  return files;
}

const ADAPTERS = "src/backend/companions/adapters.ts";
const SERVICE = "src/backend/companions/service.ts";

describe("log exits", () => {
  it("every backend function that returns log text redacts it", () => {
    expect(auditLogExits(sources(), LOG_EXITS)).toEqual([]);
  });

  it("finds every registered function in the source", () => {
    const files = sources();
    for (const key of Object.keys(LOG_EXITS)) {
      const [path, name] = key.split("#");
      expect(
        functionsOf(files[path] ?? "").some((fn) => fn.name === name),
        key,
      ).toBe(true);
    }
  });

  it("fails when an exit stops calling redactLog", () => {
    const files = sources();
    files[ADAPTERS] = files[ADAPTERS].replaceAll("redactLog(", "noop(");
    expect(auditLogExits(files, LOG_EXITS)).toEqual([
      `${ADAPTERS}#logSearch (Log Search hits) skips redactLog`,
    ]);
  });

  it("fails on a nested helper inside a registered exit that returns command output", () => {
    const files = sources();
    const updates = "src/backend/updates/service.ts";
    const anchor =
      "      target.signal = signal;\n      // The upgrade's output is command output";
    expect(files[updates]).toContain(anchor);
    files[updates] = files[updates].replace(
      anchor,
      [
        "      const leak = async () => {",
        '        const raw = await exec(target, "docker logs app", 1000);',
        "        return raw.stdout;",
        "      };",
        anchor,
      ].join("\n"),
    );
    const problems = auditLogExits(files, LOG_EXITS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^src\/backend\/updates\/service\.ts:\d+ reads log text outside any registered function: return raw\.stdout;$/,
    );
  });

  it("fails on a nested helper inside a fed function that calls the feeder", () => {
    const files = sources();
    const logs = "src/backend/containers/logs.ts";
    const anchor = "      const request = readLogsRequest(raw);\n";
    expect(files[logs]).toContain(anchor);
    files[logs] = files[logs].replace(
      anchor,
      [
        anchor.trimEnd(),
        "      const rawText = async (res: ResourceDto, snap: Snapshot) => {",
        "        return await fromCoolify(snap, res, request);",
        "      };",
        "",
      ].join("\n"),
    );
    const problems = auditLogExits(files, LOG_EXITS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^src\/backend\/containers\/logs\.ts:\d+ calls fromCoolify, whose raw text only snapshot may take$/,
    );
  });

  it("fails on a planted function that returns command output", () => {
    const files = sources();
    files[SERVICE] +=
      [
        "",
        "export async function planted(run: Run) {",
        '  const result = await run("docker logs app");',
        "  return { text: result.stdout };",
        "}",
      ].join("\n") + "\n";
    const problems = auditLogExits(files, LOG_EXITS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^src\/backend\/companions\/service\.ts:\d+ reads log text outside any registered function: return \{ text: result\.stdout \};$/,
    );
  });

  it("fails on a planted Coolify log read and a stray caller of a feeder", () => {
    const files = sources();
    const logs = "src/backend/containers/logs.ts";
    files[logs] = files[logs].replace(
      "  return {\n    /**\n     * A route query",
      [
        "  async function raw(snap: Snapshot, res: ResourceDto) {",
        "    const direct = await snap.api.logs(res.kind, res.uuid, { lines: 1 });",
        "    return direct + (await fromCoolify(snap, res, readLogsRequest({})));",
        "  }",
        "",
        "  return {\n    /**\n     * A route query",
      ].join("\n"),
    );
    const problems = auditLogExits(files, LOG_EXITS);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/reads log text outside any registered/);
    expect(problems[1]).toMatch(
      /calls fromCoolify, whose raw text only snapshot may take/,
    );
  });

  it("fails when the generic API's log fields skip redactLog", () => {
    const files = sources();
    const generic = "src/backend/ops/api-generic.ts";
    files[generic] = files[generic].replaceAll("redactLogFields(", "noop(");
    expect(auditLogExits(files, LOG_EXITS)).toEqual([
      `${generic}#dispatch (generic API log fields (redactLogFields)) skips redactLog`,
    ]);
  });

  it("has no pending exit left, and fails once a pending one is fixed", () => {
    expect(
      Object.entries(LOG_EXITS).filter(([, e]) => e.kind === "pending"),
    ).toEqual([]);
    const files = sources();
    const pending: LogExit = { kind: "pending", issue: "#0", what: "gap" };
    expect(
      auditLogExits(files, {
        ...LOG_EXITS,
        [`${ADAPTERS}#logSearch`]: pending,
      }),
    ).toEqual([
      `${ADAPTERS}#logSearch (gap) now calls a redactor: make it an exit (#0)`,
    ]);
    // A reference without a call is not a redactor.
    files[ADAPTERS] = files[ADAPTERS].replaceAll(
      "redactLog(",
      "noop(",
    ).replaceAll("keyBlockCarry(", "noop(");
    expect(
      auditLogExits(files, {
        ...LOG_EXITS,
        [`${ADAPTERS}#logSearch`]: pending,
      }),
    ).toEqual([]);
  });

  it("fails on a registered function that no longer exists", () => {
    expect(
      auditLogExits(sources(), {
        ...LOG_EXITS,
        "src/backend/containers/logs.ts#gone": { kind: "exit", what: "gone" },
      }),
    ).toEqual([
      "src/backend/containers/logs.ts#gone is registered but not found",
    ]);
  });

  it("refuses a registry entry whose shape is wrong", () => {
    const key = "src/backend/containers/logs.ts#snapshot";
    const bad: [unknown, string][] = [
      [{ kind: "exti", what: "x" }, `${key}: unknown kind "exti"`],
      [{ kind: "exit" }, `${key}: what must be text`],
      [{ kind: "feeds", what: "x" }, `${key}: feeds needs into as list`],
      [{ kind: "feeds", what: "x", into: "snapshot" }, "feeds needs into"],
      [{ kind: "relays", what: "x", from: [] }, "relays needs from as list"],
      [{ kind: "pending", what: "x" }, "pending needs issue as text"],
      [{ kind: "exit", what: "x", inot: ["a"] }, "exit takes no inot"],
    ];
    for (const [entry, message] of bad) {
      expect(() => parseLogExits({ ...LOG_EXITS, [key]: entry })).toThrow(
        message,
      );
    }
    expect(() => parseLogExits({ "logs.ts#x": LOG_EXITS[key] })).toThrow(
      "key must be <path>#<function>",
    );
    expect(() => parseLogExits([])).toThrow("expected an object");
  });
});
