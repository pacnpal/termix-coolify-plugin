// Coolify's deployment statuses (ApplicationDeploymentStatus), shared by the
// backend and the build log view so both agree on when a deployment is over.

/**
 * Statuses that end a deployment: Coolify's final ones (finished, failed,
 * cancelled-by-user, skipped), and older spellings some instances send.
 */
const FINAL: ReadonlySet<string> = new Set([
  "finished",
  "failed",
  "cancelled-by-user",
  "skipped",
  "success",
  "error",
  "cancelled",
]);

/** Statuses Coolify lets a deployment be cancelled from. */
const CANCELLABLE: ReadonlySet<string> = new Set(["queued", "in_progress"]);

/** Whether a deployment with this status has ended: nothing more will change. */
export function isFinalDeployment(status: string): boolean {
  return FINAL.has(status);
}

/** Whether Coolify still lets a deployment with this status be cancelled. */
export function isCancellableDeployment(status: string): boolean {
  return CANCELLABLE.has(status);
}
