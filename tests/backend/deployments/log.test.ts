import { describe, expect, it } from "vitest";
import {
  MAX_BUILD_LOG_LINES,
  buildLog,
  parseBuildLog,
} from "../../../src/backend/deployments/log.js";
import {
  isCancellableDeployment,
  isFinalDeployment,
} from "../../../src/shared/deployment-status.js";
import { logEntry } from "../helpers/deployments.js";

describe("build log parsing", () => {
  it("reads Coolify's JSON lines in order, keeping the hidden flag", () => {
    const raw = JSON.stringify([
      logEntry(2, "second", { type: "stderr", hidden: true, command: "ls" }),
      logEntry(1, "first"),
      { output: 7, order: "x" },
      "not an entry",
    ]);
    expect(parseBuildLog(raw)).toEqual([
      {
        order: 1,
        timestamp: "2026-11-19T10:00:01.000000Z",
        stream: "stdout",
        hidden: false,
        command: null,
        output: "first",
      },
      {
        order: 2,
        timestamp: "2026-11-19T10:00:02.000000Z",
        stream: "stderr",
        hidden: true,
        command: "ls",
        output: "second",
      },
      {
        order: 3,
        timestamp: null,
        stream: "stdout",
        hidden: false,
        command: null,
        output: "",
      },
    ]);
  });

  it("takes a log that isn't JSON as plain lines, and nothing as no lines", () => {
    expect(parseBuildLog("one\ntwo\n").map((l) => l.output)).toEqual([
      "one",
      "two",
    ]);
    expect(parseBuildLog("")).toEqual([]);
    expect(parseBuildLog(null)).toEqual([]);
    expect(parseBuildLog(JSON.stringify({ not: "a list" }))).toEqual([
      expect.objectContaining({ output: '{"not":"a list"}' }),
    ]);
  });

  it("masks secrets in output and commands, and keeps the last lines", () => {
    const entries = [
      logEntry(1, "token fake-conn-token here", {
        command: "curl -H 'Authorization: Bearer fake-header-value-123'",
      }),
      logEntry(2, "DB_PASSWORD=fake-build-pass"),
    ];
    const log = buildLog(JSON.stringify(entries), ["fake-conn-token"]);
    const text = JSON.stringify(log);
    expect(text).not.toContain("fake-conn-token");
    expect(text).not.toContain("fake-build-pass");
    expect(text).not.toContain("fake-header-value-123");
    expect(log.truncated).toBe(false);

    const many = Array.from({ length: MAX_BUILD_LOG_LINES + 5 }, (_, i) =>
      logEntry(i + 1, `line ${i + 1}`),
    );
    const cut = buildLog(JSON.stringify(many), []);
    expect(cut.truncated).toBe(true);
    expect(cut.lines).toHaveLength(MAX_BUILD_LOG_LINES);
    expect(cut.lines[0].output).toBe("line 6");
  });
});

describe("deployment statuses", () => {
  it("knows which end a deployment and which can still be cancelled", () => {
    for (const s of ["finished", "failed", "cancelled-by-user", "skipped"]) {
      expect(isFinalDeployment(s), s).toBe(true);
      expect(isCancellableDeployment(s), s).toBe(false);
    }
    for (const s of ["queued", "in_progress"]) {
      expect(isFinalDeployment(s), s).toBe(false);
      expect(isCancellableDeployment(s), s).toBe(true);
    }
  });
});
