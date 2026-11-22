// Coolify's deployment statuses (ApplicationDeploymentStatus), shared by the
// backend and the build log view so both agree on when a deployment is over
// and how it ended. Nothing else reads a deployment status by its spelling
// (tests/backend/deployment-status-guard.test.ts checks).

/** Coolify's own statuses, each with words in locales (deployments.status). */
const COOLIFY: ReadonlySet<string> = new Set([
  "queued",
  "in_progress",
  "finished",
  "failed",
  "cancelled-by-user",
  "skipped",
]);

/** Whether this is one of Coolify's own statuses, not an older spelling. */
export function isCoolifyDeploymentStatus(status: string): boolean {
  return COOLIFY.has(status);
}

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

/** Final statuses that mean the deployment failed (and an older spelling). */
const FAILED: ReadonlySet<string> = new Set(["failed", "error"]);

/** Whether a deployment with this status ended in failure. */
export function isFailedDeployment(status: string): boolean {
  return FAILED.has(status);
}

/** Final statuses that mean a new build ran and succeeded (and an older spelling). */
const SUCCEEDED: ReadonlySet<string> = new Set(["finished", "success"]);

/**
 * Whether a deployment with this status ended with a new build that
 * succeeded. Every other final status (failed, cancelled, skipped) ended
 * without one, so a run that waited on it did not succeed.
 */
export function isSuccessfulDeployment(status: string): boolean {
  return SUCCEEDED.has(status);
}

/** Whether Coolify skipped the deployment: it ended and no build ran. */
export function isSkippedDeployment(status: string): boolean {
  return status === "skipped";
}
