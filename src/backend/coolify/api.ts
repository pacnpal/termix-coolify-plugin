import { OPERATIONS } from "./generated/operations.js";
import { CoolifyError, type CoolifyHttp } from "./http.js";
import { fillPath, pathRules } from "./path.js";
import {
  resourceServerUuid,
  toApplication,
  toDatabase,
  toDeployment,
  toDeploymentLog,
  toKey,
  toPart,
  toPreview,
  toProject,
  toRollbackImages,
  toSentinelSettings,
  toServer,
  toService,
  toStorages,
  toTeam,
  toVulnerability,
  toBackupRuns,
  toScheduledTask,
  toTaskRun,
  type DeploymentDto,
  type KeyDto,
  type PreviewDto,
  type ProjectDto,
  type ResourceDto,
  type ResourceKind,
  type RollbackImagesDto,
  type RunDto,
  type ScheduledTaskDto,
  type SentinelSettingsDto,
  type ServerDto,
  type StorageDto,
  type TeamDto,
  type VulnerabilityDto,
} from "./dto.js";

/** Something a token can be asked whether it reads (`canRead`). */
export type ReadableSubject =
  | { type: "application" | "service" | "database" | "server"; uuid: string }
  | { type: "team" };

/** What canRead keeps of a readable subject's answer. */
export interface SubjectRead {
  /** A resource's server, by field name; unchecked text, or null. */
  serverUuid: string | null;
}

const READ_SUBJECT = {
  application: "get-application-by-uuid",
  service: "get-service-by-uuid",
  database: "get-database-by-uuid",
  server: "get-server-by-uuid",
} as const;

export type LifecycleAction = "start" | "stop" | "restart";

/** Runs right before each request (after budget and retry waits); a throw sends nothing. */
export interface FetchGuard {
  beforeFetch?: () => Promise<void>;
}

const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]));

/**
 * A Coolify key with its material, for the one step that copies it into a
 * Termix credential (ADR 0002). Not a DTO: it never leaves the sync service,
 * and nothing returns, logs or stores it. Only keyForCopy makes one.
 */
export interface KeyForCopy {
  uuid: string;
  name: string;
  fingerprint: string | null;
  /** Null when the token can't read key material (no read:sensitive). */
  privateKey: string | null;
  publicKey: string | null;
}

/** Coolify's answer for one resource of a deploy request. */
export interface DeployRow {
  resourceUuid: string | null;
  deploymentUuid: string | null;
  message: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The method and path of a vendored operation, with its path parameters filled in. */
function op(
  id: string,
  params: Record<string, string> = {},
): { method: string; path: string } {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown Coolify operation ${id}`);
  const path = fillPath(
    found.path,
    params,
    pathRules(id),
    (message) => new CoolifyError("validation", 0, message),
  );
  return { method: found.method, path };
}

function rows(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

function needParent(kind: ResourceKind, parentUuid: string | undefined) {
  if (
    (kind === "service-application" || kind === "service-database") &&
    !parentUuid
  ) {
    throw new CoolifyError("validation", 0, "A Part needs its service's uuid");
  }
}

function lifecycleOp(
  kind: ResourceKind,
  uuid: string,
  action: LifecycleAction,
  parentUuid: string | undefined,
) {
  needParent(kind, parentUuid);
  switch (kind) {
    case "application":
      return op(`${action}-application-by-uuid`, { uuid });
    case "database":
      return op(`${action}-database-by-uuid`, { uuid });
    case "service":
      return op(`${action}-service-by-uuid`, { uuid });
    case "service-application":
      return op(`post-${action}-service-application-by-service-and-app-uuid`, {
        uuid: parentUuid,
        app_uuid: uuid,
      });
    case "service-database":
      return op(`${action}-service-database-by-service-and-database-uuid`, {
        uuid: parentUuid,
        database_uuid: uuid,
      });
  }
}

function logsOp(kind: ResourceKind, uuid: string, parentUuid?: string) {
  needParent(kind, parentUuid);
  switch (kind) {
    case "application":
      return op("get-application-logs-by-uuid", { uuid });
    case "database":
      return op("get-database-logs-by-uuid", { uuid });
    case "service":
      // Coolify needs a sub_service_name here and answers 400 without one;
      // the per-Part endpoints below take the Part's uuid instead.
      throw new CoolifyError(
        "validation",
        0,
        "A service's logs are read through one of its parts",
      );
    case "service-application":
      return op("get-service-application-logs-by-service-and-app-uuid", {
        uuid: parentUuid,
        app_uuid: uuid,
      });
    case "service-database":
      return op("get-service-database-logs-by-service-and-database-uuid", {
        uuid: parentUuid,
        database_uuid: uuid,
      });
  }
}

/**
 * Typed calls to Coolify. Every one returns DTOs from dto.ts, never a raw
 * payload, and reaches Coolify only through the CoolifyHttp it is given.
 */
export function createCoolifyApi(http: CoolifyHttp) {
  async function call<T = unknown>(
    target: { method: string; path: string },
    opts?: Parameters<CoolifyHttp["request"]>[2],
  ): Promise<T> {
    return http.request<T>(target.method, target.path, opts);
  }

  /**
   * One page of an application's deployments, newest first, and Coolify's
   * total when it sends one. The build logs Coolify sends with each row are
   * dropped.
   */
  async function deploymentPage(
    appUuid: string,
    opts: { skip: number; take: number; beforeFetch?: () => Promise<void> },
  ): Promise<{ count: number | null; rows: DeploymentDto[] }> {
    const body = await call(
      op("list-deployments-by-app-uuid", { uuid: appUuid }),
      {
        query: { skip: opts.skip, take: opts.take },
        beforeFetch: opts.beforeFetch,
      },
    );
    const count =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { count?: unknown }).count
        : undefined;
    return {
      count:
        typeof count === "number" && Number.isSafeInteger(count) ? count : null,
      rows: rows(body, "deployments").map((d) => toDeployment(d, appUuid)),
    };
  }

  return {
    /** "OK" when Coolify answers its health check. Allowed for every token. */
    async health(): Promise<string> {
      return String(await call(op("healthcheck"), { text: true }));
    },

    /** The version string, like "v4.7.5". Refuses an answer that isn't one. */
    async version(): Promise<string> {
      const text = String(await call(op("version"), { text: true })).trim();
      if (!/^v?\d+\.\d+/.test(text)) {
        throw new CoolifyError("not-coolify", 200);
      }
      return text;
    },

    /**
     * Whether this token reads `subject`: one GET of the subject itself
     * (`GET /team` for the team), never retried, readable only on a 200. Any
     * other answer, a malformed uuid, a timeout or any error is null. Of
     * what it read, only a resource's server uuid is returned. It counts against the request
     * budget like any call. For the webhook's per-connection check (#91).
     * `beforeFetch` runs right before the request (after the budget wait);
     * a throw sends nothing and answers false.
     */
    async canRead(
      subject: ReadableSubject,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<SubjectRead | null> {
      try {
        const target =
          subject.type === "team"
            ? op("get-token-team")
            : op(READ_SUBJECT[subject.type], { uuid: subject.uuid });
        const body = await call(target, {
          retry: false,
          exactStatus: 200,
          beforeFetch: opts.beforeFetch,
        });
        return {
          serverUuid:
            subject.type === "team" || subject.type === "server"
              ? null
              : resourceServerUuid(body),
        };
      } catch {
        return null;
      }
    },

    async team(): Promise<TeamDto> {
      return toTeam(await call(op("get-token-team")));
    },

    async projects(): Promise<ProjectDto[]> {
      return rows(await call(op("list-projects")), "projects").map(toProject);
    },

    async servers(opts: FetchGuard = {}): Promise<ServerDto[]> {
      return rows(await call(op("list-servers"), opts), "servers").map(
        toServer,
      );
    },

    async server(uuid: string): Promise<ServerDto> {
      return toServer(await call(op("get-server-by-uuid", { uuid })));
    },

    async keys(): Promise<KeyDto[]> {
      return rows(await call(op("list-private-keys")), "keys").map(toKey);
    },

    /** One key's metadata. The key material, when sent, is dropped here. */
    async key(uuid: string): Promise<KeyDto> {
      return toKey(await call(op("get-private-key-by-uuid", { uuid })));
    },

    /**
     * One key with its material, only for copying it into a Termix
     * credential. Every other caller uses key(), which drops the material.
     */
    async keyForCopy(uuid: string): Promise<KeyForCopy> {
      const raw = await call<Record<string, unknown> | null>(
        op("get-private-key-by-uuid", { uuid }),
      );
      const body = raw && typeof raw === "object" ? raw : {};
      const meta = toKey(body);
      return {
        uuid: meta.uuid || uuid,
        name: meta.name,
        fingerprint: meta.fingerprint,
        privateKey: text(body.private_key),
        publicKey: text(body.public_key)?.trim() ?? null,
      };
    },

    async applications(opts: FetchGuard = {}): Promise<ResourceDto[]> {
      return rows(
        await call(op("list-applications"), opts),
        "applications",
      ).map(toApplication);
    },

    async services(opts: FetchGuard = {}): Promise<ResourceDto[]> {
      return rows(await call(op("list-services"), opts), "services").flatMap(
        toService,
      );
    },

    async databases(opts: FetchGuard = {}): Promise<ResourceDto[]> {
      return rows(await call(op("list-databases"), opts), "databases").map(
        toDatabase,
      );
    },

    async resource(
      kind: ResourceKind,
      uuid: string,
      opts: { parentUuid?: string } = {},
    ): Promise<ResourceDto> {
      needParent(kind, opts.parentUuid);
      switch (kind) {
        case "application":
          return toApplication(
            await call(op("get-application-by-uuid", { uuid })),
          );
        case "database":
          return toDatabase(await call(op("get-database-by-uuid", { uuid })));
        case "service":
          return toService(await call(op("get-service-by-uuid", { uuid })))[0];
        case "service-application":
          return toPart(
            await call(
              op("get-service-application-by-service-and-app-uuid", {
                uuid: opts.parentUuid,
                app_uuid: uuid,
              }),
            ),
            kind,
            opts.parentUuid,
          );
        case "service-database":
          return toPart(
            await call(
              op("get-service-database-by-service-and-database-uuid", {
                uuid: opts.parentUuid,
                database_uuid: uuid,
              }),
            ),
            kind,
            opts.parentUuid,
          );
      }
    },

    /** An application's, service's or database's storages, without content. */
    async storages(
      kind: "application" | "service" | "database",
      uuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<StorageDto[]> {
      return toStorages(
        await call(op(`list-storages-by-${kind}-uuid`, { uuid }), {
          beforeFetch: opts.beforeFetch,
        }),
      );
    },

    /**
     * Container logs through Coolify. Needs read:sensitive on the token.
     * Coolify's Part log endpoints have no timestamps flag and ignore it.
     */
    async logs(
      kind: ResourceKind,
      uuid: string,
      opts: {
        lines: number;
        parentUuid?: string;
        timestamps?: boolean;
        beforeFetch?: () => Promise<void>;
      },
    ): Promise<string> {
      const body = await call<unknown>(logsOp(kind, uuid, opts.parentUuid), {
        query: {
          lines: opts.lines,
          show_timestamps: opts.timestamps ? true : undefined,
        },
        beforeFetch: opts.beforeFetch,
      });
      if (typeof body === "string") return body;
      const logs = (body as { logs?: unknown } | null)?.logs;
      return typeof logs === "string" ? logs : "";
    },

    async lifecycle(
      kind: ResourceKind,
      uuid: string,
      action: LifecycleAction,
      opts: { parentUuid?: string } = {},
    ): Promise<void> {
      await call(lifecycleOp(kind, uuid, action, opts.parentUuid));
    },

    async deploy(
      uuid: string,
      opts: { force: boolean },
    ): Promise<{ deploymentUuids: string[] }> {
      const body = await call(op("deploy-by-tag-or-uuid"), {
        query: { uuid, force: opts.force },
      });
      return {
        deploymentUuids: rows(body, "deployments")
          .map((d) => (d as { deployment_uuid?: unknown }).deployment_uuid)
          .filter((id): id is string => typeof id === "string"),
      };
    },

    /**
     * Deploys the resources named by uuid in one request, with Coolify's
     * force, pull request and Docker tag options. Each row is Coolify's word
     * for one resource; deploymentUuid is null when it queued none.
     */
    async deployUuids(
      uuids: string[],
      opts: {
        force: boolean;
        pullRequestId?: number;
        dockerTag?: string;
        beforeFetch?: () => Promise<void>;
      },
    ): Promise<DeployRow[]> {
      const body = await call(op("deploy-by-tag-or-uuid"), {
        query: {
          uuid: uuids.join(","),
          force: opts.force,
          pr: opts.pullRequestId,
          docker_tag: opts.dockerTag,
        },
        beforeFetch: opts.beforeFetch,
      });
      return rows(body, "deployments").map((raw) => {
        const d = (raw ?? {}) as Record<string, unknown>;
        return {
          resourceUuid: text(d.resource_uuid),
          deploymentUuid: text(d.deployment_uuid),
          message: text(d.message),
        };
      });
    },

    /**
     * The runs of every backup schedule of one database, without their
     * messages (the poller).
     */
    async backupRuns(
      databaseUuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<RunDto[]> {
      return toBackupRuns(
        await call(op("get-database-backups-by-uuid", { uuid: databaseUuid }), {
          beforeFetch: opts.beforeFetch,
        }),
      );
    },

    /** An application's or a service's scheduled tasks, without commands. */
    async scheduledTasks(
      kind: "application" | "service",
      uuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<ScheduledTaskDto[]> {
      return rows(
        await call(op(`list-scheduled-tasks-by-${kind}-uuid`, { uuid }), {
          beforeFetch: opts.beforeFetch,
        }),
        "tasks",
      ).map(toScheduledTask);
    },

    /** One scheduled task's runs, without their output. */
    async taskRuns(
      kind: "application" | "service",
      uuid: string,
      taskUuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<RunDto[]> {
      return rows(
        await call(
          op(`list-scheduled-task-executions-by-${kind}-uuid`, {
            uuid,
            task_uuid: taskUuid,
          }),
          { beforeFetch: opts.beforeFetch },
        ),
        "executions",
      ).map(toTaskRun);
    },

    /** Coolify's queue: the deployments queued or running now, without logs. */
    async runningDeployments(
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<DeploymentDto[]> {
      const body = await call(op("list-deployments"), {
        beforeFetch: opts.beforeFetch,
      });
      return rows(body, "deployments").map((d) => toDeployment(d));
    },

    /**
     * The team's resources with their stored image scanning status, worst
     * first. Only counts are kept (dto.ts toVulnerability).
     */
    async vulnerabilities(
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<VulnerabilityDto[]> {
      const body = await call(op("list-vulnerabilities"), {
        beforeFetch: opts.beforeFetch,
      });
      return rows(body, "resources").map(toVulnerability);
    },

    /** The applications that carry a tag (Coolify filters by its name). */
    async applicationsTagged(
      tag: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<ResourceDto[]> {
      return rows(
        await call(op("list-applications"), {
          query: { tag },
          beforeFetch: opts.beforeFetch,
        }),
        "applications",
      ).map(toApplication);
    },

    /** The names of a resource's tags. */
    async tagsOf(
      kind: "application" | "service" | "database",
      uuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<string[]> {
      return rows(
        await call(op(`list-tags-by-${kind}-uuid`, { uuid }), {
          beforeFetch: opts.beforeFetch,
        }),
        "tags",
      )
        .map((t) => text((t as { name?: unknown } | null)?.name))
        .filter((name): name is string => name !== null);
    },

    async deployments(
      appUuid: string,
      opts: { skip: number; take: number },
    ): Promise<DeploymentDto[]> {
      return (await deploymentPage(appUuid, opts)).rows;
    },

    deploymentPage,

    async deployment(uuid: string): Promise<DeploymentDto> {
      return toDeployment(await call(op("get-deployment-by-uuid", { uuid })));
    },

    /**
     * One deployment and its raw build log, null when the token can't read
     * it. The log holds secrets: deployments/log.ts redacts it before it
     * goes anywhere.
     */
    async deploymentWithLog(
      uuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<{ deployment: DeploymentDto; log: string | null }> {
      const body = await call(op("get-deployment-by-uuid", { uuid }), {
        beforeFetch: opts.beforeFetch,
      });
      return { deployment: toDeployment(body), log: toDeploymentLog(body) };
    },

    /** The images an application can be rolled back to, and the current one. */
    async rollbackImages(
      appUuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<RollbackImagesDto> {
      return toRollbackImages(
        await call(op("list-application-rollback-images", { uuid: appUuid }), {
          beforeFetch: opts.beforeFetch,
        }),
      );
    },

    /** Queues a rollback deployment to `tag`; its deployment uuid, when Coolify says. */
    async rollback(
      appUuid: string,
      tag: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<{ deploymentUuid: string | null }> {
      const body = await call<unknown>(
        op("rollback-application-by-uuid", { uuid: appUuid }),
        { body: { commit: tag }, beforeFetch: opts.beforeFetch },
      );
      const id =
        body && typeof body === "object"
          ? (body as { deployment_uuid?: unknown }).deployment_uuid
          : undefined;
      return { deploymentUuid: typeof id === "string" ? id : null };
    },

    /** Cancels a queued or running deployment; its new status, when Coolify says. */
    async cancelDeployment(
      uuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<{ status: string | null }> {
      const body = await call<unknown>(
        op("cancel-deployment-by-uuid", { uuid }),
        { beforeFetch: opts.beforeFetch },
      );
      const status =
        body && typeof body === "object"
          ? (body as { status?: unknown }).status
          : undefined;
      return { status: typeof status === "string" ? status : null };
    },

    /** An application's pull request previews, newest pull request first. */
    async previews(
      appUuid: string,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<PreviewDto[]> {
      const body = await call(
        op("list-preview-deployments-by-application-uuid", { uuid: appUuid }),
        { beforeFetch: opts.beforeFetch },
      );
      return rows(body, "previews").map(toPreview);
    },

    /**
     * Opens (or redeploys) a pull request preview and queues its
     * deployment; the deployment's uuid when Coolify names one.
     */
    async createPreview(
      appUuid: string,
      body: Record<string, unknown>,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<{ deploymentUuid: string | null; preview: PreviewDto | null }> {
      const answer = await call<unknown>(
        op("create-preview-deployment-by-application-uuid", { uuid: appUuid }),
        { body, beforeFetch: opts.beforeFetch },
      );
      const raw =
        answer && typeof answer === "object"
          ? (answer as Record<string, unknown>)
          : {};
      return {
        deploymentUuid: text(raw.deployment_uuid),
        preview:
          raw.preview && typeof raw.preview === "object"
            ? toPreview(raw.preview)
            : null,
      };
    },

    /** Deletes a preview: Coolify queues stopping and removing it. */
    async deletePreview(
      appUuid: string,
      pullRequestId: number,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<void> {
      await call(
        op("delete-preview-deployment-by-pull-request-id", {
          uuid: appUuid,
          pull_request_id: String(pullRequestId),
        }),
        { beforeFetch: opts.beforeFetch },
      );
    },

    /** Replaces a preview's domains (checked by the caller). */
    async updatePreviewDomains(
      appUuid: string,
      pullRequestId: number,
      body: Record<string, unknown>,
      opts: { beforeFetch?: () => Promise<void> } = {},
    ): Promise<void> {
      await call(
        op("update-preview-domains-by-pull-request-id", {
          uuid: appUuid,
          pull_request_id: String(pullRequestId),
        }),
        { body, beforeFetch: opts.beforeFetch },
      );
    },

    /**
     * A preview's container logs. Needs read:sensitive on the token. They
     * hold secrets: previews/service.ts redacts them before they go anywhere.
     */
    async previewLogs(
      appUuid: string,
      pullRequestId: number,
      opts: {
        lines: number;
        timestamps?: boolean;
        beforeFetch?: () => Promise<void>;
      },
    ): Promise<string> {
      const body = await call<unknown>(
        op("get-preview-application-logs-by-pull-request-id", {
          uuid: appUuid,
          pull_request_id: String(pullRequestId),
        }),
        {
          query: {
            lines: opts.lines,
            show_timestamps: opts.timestamps ? true : undefined,
          },
          beforeFetch: opts.beforeFetch,
        },
      );
      if (typeof body === "string") return body;
      const logs = (body as { logs?: unknown } | null)?.logs;
      return typeof logs === "string" ? logs : "";
    },

    async patchSentinel(
      serverUuid: string,
      body: Record<string, unknown>,
    ): Promise<void> {
      await call(op("update-server-sentinel", { uuid: serverUuid }), { body });
    },

    /** Sentinel settings, stripped of the token, push URL and GeoIP key. */
    async sentinelSettings(serverUuid: string): Promise<SentinelSettingsDto> {
      return toSentinelSettings(
        await call(op("get-server-sentinel", { uuid: serverUuid })),
      );
    },

    /**
     * Resolves when the token may read instance settings. Coolify allows that
     * to any token of a root-team admin or owner, whatever its abilities, so
     * it says nothing about `root` or `read:sensitive`. The settings
     * themselves are dropped unread.
     */
    async instanceSettingsCheck(): Promise<void> {
      await call(op("get-instance-email-settings"));
    },
  };
}

export type CoolifyApi = ReturnType<typeof createCoolifyApi>;
