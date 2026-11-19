import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicKeyFingerprint } from "../../../src/backend/sync/credentials.js";

// Not a real key: any base64 blob fingerprints the same way.
const blob = Buffer.from("fake-public-key-blob-for-tests").toString("base64");

describe("publicKeyFingerprint", () => {
  it("is OpenSSH's SHA256 form, with the trailing = padding trimmed", () => {
    const padded = createHash("sha256")
      .update(Buffer.from(blob, "base64"))
      .digest("base64");
    // A SHA-256 digest in base64 always ends in one "=".
    expect(padded.endsWith("=")).toBe(true);

    const fingerprint = publicKeyFingerprint(`ssh-ed25519 ${blob} fake@test`);
    expect(fingerprint).toBe(`SHA256:${padded.slice(0, -1)}`);
    expect(fingerprint?.endsWith("=")).toBe(false);
  });

  it("answers null for a line with no base64 blob", () => {
    expect(publicKeyFingerprint("ssh-ed25519")).toBeNull();
    expect(publicKeyFingerprint("ssh-ed25519 not*base64")).toBeNull();
  });
});
