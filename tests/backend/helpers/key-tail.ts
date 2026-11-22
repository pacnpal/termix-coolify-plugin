import { expect } from "vitest";

/** What every key body line holds: it must never leave the plugin. */
const BODY_MARK = "fake-key-tail-body";

/**
 * A log read from its tail (docker logs --tail, Coolify's ?lines=, a follow
 * that starts at now), cut inside a private key: its body and END arrive with
 * no BEGIN before them, then an ordinary line.
 */
export const KEY_TAIL = {
  /** The key's body lines, before its END. */
  body: [`${BODY_MARK}-one`, `${BODY_MARK}-two`],
  end: "-----END OPENSSH PRIVATE KEY-----",
  /** The line after the END, which stays as it is. */
  after: "after the key",
  /** Every line in order: body, END, after. */
  get lines(): string[] {
    return [...this.body, this.end, this.after];
  },
  /** The lines as log text, ending with a newline. */
  get text(): string {
    return `${this.lines.join("\n")}\n`;
  },
};

/** `text` (or any answer, as JSON) shows no key body and keeps the line after the END. */
export function expectKeyTailMasked(answer: unknown, label?: string): void {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  expect(text, label).not.toContain(BODY_MARK);
  expect(text, label).toContain(KEY_TAIL.after);
}
