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

/** Samples are repeated to at least this long, so one step is a few percent. */
const MIN_SAMPLE_US = Math.max(2_000, 25 * clockStep());

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

/**
 * How many times as much the work of `at(1)` costs as that of
 * `at(1 / factor)` (SIZE_FACTOR unless given). `at(scale)` builds the input at that share of the
 * test's full size and returns the call to measure. Best of a few tries; it
 * stops at the first try within linearLimit(factor), which a linear call
 * needs.
 *
 * Each size is repeated for at least 25 clock steps, so a check takes a few
 * tenths of a second of CPU: a test that makes one takes HEAVY_TEST_MS
 * (shared/timing.ts) rather than Vitest's 5 s.
 */
export function growth(
  at: (scale: number) => () => unknown,
  factor = SIZE_FACTOR,
): number {
  const limit = linearLimit(factor);
  const small = at(1 / factor);
  const full = at(1);
  let smallest = Number.POSITIVE_INFINITY;
  let fullest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < TRIES; i += 1) {
    smallest = Math.min(smallest, perCall(small));
    fullest = Math.min(fullest, perCall(full));
    const grew = fullest / smallest;
    // Within the bound, or quadratic beyond doubt: another try can't change it.
    if (grew < limit || grew > factor ** 2) break;
  }
  if (process.env.LINEAR_COST_LOG) {
    console.log(`growth ${(fullest / smallest).toFixed(1)}`);
  }
  return fullest / smallest;
}
