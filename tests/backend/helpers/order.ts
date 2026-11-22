/**
 * The order `sort()` gives when it has no compare function: each value as
 * text, by UTF-16 code unit. Tests pass it so every sort states its order.
 */
export function byText(a: unknown, b: unknown): number {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
