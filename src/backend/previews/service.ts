import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type {
  ComposeDomainDto,
  PreviewDto,
  ResourceDto,
} from "../coolify/dto.js";
import { COMMIT_SHA, IMAGE_TAG } from "../../shared/image-tag.js";
import { OPERATIONS } from "../coolify/generated/operations.js";
import { CoolifyError } from "../coolify/http.js";
import { meetsMinVersion } from "../coolify/version.js";
import { ConnectionError } from "../connections/service.js";
import { lineSplitter } from "../containers/logs.js";
import { MAX_TAKE, type Deployments } from "../deployments/service.js";
import { documentedFrom, versionOf } from "../ops/api-generic.js";
import { redact } from "../redact.js";
import { checkDomains, type DomainProblem } from "../../shared/domains.js";

/** One preview with its newest build, when the recent history has one. */
export interface PreviewRow extends PreviewDto {
  /** The newest deployment for this pull request, for its build log. */
  deploymentUuid: string | null;
  deploymentStatus: string | null;
}

export type GitType = "github" | "gitlab" | "gitea" | "bitbucket";
export const GIT_TYPES: readonly GitType[] = [
  "github",
  "gitlab",
  "gitea",
  "bitbucket",
];

export interface PreviewCreate {
  pullRequestId: number;
  pullRequestUrl?: string;
  gitType?: GitType;
  commit?: string;
  dockerTag?: string;
  force: boolean;
}

export type PreviewDomains =
  { domains: string } | { composeDomains: ComposeDomainDto[] };

export interface PreviewLogsRequest {
  lines: number;
  timestamps: boolean;
}

/** Coolify's largest pull request id (a 32-bit integer). */
export const MAX_PULL_REQUEST_ID = 2_147_483_647;
/** Lines a preview's logs answer has unless asked for another count. */
export const DEFAULT_PREVIEW_LINES = 100;
/** The most lines Coolify answers for a preview's logs. */
export const MAX_PREVIEW_LINES = 10_000;
/** The most Docker Compose services one domains change may name. */
export const MAX_COMPOSE_SERVICES = 50;

const invalid = (message: string) =>
  new ConnectionError("invalid-input", message);

const DOMAIN_PROBLEMS: Record<DomainProblem, string> = {
  empty: "enter at least one domain",
  "too-long": "the list is too long",
  "too-many": "at most 20 domains",
  scheme: "each domain must start with http:// or https://",
  credentials: "a domain can't carry a user name or password",
  query: "a domain can't have a query or a fragment",
  "not-url": "each domain must be a URL",
  host: "each domain needs a DNS host name",
  path: "a domain's path may hold only letters, digits and . _ ~ -",
  duplicate: "a domain is listed twice",
};

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function wholeNumber(value: unknown): number {
  return typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,10}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
}

/** A pull request id from an input; anything else is invalid-input. */
export function readPullRequestId(value: unknown): number {
  const n = wholeNumber(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PULL_REQUEST_ID) {
    throw invalid(
      `pullRequestId must be a whole number from 1 to ${MAX_PULL_REQUEST_ID}`,
    );
  }
  return n;
}

function optionalText(
  raw: Record<string, unknown>,
  key: string,
  rule: RegExp,
  message: string,
): string | undefined {
  const value = raw[key];
  if (!given(value)) return undefined;
  if (typeof value !== "string" || !rule.test(value.trim())) {
    throw invalid(message);
  }
  return value.trim();
}

function pullRequestUrl(raw: Record<string, unknown>): string | undefined {
  const value = optionalText(
    raw,
    "pullRequestUrl",
    /^https?:\/\/[^\s"'<>\\]{1,2040}$/i,
    "pullRequestUrl must be an http or https URL",
  );
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("pullRequestUrl must be an http or https URL");
  }
  if (url.username || url.password) {
    throw invalid("pullRequestUrl can't carry a user name or password");
  }
  // Sent as given: the parser's form would drop a port the caller wrote.
  return value;
}

/** What to open a preview with, checked before anything is asked. */
export function readPreviewCreate(raw: Record<string, unknown>): PreviewCreate {
  const gitType = raw.gitType;
  if (given(gitType) && !GIT_TYPES.includes(gitType as GitType)) {
    throw invalid("gitType must be github, gitlab, gitea or bitbucket");
  }
  if (raw.force !== undefined && typeof raw.force !== "boolean") {
    throw invalid("force must be true or false");
  }
  return {
    pullRequestId: readPullRequestId(raw.pullRequestId),
    pullRequestUrl: pullRequestUrl(raw),
    gitType: given(gitType) ? (gitType as GitType) : undefined,
    commit: optionalText(
      raw,
      "commit",
      COMMIT_SHA,
      "commit must be a commit SHA",
    ),
    dockerTag: optionalText(
      raw,
      "dockerTag",
      IMAGE_TAG,
      "dockerTag must be a Docker image tag",
    ),
    force: raw.force === true,
  };
}

function domainList(text: unknown, label: string): string {
  if (typeof text !== "string") throw invalid(`${label} must be text`);
  const checked = checkDomains(text);
  if ("reason" in checked)
    throw invalid(`${label}: ${DOMAIN_PROBLEMS[checked.reason]}`);
  return checked.value;
}

function composeList(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return composeList(JSON.parse(value));
    } catch {
      throw invalid("composeDomains must be a list of { name, domain }");
    }
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid("composeDomains must be a list of { name, domain }");
  }
  if (value.length > MAX_COMPOSE_SERVICES) {
    throw invalid(
      `composeDomains names at most ${MAX_COMPOSE_SERVICES} services`,
    );
  }
  return value;
}

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/**
 * A domains change, checked with the same rules everywhere before it is
 * sent: `domains` for an ordinary application, or `composeDomains` (one
 * entry per Docker Compose service, an empty domain clearing that service's)
 * for a compose one.
 */
export function readPreviewDomains(
  raw: Record<string, unknown>,
): PreviewDomains {
  const hasDomains = raw.domains !== undefined;
  const hasCompose = raw.composeDomains !== undefined;
  if (hasDomains === hasCompose) {
    throw invalid("Give either domains or composeDomains");
  }
  if (hasDomains) return { domains: domainList(raw.domains, "domains") };
  const seen = new Set<string>();
  const composeDomains = composeList(raw.composeDomains).map((entry) => {
    const item =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!SERVICE_NAME.test(name) || seen.has(name)) {
      throw invalid("Each composeDomains entry needs its own service name");
    }
    seen.add(name);
    const domain =
      item.domain === null || item.domain === undefined || item.domain === ""
        ? null
        : domainList(item.domain, `composeDomains ${name}`);
    return { name, domain };
  });
  return { composeDomains };
}

/** A logs request from a query or an operation input, checked. */
export function readPreviewLogsRequest(raw: {
  lines?: unknown;
  timestamps?: unknown;
}): PreviewLogsRequest {
  let lines = DEFAULT_PREVIEW_LINES;
  if (given(raw.lines)) {
    lines = wholeNumber(raw.lines);
    if (
      !Number.isSafeInteger(lines) ||
      lines < 1 ||
      lines > MAX_PREVIEW_LINES
    ) {
      throw invalid(
        `lines must be a whole number from 1 to ${MAX_PREVIEW_LINES}`,
      );
    }
  }
  return {
    lines,
    timestamps: raw.timestamps === true || raw.timestamps === "true",
  };
}

/**
 * Log text redacted as one stream: lineSplitter carries an open private key
 * block (and every other open secret) from line to line, so a key whose
 * BEGIN and body sit on different lines never leaks its body. Redacted
 * whole, before anything is cut.
 */
export function redactLogStream(text: string, secrets: readonly string[]) {
  const out: string[] = [];
  const split = lineSplitter(secrets, (lines) => out.push(...lines));
  split.data(text);
  split.end();
  return out.join("\n");
}

/** The oldest Coolify whose API documents previews (the vendored specs' oldest). */
const PREVIEWS_SINCE = documentedFrom(
  OPERATIONS.find(
    (op) => op.id === "list-preview-deployments-by-application-uuid",
  )!,
);

export interface PreviewsDeps {
  deployments: Deployments;
}

type Snapshot = Awaited<ReturnType<Deployments["open"]>>;
type Level = "view" | "operate";

/**
 * An application's pull request previews: list, open (deploy), delete,
 * change domains and container logs, for routes and operations alike. Each
 * reads the connection once through the deployments service and checks,
 * after every await and right before each Coolify request, that the
 * connection still points at the same target and the actor's grant still
 * reaches the level: view for the list, operate for the rest (logs hold
 * secrets). The uuid must be one of the connection's own applications.
 * Changes also stop before Coolify is asked once their run is cancelled.
 * Inputs are checked before anything else, so a bad one never reaches
 * Coolify.
 */
export function createPreviews(ctx: PluginContext, deps: PreviewsDeps) {
  const { deployments } = deps;

  async function open(connectionId: number, level: Level): Promise<Snapshot> {
    if (!(await ctx.rbac.has(level))) {
      throw new ConnectionError(
        "forbidden",
        level === "view"
          ? "Previews need the View Coolify permission"
          : "Changing previews and reading their logs need the Operate Coolify permission",
      );
    }
    return deployments.open(connectionId, level);
  }

  /**
   * Runs a call that starts or removes deployments, then drops the cached
   * deployment queue, as cancel, deploy by tag and rollback do, so the
   * Deployments section, the activity panel and the rail badge read again.
   */
  async function changingQueue<T>(
    connectionId: number,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } finally {
      deployments.invalidateQueue(connectionId);
    }
  }

  /** A not-found from an instance older than the spec: it lacks previews. */
  async function coolify<T>(snap: Snapshot, call: () => Promise<T>) {
    try {
      return await call();
    } catch (err) {
      if (
        err instanceof CoolifyError &&
        err.cause === "not-found" &&
        !meetsMinVersion(versionOf(snap.view), PREVIEWS_SINCE)
      ) {
        throw new CoolifyError("unsupported-by-instance", err.status);
      }
      throw err;
    }
  }

  /**
   * Opens the connection at `level`, finds the application and checks the
   * snapshot still holds; then `call` runs with a beforeFetch that checks
   * it (and the run's signal) again right before the request.
   */
  async function onApplication<T>(
    connectionId: number,
    uuid: string,
    level: Level,
    signal: AbortSignal | undefined,
    call: (
      snap: Snapshot,
      appUuid: string,
      beforeFetch: () => Promise<void>,
      app: ResourceDto,
    ) => Promise<T>,
  ): Promise<{
    snap: Snapshot;
    appUuid: string;
    app: ResourceDto;
    answer: T;
  }> {
    const snap = await open(connectionId, level);
    const app = await deployments.application(connectionId, uuid);
    await deployments.holds(connectionId, snap, level);
    signal?.throwIfAborted();
    const beforeFetch = async () => {
      await deployments.holds(connectionId, snap, level);
      signal?.throwIfAborted();
    };
    const answer = await coolify(snap, () =>
      call(snap, app.uuid, beforeFetch, app),
    );
    await deployments.holds(connectionId, snap, level);
    return { snap, appUuid: app.uuid, app, answer };
  }

  /**
   * Refuses a new preview that lacks what Coolify needs to open one: a
   * Bitbucket pull request's commit, and a Docker image application's tag
   * (the create operation's description: "Bitbucket also needs commit",
   * "Docker Image applications need docker_tag for a new preview"). A
   * redeploy of a listed preview needs neither, so the list is read only
   * when one is missing.
   */
  async function requireForNew(
    snap: Snapshot,
    app: ResourceDto,
    input: PreviewCreate,
    beforeFetch: () => Promise<void>,
  ): Promise<void> {
    const missing =
      input.gitType === "bitbucket" && !input.commit
        ? "A new Bitbucket preview needs commit, the SHA to deploy"
        : app.buildPack === "dockerimage" && !input.dockerTag
          ? "A new preview of a Docker image application needs dockerTag"
          : null;
    if (!missing) return;
    const listed = await snap.api.previews(app.uuid, { beforeFetch });
    if (!listed.some((p) => p.pullRequestId === input.pullRequestId)) {
      throw invalid(missing);
    }
  }

  return {
    /**
     * What a create route checks after authorize and before its action: a
     * new preview's commit or tag (see requireForNew). Through core, a
     * refusal thrown inside an action can come back as a plain error.
     */
    async checkCreate(
      connectionId: number,
      uuid: string,
      raw: Record<string, unknown>,
    ): Promise<void> {
      const input = readPreviewCreate(raw);
      await onApplication(
        connectionId,
        uuid,
        "operate",
        undefined,
        (s, _appUuid, beforeFetch, app) =>
          requireForNew(s, app, input, beforeFetch),
      );
    },

    /**
     * The checks a change makes before anything else, for a route that
     * hands the work to an action: the permission, the connection (another
     * user's is not-found) and an operate grant, with no Coolify request,
     * then the application among the connection's own. Through core, a
     * refusal thrown inside an action can come back as a plain error, so a
     * route refuses here first.
     */
    async authorize(connectionId: number, uuid: string): Promise<void> {
      if (!(await ctx.rbac.has("operate"))) {
        throw new ConnectionError(
          "forbidden",
          "Changing previews and reading their logs need the Operate Coolify permission",
        );
      }
      await deployments.authorize(connectionId, "operate", uuid);
    },

    /** The application's previews, each with its newest build. */
    async list(
      connectionId: number,
      uuid: string,
      signal?: AbortSignal,
    ): Promise<{ rows: PreviewRow[] }> {
      const { snap, appUuid, answer } = await onApplication(
        connectionId,
        uuid,
        "view",
        signal,
        (s, app, beforeFetch) => s.api.previews(app, { beforeFetch }),
      );
      // The newest build per pull request, from the newest deployments. A
      // history Coolify won't answer leaves the builds out, not the list.
      const builds = new Map<number, { uuid: string; status: string }>();
      try {
        const page = await snap.api.deploymentPage(appUuid, {
          skip: 0,
          take: MAX_TAKE,
          beforeFetch: () => deployments.holds(connectionId, snap, "view"),
        });
        for (const d of page.rows) {
          if (d.pullRequestId > 0 && !builds.has(d.pullRequestId)) {
            builds.set(d.pullRequestId, { uuid: d.uuid, status: d.status });
          }
        }
      } catch (err) {
        if (!(err instanceof CoolifyError)) throw err;
      }
      await deployments.holds(connectionId, snap, "view");
      return {
        rows: answer.map(
          (p) =>
            redact({
              ...p,
              deploymentUuid: builds.get(p.pullRequestId)?.uuid ?? null,
              deploymentStatus: builds.get(p.pullRequestId)?.status ?? null,
            }) as PreviewRow,
        ),
      };
    },

    /** Opens (or redeploys) the preview of a pull request and queues it. */
    async create(
      connectionId: number,
      uuid: string,
      raw: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ pullRequestId: number; deploymentUuid: string | null }> {
      const input = readPreviewCreate(raw);
      const body: Record<string, unknown> = {
        pull_request_id: input.pullRequestId,
        instant_deploy: true,
        force: input.force,
      };
      if (input.pullRequestUrl) {
        body.pull_request_html_url = input.pullRequestUrl;
      }
      if (input.gitType) body.git_type = input.gitType;
      if (input.commit) body.commit = input.commit;
      if (input.dockerTag) body.docker_tag = input.dockerTag;
      const { answer, app, snap } = await onApplication(
        connectionId,
        uuid,
        "operate",
        signal,
        async (s, appUuid, beforeFetch, resource) => {
          await requireForNew(s, resource, input, beforeFetch);
          return changingQueue(connectionId, () =>
            s.api.createPreview(appUuid, body, { beforeFetch }),
          );
        },
      );
      // A preview deploy is a deployment of the application, of a pull
      // request: the shared post-start hook names the pull request. The
      // target is checked again after it, so nothing is awaited between that
      // check and the answer; an entry for a target that then changed stays.
      await deployments.deployed(connectionId, [
        {
          uuid: app.uuid,
          name: app.name,
          kind: app.kind,
          deploymentUuid: answer.deploymentUuid,
          serverUuid: app.serverUuid,
          pullRequestId: input.pullRequestId,
        },
      ]);
      await deployments.holds(connectionId, snap, "operate");
      return {
        pullRequestId: input.pullRequestId,
        deploymentUuid: answer.deploymentUuid,
      };
    },

    /** Deletes a preview: Coolify stops it and removes its containers. */
    async remove(
      connectionId: number,
      uuid: string,
      rawId: unknown,
      signal?: AbortSignal,
    ): Promise<{ pullRequestId: number }> {
      const pullRequestId = readPullRequestId(rawId);
      await onApplication(
        connectionId,
        uuid,
        "operate",
        signal,
        (s, app, beforeFetch) =>
          changingQueue(connectionId, () =>
            s.api.deletePreview(app, pullRequestId, { beforeFetch }),
          ),
      );
      return { pullRequestId };
    },

    /** Replaces a preview's domains, checked before anything is asked. */
    async setDomains(
      connectionId: number,
      uuid: string,
      rawId: unknown,
      raw: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ pullRequestId: number } & PreviewDomains> {
      const pullRequestId = readPullRequestId(rawId);
      const change = readPreviewDomains(raw);
      const body =
        "domains" in change
          ? { domains: change.domains }
          : { docker_compose_domains: change.composeDomains };
      await onApplication(
        connectionId,
        uuid,
        "operate",
        signal,
        (s, app, beforeFetch) =>
          s.api.updatePreviewDomains(app, pullRequestId, body, { beforeFetch }),
      );
      return { pullRequestId, ...change };
    },

    /**
     * A preview's container logs through Coolify, redacted as one stream
     * with the connection's own secrets. Needs operate: logs hold secrets.
     */
    async logs(
      connectionId: number,
      uuid: string,
      rawId: unknown,
      raw: { lines?: unknown; timestamps?: unknown },
      signal?: AbortSignal,
    ): Promise<{ pullRequestId: number; text: string }> {
      const pullRequestId = readPullRequestId(rawId);
      const request = readPreviewLogsRequest(raw);
      const { snap, answer } = await onApplication(
        connectionId,
        uuid,
        "operate",
        signal,
        (s, app, beforeFetch) =>
          s.api.previewLogs(app, pullRequestId, { ...request, beforeFetch }),
      );
      const secrets = await snap.secrets();
      await deployments.holds(connectionId, snap, "operate");
      return { pullRequestId, text: redactLogStream(answer, secrets) };
    },
  };
}

export type Previews = ReturnType<typeof createPreviews>;
