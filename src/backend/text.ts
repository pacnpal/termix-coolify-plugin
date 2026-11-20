/**
 * `value` without the run of `char` at its end. A loop, not `/x+$/`: that
 * regex backtracks quadratically on a long run that isn't at the end.
 */
export function trimTrailing(value: string, char: string): string {
  if (char.length !== 1) throw new Error("trimTrailing takes one character");
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end--;
  return value.slice(0, end);
}
