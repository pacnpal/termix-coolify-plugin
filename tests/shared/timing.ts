import { vi } from "vitest";

/**
 * Waits and timeouts for tests whose work is fixed (#105).
 *
 * Every wait in these suites is for work against fakes that always ends: a
 * render, a mocked answer, a step of a fake host. The defaults (Testing
 * Library's 1 s for findBy and waitFor, vi.waitFor's 1 s, Vitest's 5 s per
 * test) are wall-clock budgets, and a busy machine stretches fixed work past
 * them with nothing wrong. A wait that passes returns as soon as its check
 * does, so a wider margin costs nothing when the work is done.
 */

/**
 * How long a findBy, waitFor or vi.waitFor waits. Under Vitest's 5 s test
 * timeout, so a wait that really misses still fails with its own message.
 */
export const WAIT_MS = 4_000;

/**
 * The timeout for a test whose fixed work takes a good part of a second or
 * more on an idle machine (heavy setup repeated, or a real timer the code
 * under test waits on): a busy machine stretches it past 5 s.
 */
export const HEAVY_TEST_MS = 60_000;

/** vi.waitFor with WAIT_MS instead of its 1 s default. */
export function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: WAIT_MS });
}
