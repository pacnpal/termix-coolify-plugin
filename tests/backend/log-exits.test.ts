import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditLogExits,
  functionsOf,
  type LogExit,
} from "./helpers/log-exits.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Every backend function that touches log or command text (helpers/log-exits.ts
 * lists where such text enters), and what it does with it. A function that
 * returns it to a caller is an exit and must call redactLog, or a helper
 * that runs every line through it (keyBlockCarry, lineSplitter,
 * redactLogStream, buildLog), with the connection snapshot's own secrets.
 * A new place that reads log text fails the audit until it is listed here.
 */
const LOG_EXITS: Record<string, LogExit> = {
  // Container logs (route, coolify.logs-tail, coolify.client, MCP).
  "src/backend/containers/logs.ts#snapshot": {
    kind: "exit",
    what: "container logs snapshot through Coolify",
  },
  "src/backend/containers/logs.ts#fromCoolify": {
    kind: "feeds",
    into: ["snapshot"],
    what: "Coolify's container logs, raw",
  },
  "src/backend/containers/logs.ts#fromSsh": {
    kind: "exit",
    what: "container logs snapshot over SSH",
  },
  "src/backend/containers/logs.ts#follow": {
    kind: "exit",
    what: "followed container logs (WS /logs)",
  },
  // Deployments.
  "src/backend/deployments/service.ts#read": {
    kind: "feeds",
    into: ["get", "cancel"],
    what: "a deployment with its raw build log",
  },
  "src/backend/deployments/service.ts#get": {
    kind: "exit",
    what: "a deployment's build log",
  },
  "src/backend/deployments/service.ts#cancel": {
    kind: "discards",
    what: "cancel reads the deployment, not its log",
  },
  // Pull request previews.
  "src/backend/previews/service.ts#logs": {
    kind: "exit",
    what: "preview logs",
  },
  // Exec.
  "src/backend/containers/exec.ts#exec": {
    kind: "exit",
    what: "exec stdout and stderr",
  },
  // The generic API.
  "src/backend/ops/api-generic.ts#logFieldsOf": {
    kind: "feeds",
    into: ["dispatch", "reveal"],
    what: "an operation's log and output field names",
  },
  "src/backend/ops/api-generic.ts#dispatch": {
    kind: "pending",
    issue: "#81 (PR #103) puts log fields through redactLog",
    what: "generic API log fields",
  },
  "src/backend/ops/api-generic.ts#reveal": {
    kind: "unredacted",
    what: "reveal: the audited way to read one masked value as it is",
  },
  // Log Search.
  "src/backend/companions/adapters.ts#logSearch": {
    kind: "exit",
    what: "Log Search hits",
  },
  // Server updates.
  "src/backend/updates/service.ts#install": {
    kind: "exit",
    what: "the upgrade's output",
  },
  "src/backend/updates/service.ts#platform": {
    kind: "parses",
    what: "the platform probe's package manager",
  },
  "src/backend/updates/service.ts#runCheck": {
    kind: "parses",
    what: "the update check's package list",
  },
  "src/backend/updates/service.ts#reboot": {
    kind: "parses",
    what: "only whether sudo refused",
  },
  // Operations that pass on an exit's answer.
  "src/backend/ops/containers.ts#registerContainerOperations": {
    kind: "relays",
    from: ["src/backend/containers/exec.ts#exec"],
    what: "coolify.exec's handoff of exec's redacted output",
  },
  // Command output read only for values.
  "src/backend/connections/probe.ts#runProbe": {
    kind: "discards",
    what: "one log line, read only to prove the token's ability",
  },
  "src/backend/companions/container-service.ts#containerIp": {
    kind: "parses",
    what: "docker inspect's container IP",
  },
  "src/backend/containers/resolver.ts#resolveContainers": {
    kind: "parses",
    what: "docker ps container names",
  },
  "src/backend/containers/service.ts#needsSudo": {
    kind: "parses",
    what: "the login's uid and groups",
  },
  "src/backend/containers/service.ts#hasBash": {
    kind: "parses",
    what: "whether bash exists",
  },
  "src/backend/containers/stats.ts#tick": {
    kind: "parses",
    what: "docker stats numbers",
  },
  "src/backend/metrics/sentinel.ts#dockerNeedsSudo": {
    kind: "parses",
    what: "the login's uid and groups",
  },
  "src/backend/metrics/sentinel.ts#sentinelGet": {
    kind: "parses",
    what: "Sentinel's JSON, scrubbed",
  },
};

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

  it("fails once a pending exit is fixed, so it becomes a checked exit", () => {
    const files = sources();
    const generic = "src/backend/ops/api-generic.ts";
    files[generic] = files[generic].replace(
      "    async dispatch(\n",
      "    async dispatch(\n      _redacted = redactLog,\n",
    );
    // A reference without a call is not a redactor; a call is.
    expect(auditLogExits(files, LOG_EXITS)).toEqual([]);
    files[generic] = files[generic].replace(
      "_redacted = redactLog,",
      '_redacted = redactLog("", []),',
    );
    expect(auditLogExits(files, LOG_EXITS)).toEqual([
      "src/backend/ops/api-generic.ts#dispatch (generic API log fields) now calls a redactor: make it an exit (#81 (PR #103) puts log fields through redactLog)",
    ]);
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
});
