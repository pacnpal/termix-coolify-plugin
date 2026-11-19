const CORE = /^v?(\d+)\.(\d+)\.(\d+)/;

/**
 * Whether a Coolify version is at least `min`. Only major.minor.patch count:
 * a prerelease or nightly tag is ignored, so "4.8.0-nightly" passes a "4.8.0"
 * gate. A nightly that lacks an endpoint is caught by 404/405 feature
 * detection instead. A version that can't be read never passes.
 */
export function meetsMinVersion(version: string, min: string): boolean {
  const have = CORE.exec(version.trim());
  const need = CORE.exec(min.trim());
  if (!have || !need) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(have[i]) - Number(need[i]);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
