import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHarness } from "../helpers/plugin.js";
import { fakeDocker, startShell } from "./fixtures.js";
import {
  EXEC_MAX_OUTPUT,
  EXEC_RAW_CAP,
} from "../../../src/backend/containers/exec.js";

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
});

async function execWith(stdout: string, stderr = "") {
  const started = await startShell({ settings: { allowExec: true } });
  harness = started.harness;
  const h = started.harness;
  h.db.sqlite
    .prepare("UPDATE p_coolify_connections SET exec_enabled = 1 WHERE id = ?")
    .run(started.connectionId);
  const docker = fakeDocker(h, {
    ps: [[/applicationUuid=app-web-uuid/, "web-abc|running||\n"]],
    exec: () => ({
      stdout,
      stderr,
      code: 0,
      truncated: false,
      timedOut: false,
    }),
  });
  const outcome = await h.mock.ctx.operations.run("coolify.exec", {
    input: {
      connectionId: String(started.connectionId),
      uuid: "app-web-uuid",
      command: "cat big",
    },
  });
  const data = outcome.data as {
    stdout: string;
    stderr: string;
    truncated: boolean;
    exitCode: number | null;
  };
  return { data, docker };
}

describe("exec output cap", () => {
  it("exec caps raw output and kills the command", async () => {
    expect(EXEC_RAW_CAP).toBeGreaterThanOrEqual(EXEC_MAX_OUTPUT);
    expect(EXEC_RAW_CAP).toBeLessThanOrEqual(2 * EXEC_MAX_OUTPUT);
    const five = 5 * 1024 * 1024;
    const { data, docker } = await execWith("x".repeat(five), "e".repeat(five));
    expect(
      Buffer.byteLength(data.stdout) + Buffer.byteLength(data.stderr),
    ).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(data.truncated).toBe(true);
    expect(data.exitCode).toBeNull();
    expect(docker.channels[0].signals).toContain("KILL");
    expect(docker.dispose).toHaveBeenCalled();
  });

  it("a secret straddling the cap is still masked", async () => {
    // A name=value line whose value runs past the output cap.
    const pad = "a".repeat(EXEC_MAX_OUTPUT - 40) + "\n";
    const line = `POSTGRES_PASSWORD=${"fake-straddle-secret-".repeat(10)}`;
    // A private key block whose END lies past the cap.
    const keyBody = "fake-straddle-key-body\n".repeat(10);
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${keyBody}-----END OPENSSH PRIVATE KEY-----\n`;
    const { data } = await execWith(pad + line, pem);
    expect(JSON.stringify(data)).not.toContain("fake-straddle");
    expect(data.truncated).toBe(true);
  });

  it("a key block cut by the end of the output stays masked", async () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"fake-cut-key-body\n".repeat(5)}`;
    const { data } = await execWith("ok\n", pem);
    expect(data.stderr).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(data.stderr).not.toContain("fake-cut-key-body");
  });
});
