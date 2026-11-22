import { deploymentRaw } from "./deployments.js";
import type { FakeAnswer } from "./fake-coolify.js";

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
