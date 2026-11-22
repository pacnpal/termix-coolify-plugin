import { deploymentRaw } from "./deployments.js";
import type { fakeCoolify, FakeAnswer } from "./fake-coolify.js";
import type { PluginHarness } from "./plugin.js";
import { resourceLists } from "./resources.js";

/**
 * Answers Coolify's application list with `before` run first: a change made
 * while the plugin reads the resource, before any preview request.
 */
export function duringResourceRead(
  fake: ReturnType<typeof fakeCoolify>,
  before: () => void,
): void {
  const list = (resourceLists()["GET /applications"] as { json: unknown }).json;
  fake.set("GET /applications", () => {
    before();
    return new Response(JSON.stringify(list), {
      headers: { "content-type": "application/json" },
    });
  });
}

/** Points the connection at another address: its revision changes. */
export function moveTarget(harness: PluginHarness, id: number): void {
  harness.db.sqlite
    .prepare("UPDATE p_coolify_connections SET base_url = ? WHERE id = ?")
    .run("https://other.example.test", id);
}

/** Lowers a user's grant to view. */
export function dropGrant(harness: PluginHarness, userId: string): void {
  harness.db.sqlite
    .prepare("UPDATE p_coolify_grants SET level = 'view' WHERE user_id = ?")
    .run(userId);
}

/** The three preview changes, as routes and as actions. */
export const PREVIEW_CHANGES = [
  {
    actionId: "coolify.preview-create",
    method: "POST",
    path: (id: number) => `/connections/${id}/resources/app-web-uuid/previews`,
    body: { pullRequestId: 51 } as Record<string, unknown> | undefined,
    input: { pullRequestId: 51 } as Record<string, unknown>,
  },
  {
    actionId: "coolify.preview-domains",
    method: "PATCH",
    path: (id: number) =>
      `/connections/${id}/resources/app-web-uuid/previews/42`,
    body: { domains: "https://pr-42.example.test" },
    input: { pullRequestId: 42, domains: "https://pr-42.example.test" },
  },
  {
    actionId: "coolify.preview-delete",
    method: "DELETE",
    path: (id: number) =>
      `/connections/${id}/resources/app-web-uuid/previews/42`,
    body: undefined,
    input: { pullRequestId: 42 },
  },
] as const;

/** One pull request preview as Coolify lists it. */
export function previewRaw(
  pullRequestId: number,
  extra: Record<string, unknown> = {},
) {
  return {
    uuid: `prev-${pullRequestId}-uuid`,
    pull_request_id: pullRequestId,
    pull_request_html_url: `https://github.com/acme/web/pull/${pullRequestId}`,
    git_type: "github",
    status: "running:healthy",
    domains: `https://pr-${pullRequestId}.example.test`,
    docker_compose_domains: null,
    domain_port_overrides: null,
    docker_registry_image_tag: null,
    last_online_at: "2026-11-19T11:00:00.000000Z",
    created_at: "2026-11-19T10:00:00.000000Z",
    updated_at: "2026-11-19T10:30:00.000000Z",
    ...extra,
  };
}

/** A fake private key, split over several lines as a log would carry it. */
export const FAKE_KEY_LINES = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "fake-preview-key-body-line-one",
  "fake-preview-key-body-line-two",
  "-----END OPENSSH PRIVATE KEY-----",
];

/** Coolify's answers for web's previews (and api's one). */
export function previewAnswers(): Record<string, FakeAnswer> {
  return {
    "GET /applications/app-web-uuid/previews": {
      json: [previewRaw(42), previewRaw(7, { status: "exited" })],
    },
    "GET /applications/app-api-uuid/previews": { json: [previewRaw(99)] },
    "GET /deployments/applications/app-web-uuid": {
      json: {
        count: 3,
        deployments: [
          deploymentRaw("dep-pr42", "in_progress", {
            extra: { pull_request_id: 42 },
          }),
          deploymentRaw("dep-main", "finished"),
          deploymentRaw("dep-pr42-old", "finished", {
            extra: { pull_request_id: 42 },
          }),
        ],
      },
    },
    "POST /applications/app-web-uuid/previews": {
      status: 201,
      json: {
        message: "Preview deployment created.",
        deployment_uuid: "dep-pr51",
        preview: previewRaw(51),
      },
    },
    "DELETE /applications/app-web-uuid/previews/42": {
      json: { message: "Preview deletion queued." },
    },
    "PATCH /applications/app-web-uuid/previews/42": {
      json: { message: "Preview domains updated." },
    },
    "GET /applications/app-web-uuid/previews/42/logs": {
      json: {
        logs: [
          "preview listening on 3000",
          "DB_PASSWORD=fake-preview-pass",
          ...FAKE_KEY_LINES,
          "preview ready",
        ].join("\n"),
      },
    },
  };
}
