// The Termix recent-activity types this plugin records, shared by the backend
// (ctx.hosts.recordActivity) and the frontend (the tab that claims them), so
// an entry always opens the Coolify tab.

export type ActivityKind = "shell" | "deploy";

/** Lowercase letters, digits and underscores, as core requires. */
export const ACTIVITY_TYPES: Readonly<Record<ActivityKind, string>> = {
  shell: "coolify_shell",
  deploy: "coolify_deploy",
};
