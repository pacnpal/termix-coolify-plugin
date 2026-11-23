/**
 * Linear-time checks that a busy machine can't fail (#105).
 *
 * A budget in milliseconds is a wall-clock budget: load stretches the work and
 * fails the check with nothing wrong. Here a check compares the work with
 * itself instead: the same call on an input SIZE_FACTOR times as long. Linear
 * work grows about SIZE_FACTOR times, quadratic work SIZE_FACTOR² times,
 * whatever the machine's speed or load. Both sizes are timed back to back on
 * the same thread, by the thread's own CPU time where Node has it (time spent
 * waiting for a CPU isn't counted), and each takes the best of a few tries.
 *
 * A long pause on the thread (a major GC, a deopt) is counted as the thread's
 * CPU time, so one sample never decides a check (#124): each try takes the
 * median of a few sub-samples per size, and a check fails only after every
 * try. Only a pass ends it early.
 */

/** How many times as long the full input is as the small one. */
export const SIZE_FACTOR = 8;

/**
 * Linear work grows about 8 times (a little more where the bigger input
 * spills out of a cache), quadratic work about 64 times. Measured when this
 * was set: 4 to 13 for every check here, 55 to 480 with a quadratic version
 * of each function planted. LINEAR_COST_LOG=1 prints each check's growth.
 */
export const LINEAR_GROWTH = linearLimit(SIZE_FACTOR);

/**
 * The bound for a check over `factor` times the input: 3 times what linear
 * work grows. A quadratic part grows factor² times, so a check whose input
 * can't be made longer (its quadratic part stays small at that size) can
 * still clear the bound by comparing against a smaller small input.
 */
export function linearLimit(factor: number): number {
  return 3 * factor;
}

const TRIES = 3;

/**
 * Calls of each size made before anything is timed. The first calls run before
 * the JIT has optimized them; timed, they read the small size (sampled first)
 * as costlier than it is, which made a quadratic call look linear on CI.
 */
export const WARM_UP_CALLS = 3;

/**
 * Sub-samples of each size in one try. Their median ignores one paused
 * sub-sample, whichever size it hits.
 */
const SUB_SAMPLES = 3;

const clock: () => number =
  typeof process?.threadCpuUsage === "function"
    ? () => {
        const { user, system } = process.threadCpuUsage();
        return user + system;
      }
    : () => performance.now() * 1_000;

/**
 * The clock's step in microseconds. A thread's CPU time can advance in
 * scheduler ticks (4 ms on some kernels), so it is measured, not assumed.
 */
function clockStep(): number {
  const edges: number[] = [];
  let last = clock();
  while (edges.length < 3) {
    const now = clock();
    if (now !== last) edges.push(now);
    last = now;
  }
  return (edges[2] - edges[0]) / 2;
}

/**
 * Sub-samples are repeated to at least this long, so one clock step is at
 * most a tenth of a sub-sample. A try takes six, about as long as the two
 * 25-step samples it took before #124.
 */
const MIN_SAMPLE_US = Math.max(1_000, 10 * clockStep());

/** Microseconds one call of `fn` costs, calling it until the sample is long enough. */
function perCall(fn: () => unknown): number {
  const started = clock();
  let calls = 0;
  let spent = 0;
  do {
    fn();
    calls += 1;
    spent = clock() - started;
  } while (spent < MIN_SAMPLE_US);
  return spent / calls;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * One try: the median cost per call of each size. The sizes take turns, so
 * anything that drifts during the try weighs on both alike.
 */
function oneTry(
  small: () => unknown,
  full: () => unknown,
): { small: number; full: number } {
  const smalls: number[] = [];
  const fulls: number[] = [];
  for (let i = 0; i < SUB_SAMPLES; i += 1) {
    smalls.push(perCall(small));
    fulls.push(perCall(full));
  }
  return { small: median(smalls), full: median(fulls) };
}

/**
 * How many times as much the work of `at(1)` costs as that of
 * `at(1 / factor)` (SIZE_FACTOR unless given). `at(scale)` builds the input at
 * that share of the test's full size and returns the call to measure. Best of
 * a few tries, each the median of a few sub-samples per size. It stops at the
 * first try within linearLimit(factor), which a linear call needs, and
 * otherwise takes every try: one paused sample can't fail a check (#124).
 *
 * Each try runs six sub-samples of at least 10 clock steps, so a check takes
 * a few tenths of a second of CPU: a test that makes one takes HEAVY_TEST_MS
 * (shared/timing.ts) rather than Vitest's 5 s.
 */
export function growth(
  at: (scale: number) => () => unknown,
  factor = SIZE_FACTOR,
): number {
  const began = clock();
  const limit = linearLimit(factor);
  const small = at(1 / factor);
  const full = at(1);
  for (let i = 0; i < WARM_UP_CALLS; i += 1) {
    small();
    full();
  }
  let smallest = Number.POSITIVE_INFINITY;
  let fullest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < TRIES; i += 1) {
    const sampled = oneTry(small, full);
    smallest = Math.min(smallest, sampled.small);
    fullest = Math.min(fullest, sampled.full);
    if (fullest / smallest < limit) break;
  }
  if (process.env.LINEAR_COST_LOG) {
    const spent = (clock() - began) / 1_000;
    console.log(
      `growth ${(fullest / smallest).toFixed(1)}, ${spent.toFixed(0)} ms CPU`,
    );
  }
  return fullest / smallest;
}
