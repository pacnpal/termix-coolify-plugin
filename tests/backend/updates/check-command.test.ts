import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCommand,
  parseCheck,
} from "../../../src/backend/updates/service.js";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * Runs the real check command in sh, with fake `id`, `apt-get` and `apt`
 * on PATH: each prints what it's given and exits with the given code.
 */
function runCheck(fakes: Record<string, { out?: string; code: number }>) {
  dir = mkdtempSync(join(tmpdir(), "coolify-check-"));
  const all = { id: { out: "0", code: 0 }, ...fakes };
  for (const [name, { out = "", code }] of Object.entries(all)) {
    const file = join(dir, name);
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%b\\n' ${JSON.stringify(out)}\nexit ${code}\n`,
    );
    chmodSync(file, 0o755);
  }
  const stdout = execFileSync("sh", ["-c", checkCommand("apt")], {
    env: { PATH: `${dir}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  return parseCheck("apt", stdout, "2026-11-20T00:00:00Z");
}

const LISTED =
  "openssl/jammy-security 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.17]";

describe("the SSH check fails closed", () => {
  it("reads the listing when every step succeeds", () => {
    const status = runCheck({
      "apt-get": { code: 0 },
      apt: { out: `Listing... Done\n${LISTED}`, code: 0 },
    });
    expect(status).toMatchObject({ updates: 1, security: 1, error: null });
  });

  it("a failed refresh is check-failed, not up to date", () => {
    const status = runCheck({
      "apt-get": { code: 100 },
      apt: { out: "", code: 0 },
    });
    expect(status.error).toBe("check-failed");
  });

  it("a failed listing is check-failed, not up to date", () => {
    const status = runCheck({
      "apt-get": { code: 0 },
      apt: { out: "", code: 100 },
    });
    expect(status.error).toBe("check-failed");
  });
});
