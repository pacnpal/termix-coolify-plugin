import { describe, expect, it } from "vitest";
import {
  COOLIFY_WEBHOOK_EVENTS,
  readWebhook,
} from "../../../src/backend/webhooks/shape.js";
import { COOLIFY_WEBHOOKS } from "../fixtures/coolify-webhooks.js";

const body = (event: string, over: Record<string, unknown> = {}) => ({
  ...COOLIFY_WEBHOOKS[event],
  ...over,
});

describe("the webhook body's strict shape", () => {
  it("knows exactly the events Coolify v4.7.5 sends", () => {
    expect(Object.keys(COOLIFY_WEBHOOK_EVENTS).sort()).toEqual(
      Object.keys(COOLIFY_WEBHOOKS).sort(),
    );
  });

  it.each(Object.keys(COOLIFY_WEBHOOKS))("accepts Coolify's %s", (event) => {
    expect(readWebhook(body(event))?.event).toBe(event);
  });

  it.each(Object.keys(COOLIFY_WEBHOOKS))(
    "refuses %s with one extra key",
    (event) => {
      expect(readWebhook(body(event, { extra: "x" }))).toBeNull();
    },
  );

  it("refuses an unknown event, a missing required key and a wrong type", () => {
    expect(readWebhook(body("test", { event: "nope" }))).toBeNull();
    const { application_uuid: _gone, ...noUuid } = body("deployment_failed");
    expect(readWebhook(noUuid)).toBeNull();
    const { success: _s, ...noSuccess } = body("test");
    expect(readWebhook(noSuccess)).toBeNull();
    expect(readWebhook(body("test", { success: "true" }))).toBeNull();
    expect(readWebhook(body("test", { message: null }))).toBeNull();
    expect(
      readWebhook(body("high_disk_usage", { disk_usage: "91" })),
    ).toBeNull();
    expect(
      readWebhook(body("task_failed", { consecutive_failures: 1.5 })),
    ).toBeNull();
    expect(
      readWebhook(body("deployment_failed", { application_name: 3 })),
    ).toBeNull();
  });

  it("refuses a uuid that is not one plain segment", () => {
    for (const uuid of ["../servers", "a/b", "", "x".repeat(129), 7]) {
      expect(
        readWebhook(body("deployment_failed", { application_uuid: uuid })),
      ).toBeNull();
    }
  });

  it("refuses anything but a plain object, and inherited or prototype keys", () => {
    for (const bad of [null, undefined, "test", 1, [], [body("test")]]) {
      expect(readWebhook(bad)).toBeNull();
    }
    const proto = JSON.parse(
      '{"success":true,"message":"m","event":"test","__proto__":{"x":1}}',
    );
    expect(readWebhook(proto)).toBeNull();
    const constructor = body("test", { constructor: "x" });
    expect(readWebhook(constructor)).toBeNull();
  });

  it("maps a deployment to its resource and deployment, and nothing else", () => {
    const read = readWebhook(body("deployment_failed"));
    expect(read?.ingest).toEqual({
      subject: { type: "application", uuid: "app-web-uuid" },
      event: {
        kind: "deployment-failed",
        source: "webhook",
        resourceUuid: "app-web-uuid",
        deploymentUuid: "dep-uuid-2",
        name: "web",
        status: "failed",
        fields: { pullRequestId: 0 },
      },
    });
    expect(readWebhook(body("deployment_success"))?.ingest?.event).toEqual({
      kind: "deployment-finished",
      source: "webhook",
      resourceUuid: "app-web-uuid",
      deploymentUuid: "dep-uuid-1",
      name: "web",
      status: "finished",
      fields: { pullRequestId: 12 },
    });
  });

  it("maps backups to the database, tasks to their resource and server events to the server", () => {
    expect(readWebhook(body("backup_failed"))?.ingest).toEqual({
      subject: { type: "database", uuid: "db-pg-uuid" },
      event: {
        kind: "backup-failed",
        source: "webhook",
        resourceUuid: "db-pg-uuid",
        name: "pg",
        status: "failed",
        fields: {},
      },
    });
    expect(
      readWebhook(body("backup_success_with_s3_warning"))?.ingest?.event,
    ).toMatchObject({ kind: "backup-succeeded", fields: { s3Failed: true } });
    expect(readWebhook(body("task_failed"))?.ingest).toEqual({
      subject: { type: "service", uuid: "svc-n8n-uuid" },
      event: {
        kind: "task-failed",
        source: "webhook",
        resourceUuid: "svc-n8n-uuid",
        taskUuid: "task-uuid",
        name: "nightly",
        status: "failed",
        fields: { consecutiveFailures: 3 },
      },
    });
    expect(readWebhook(body("task_disabled"))?.ingest).toMatchObject({
      subject: { type: "application", uuid: "app-web-uuid" },
      event: { kind: "task-failed", status: "disabled" },
    });
    expect(readWebhook(body("high_disk_usage"))?.ingest).toEqual({
      subject: { type: "server", uuid: "srv-vps1-uuid" },
      event: {
        kind: "high-disk",
        source: "webhook",
        serverUuid: "srv-vps1-uuid",
        name: "vps1",
        fields: { diskUsage: 91, threshold: 80 },
      },
    });
    expect(readWebhook(body("server_unreachable"))?.ingest).toEqual({
      subject: { type: "server", uuid: "srv-vps1-uuid" },
      event: {
        kind: "server-unreachable",
        source: "webhook",
        serverUuid: "srv-vps1-uuid",
        name: "vps1",
        status: "unreachable",
        fields: {},
      },
    });
    expect(readWebhook(body("restart_limit_reached"))?.ingest).toMatchObject({
      subject: { type: "application", uuid: "app-web-uuid" },
      event: {
        kind: "restart-limit",
        resourceUuid: "app-web-uuid",
        fields: { restartCount: 10, maxRestartCount: 10 },
      },
    });
  });

  it("maps a stopped application or database to status-changed, by the type in Coolify's own link", () => {
    expect(readWebhook(body("status_changed"))?.ingest).toEqual({
      subject: { type: "application", uuid: "app-web-uuid" },
      event: {
        kind: "status-changed",
        source: "webhook",
        resourceUuid: "app-web-uuid",
        name: "web",
        status: "exited",
        fields: { to: "stopped" },
      },
    });
    const database = readWebhook(
      body("status_changed", {
        application_uuid: "db-pg-uuid",
        resource_uuid: "db-pg-uuid",
        url: "https://coolify.example.test/project/p/environment/e/database/db-pg-uuid",
      }),
    );
    expect(database?.ingest?.subject).toEqual({
      type: "database",
      uuid: "db-pg-uuid",
    });
    // A preview or a service's part: the link names its parent, not it, and
    // the poller counts neither, so nothing is ingested.
    for (const url of [
      "https://coolify.example.test/project/p/environment/e/application/parent-uuid",
      "https://coolify.example.test/project/p/environment/e/service/svc-n8n-uuid",
      null,
    ]) {
      const read = readWebhook(body("status_changed", { url }));
      expect(read?.event).toBe("status_changed");
      expect(read?.ingest).toBeNull();
    }
  });

  it("never carries log or command output, or Coolify's own text, into the event", () => {
    for (const event of Object.keys(COOLIFY_WEBHOOKS)) {
      const mapped = JSON.stringify(readWebhook(body(event))?.ingest ?? null);
      for (const text of [
        "pg_dump",
        "exit 1",
        "upload refused",
        "https://",
        "Deployment failed",
      ]) {
        expect(mapped, event).not.toContain(text);
      }
    }
  });

  it("accepts but ingests nothing for events no kind covers", () => {
    for (const event of [
      "test",
      "general",
      "container_restarted",
      "docker_cleanup_failed",
      "server_reachable",
      "server_patch_check",
      "traefik_version_outdated",
      "ssl_certificate_renewal",
      "hetzner_deletion_failed",
    ]) {
      const read = readWebhook(body(event));
      expect(read?.event, event).toBe(event);
      expect(read?.ingest, event).toBeNull();
    }
    // A task Coolify tied to neither an application nor a service.
    const { application_uuid: _a, ...orphan } = body("task_success");
    expect(readWebhook(orphan)?.ingest).toBeNull();
  });
});
