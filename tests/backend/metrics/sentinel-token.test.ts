import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  containerHistoryPath,
  sentinelCommand,
  sentinelGet,
} from "../../../src/backend/metrics/sentinel.js";
import type { SshRunner } from "../../../src/backend/ssh.js";

const TOKEN = "fake-sentinel-token-in-container";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * A real /bin/sh with stand-ins on PATH: `docker exec` runs the rest with the
 * container's TOKEN set, as the Sentinel container has it, and `curl` writes
 * its argv and stdin to files and answers with whatever Sentinel would.
 */
function fakeHost(answer: string) {
  dir = mkdtempSync(join(tmpdir(), "sentinel-token-"));
  const docker = join(dir, "docker");
  const curl = join(dir, "curl");
  writeFileSync(
    docker,
    `#!/bin/sh\n[ "$1" = exec ] && [ "$2" = coolify-sentinel ] || exit 9\nshift 2\nTOKEN='${TOKEN}' exec "$@"\n`,
  );
  writeFileSync(
    curl,
    `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > "$ARGV_FILE"\ncat > "$STDIN_FILE"\nprintf '%s' '${answer}'\n`,
  );
  chmodSync(docker, 0o755);
  chmodSync(curl, 0o755);
  const files = { argv: join(dir, "argv"), stdin: join(dir, "stdin") };
  const run: SshRunner = async (_hostId, command) => {
    const stdout = execFileSync("/bin/sh", ["-c", command], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        ARGV_FILE: files.argv,
        STDIN_FILE: files.stdin,
      },
      encoding: "utf8",
    });
    return { stdout, stderr: "", code: 0, truncated: false, timedOut: false };
  };
  return { run, files };
}

const WINDOW = {
  from: new Date("2026-11-19T10:00:00.000Z"),
  to: new Date("2026-11-19T11:00:00.000Z"),
  bucketMs: 60_000,
};

describe("Sentinel's token", () => {
  it("goes to curl on stdin only: never in the command, curl's argv or the answer", async () => {
    const path = containerHistoryPath("app-web-uuid", "cpu", WINDOW);
    const command = sentinelCommand(path, { sudo: false });
    expect(command).not.toContain(TOKEN);

    const host = fakeHost(`[{"time":"1763546400000","percent":5}]`);
    const answer = await sentinelGet<unknown>(host.run, 1, path);
    expect(answer).toEqual([{ time: "1763546400000", percent: 5 }]);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);

    const argv = readFileSync(host.files.argv, "utf8");
    expect(argv).not.toContain(TOKEN);
    expect(argv).toContain(`http://localhost:8888${path}`);
    expect(readFileSync(host.files.stdin, "utf8")).toBe(
      `Authorization: Bearer ${TOKEN}\n`,
    );
  });

  it("an answer that echoes it is masked anyway", async () => {
    const host = fakeHost(`{"requests":1,"token":"${TOKEN}"}`);
    const answer = await sentinelGet<unknown>(host.run, 1, "/api/summary");
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });
});
