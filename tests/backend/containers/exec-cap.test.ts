import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import type { PluginHarness } from "../helpers/plugin.js";
import { fakeDocker, startShell } from "./fixtures.js";
import * as redaction from "../../../src/backend/redact.js";
import {
  EXEC_MAX_OUTPUT,
  EXEC_RAW_CAP,
} from "../../../src/backend/containers/service.js";

// Every call the exec path makes to the text redactor, to see what it is given.
vi.mock("../../../src/backend/redact.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../../src/backend/redact.js")>();
  return { ...real, redactText: vi.fn(real.redactText) };
});

let harness: PluginHarness | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(redaction.redactText).mockClear();
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
  fakeDocker(h, {
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
  return outcome.data as { stdout: string; stderr: string; truncated: boolean };
}

describe("exec output cap", () => {
  it("exec caps raw output before redacting", async () => {
    expect(EXEC_RAW_CAP).toBeGreaterThanOrEqual(EXEC_MAX_OUTPUT);
    expect(EXEC_RAW_CAP).toBeLessThanOrEqual(2 * EXEC_MAX_OUTPUT);
    const five = 5 * 1024 * 1024;
    const data = await execWith("x".repeat(five), "e".repeat(five));
    const calls = vi.mocked(redaction.redactText).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [text] of calls) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(EXEC_RAW_CAP);
    }
    expect(
      Buffer.byteLength(data.stdout) + Buffer.byteLength(data.stderr),
    ).toBeLessThanOrEqual(EXEC_MAX_OUTPUT);
    expect(data.truncated).toBe(true);
  });

  it("a secret straddling the cap is still masked", async () => {
    // A name=value line whose value runs past the raw cap.
    const pad = "a".repeat(EXEC_RAW_CAP - 40) + "\n";
    const line = `POSTGRES_PASSWORD=${"fake-straddle-secret-".repeat(10)}`;
    // A private key block whose END lies past the raw cap.
    const keyBody = "fake-straddle-key-body\n".repeat(10);
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${keyBody}-----END OPENSSH PRIVATE KEY-----\n`;
    const stderrPad = "c".repeat(EXEC_RAW_CAP - 100) + "\n";
    const data = await execWith(pad + line, stderrPad + pem);
    expect(JSON.stringify(data)).not.toContain("fake-straddle");

    // What the redactor was given was capped, and what it gave back (the text
    // the 64 KB cut works on) holds neither secret.
    const { calls, results } = vi.mocked(redaction.redactText).mock;
    expect(calls).toHaveLength(2);
    for (const [input] of calls) {
      expect(Buffer.byteLength(input)).toBeLessThanOrEqual(EXEC_RAW_CAP);
    }
    const [out, err] = results.map((r) => String(r.value));
    expect(out).toContain(`POSTGRES_PASSWORD=${REDACTED_VALUE}`);
    expect(err).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    for (const text of [out, err]) {
      expect(text).not.toContain("fake-straddle");
    }
  });
});
