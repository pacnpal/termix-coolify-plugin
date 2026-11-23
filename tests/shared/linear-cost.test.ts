import { describe, expect, it } from "vitest";
import { growth, LINEAR_GROWTH, WARM_UP_CALLS } from "./linear-cost";
import { HEAVY_TEST_MS } from "./timing";

/**
 * growth() itself (#124). A long pause on the measuring thread (a major GC, a
 * deopt) counts as the thread's CPU time, so one paused sample must not decide
 * a check either way: a linear call stays under the bound and a quadratic one
 * above it.
 */

/** This thread's CPU time in microseconds, the clock growth() reads. */
function cpuNow(): number {
  const { user, system } = process.threadCpuUsage();
  return user + system;
}

/** Far longer than a whole sample of either call below. */
const PAUSE_US = 150_000;

/** Spends PAUSE_US of this thread's CPU time, as a GC pause would. */
function pause(): number {
  const until = cpuNow() + PAUSE_US;
  let spins = 0;
  while (cpuNow() < until) spins += 1;
  return spins;
}

/** `call`, pausing once, on its first timed run (after growth()'s warm-up). */
function pausingOnce(call: () => unknown): () => unknown {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === WARM_UP_CALLS + 1) pause();
    return call();
  };
}

function numbers(count: number): number[] {
  return Array.from({ length: Math.round(count) }, (_, i) => i);
}

/** One pass over the values: linear. */
function linearCall(scale: number): () => number {
  const values = numbers(100_000 * scale);
  return () => {
    let sum = 0;
    for (const value of values) sum += value;
    return sum;
  };
}

/** Every pair of values: quadratic. */
function quadraticCall(scale: number): () => number {
  const values = numbers(2_000 * scale);
  return () => {
    let mixed = 0;
    for (const a of values) {
      for (const b of values) mixed = (mixed + (a ^ b)) | 0;
    }
    return mixed;
  };
}

describe("growth (#124)", () => {
  // Fixed work: each check samples both sizes for a few tenths of a second of
  // CPU at most, plus the pause (#105).
  it(
    "reads a linear call as linear when one full-size call pauses",
    () => {
      const grew = growth((scale) =>
        scale === 1 ? pausingOnce(linearCall(scale)) : linearCall(scale),
      );
      expect(grew).toBeLessThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );

  it(
    "reads a quadratic call as quadratic when one small call pauses",
    () => {
      const grew = growth((scale) =>
        scale === 1 ? quadraticCall(scale) : pausingOnce(quadraticCall(scale)),
      );
      expect(grew).toBeGreaterThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );

  it(
    "reads a quadratic call as quadratic",
    () => {
      expect(growth(quadraticCall)).toBeGreaterThan(LINEAR_GROWTH);
    },
    HEAVY_TEST_MS,
  );
});
