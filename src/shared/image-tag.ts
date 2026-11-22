/**
 * A Docker image tag: what Coolify lists, what a rollback may name and what
 * a Docker image preview is deployed with. Shared by the backend's checks and
 * the forms that check before sending.
 */
export const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** A git commit SHA, short (7) to full (40) hex characters. */
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
