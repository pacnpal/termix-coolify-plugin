import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { DeploymentDto, ResourceDto } from "../coolify/dto.js";
import {
  ConnectionError,
  type AccessLevel,
  type Connections,
} from "../connections/service.js";
import { redact } from "../redact.js";
import type { Resources } from "../resources/service.js";
import {
  isCancellableDeployment,
  isFinalDeployment,
} from "../../shared/deployment-status.js";
import { buildLog, type BuildLog } from "./log.js";

/** A deployment that can't be cancelled any more (it ended). */
export class DeploymentError extends Error {
  readonly code = "deployment-ended";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "DeploymentError";
  }
}

/** Rows a history page has unless asked for another count. */
export const DEFAULT_TAKE = 10;
/** The most rows one history page may ask for. */
export const MAX_TAKE = 50;

export interface Paging {
  skip: number;
  take: number;
}

export interface DeploymentPage extends Paging {
  rows: DeploymentDto[];
  /** Coolify's total for the application, when it sends one. */
  count: number | null;
}

export interface DeploymentDetail {
  deployment: DeploymentDto;
  /** Parsed and redacted; null when the token can't read build logs. */
  log: BuildLog | null;
  /** Nothing more will change: polling can stop. */
  final: boolean;
  cancellable: boolean;
}

type Level = "view" | "operate";
type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

const RANK: Record<AccessLevel, number> = {
  view: 0,
  operate: 1,
  configure: 2,
  owner: 3,
};

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

function count(value: unknown, name: string, min: number, max: number) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,6}$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConnectionError(
      "invalid-input",
      `${name} must be a whole number from ${min} to ${max}`,
    );
  }
  return n;
}

/** `skip` and `take` from a query or an operation input, checked. */
export function readPaging(input: { skip?: unknown; take?: unknown }): Paging {
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  return {
    skip: given(input.skip) ? count(input.skip, "skip", 0, 1_000_000) : 0,
    take: given(input.take)
      ? count(input.take, "take", 1, MAX_TAKE)
      : DEFAULT_TAKE,
  };
}

const forbidden = (message: string) =>
  new ConnectionError("forbidden", message);
const noApplication = () =>
  new ConnectionError("not-found", "Coolify application not found");
const noDeployment = () =>
  new ConnectionError("not-found", "Coolify deployment not found");

/** Deployment rows with credentials inside any URL masked (commit messages). */
function clean(row: DeploymentDto): DeploymentDto {
  return redact(row) as DeploymentDto;
}

export interface DeploymentsDeps {
  connections: Connections;
  resources: Resources;
}

/**
 * Deployment history, one deployment with its build log, and cancel, for
 * routes and operations alike. Each reads the connection once and checks,
 * after every await and right before each Coolify request, that it still
 * points at the same target and that the actor's grant still reaches the
 * level the call needs: view for history, operate for a build log (it holds
 * secrets) and for cancel. A deployment counts only when it belongs to one
 * of that connection's own applications.
 */
export function createDeployments(ctx: PluginContext, deps: DeploymentsDeps) {
  const { connections, resources } = deps;

  async function open(connectionId: number, level: Level): Promise<Snapshot> {
    if (!(await ctx.rbac.has(level))) {
      throw forbidden(
        level === "view"
          ? "Deployments need the View Coolify permission"
          : "Build logs and cancelling need the Operate Coolify permission",
      );
    }
    // Another user's connection is not-found here.
    const snap = await connections.snapshot(connectionId);
    if (RANK[snap.view.access] < RANK[level]) {
      throw forbidden("Your access to this connection doesn't allow this");
    }
    return snap;
  }

  /**
   * Fails closed unless the connection still points at the snapshot's
   * target and the actor's grant still reaches `level`: a grant lowered
   * mid-way leaves the revision as it was.
   */
  async function holds(
    connectionId: number,
    snap: Snapshot,
    level: Level,
  ): Promise<void> {
    if ((await connections.revision(connectionId)) !== snap.view.revision) {
      throw new ConnectionError(
        "target-changed",
        "The connection's address, token or Access settings changed. Try again.",
      );
    }
    const access = await connections.access(connectionId);
    if (!access) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    if (RANK[access] < RANK[level]) {
      throw forbidden("Your access to this connection doesn't allow this");
    }
  }

  /** One of the connection's own applications (only they have deployments). */
  async function application(
    connectionId: number,
    uuid: string,
  ): Promise<ResourceDto> {
    if (!UUID.test(uuid)) throw noApplication();
    const found =
      (await resources.get(connectionId, uuid)) ??
      (await resources.get(connectionId, uuid, { refresh: true }));
    if (!found || found.kind !== "application") throw noApplication();
    return found;
  }

  /**
   * One deployment and its raw log, once it is known to belong to
   * `resourceUuid`, or (without one) to one of the connection's own
   * applications. Coolify answers for any deployment of its team, so the
   * deployment's own link decides; one that names no application is
   * not-found.
   */
  async function read(
    connectionId: number,
    snap: Snapshot,
    level: Level,
    deploymentUuid: string,
    opts: { resourceUuid?: string; signal?: AbortSignal },
  ): Promise<{ deployment: DeploymentDto; log: string | null }> {
    if (!UUID.test(deploymentUuid)) throw noDeployment();
    const expected =
      opts.resourceUuid !== undefined
        ? await application(connectionId, opts.resourceUuid)
        : null;
    await holds(connectionId, snap, level);
    opts.signal?.throwIfAborted();
    const answer = await snap.api.deploymentWithLog(deploymentUuid, {
      beforeFetch: () => holds(connectionId, snap, level),
    });
    await holds(connectionId, snap, level);
    const owner = answer.deployment.resourceUuid;
    if (!owner || answer.deployment.uuid !== deploymentUuid) {
      throw noDeployment();
    }
    if (expected) {
      if (owner !== expected.uuid) throw noDeployment();
    } else {
      try {
        await application(connectionId, owner);
      } catch {
        throw noDeployment();
      }
      await holds(connectionId, snap, level);
    }
    return answer;
  }

  return {
    holds,
    open,
    application,

    /** One page of an application's deployments, newest first. */
    async list(
      connectionId: number,
      uuid: string,
      paging: Paging,
      signal?: AbortSignal,
    ): Promise<DeploymentPage> {
      const snap = await open(connectionId, "view");
      const app = await application(connectionId, uuid);
      await holds(connectionId, snap, "view");
      signal?.throwIfAborted();
      const page = await snap.api.deploymentPage(app.uuid, {
        ...paging,
        beforeFetch: () => holds(connectionId, snap, "view"),
      });
      await holds(connectionId, snap, "view");
      return { ...paging, count: page.count, rows: page.rows.map(clean) };
    },

    /**
     * One deployment with its build log, parsed and redacted (hidden lines
     * included and marked). Needs operate: build logs hold secrets.
     */
    async get(
      connectionId: number,
      deploymentUuid: string,
      opts: { resourceUuid?: string; signal?: AbortSignal } = {},
    ): Promise<DeploymentDetail> {
      const snap = await open(connectionId, "operate");
      const { deployment, log } = await read(
        connectionId,
        snap,
        "operate",
        deploymentUuid,
        opts,
      );
      const secrets = log === null ? [] : await snap.secrets();
      await holds(connectionId, snap, "operate");
      return {
        deployment: clean(deployment),
        log: log === null ? null : buildLog(log, secrets),
        final: isFinalDeployment(deployment.status),
        cancellable: isCancellableDeployment(deployment.status),
      };
    },

    /**
     * Cancels a queued or running deployment. Refused before Coolify is
     * asked when the run is cancelled, the deployment already ended, or the
     * connection or the actor's grant changed while it was being read.
     */
    async cancel(
      connectionId: number,
      deploymentUuid: string,
      opts: { resourceUuid?: string; signal?: AbortSignal } = {},
    ): Promise<{ deploymentUuid: string; status: string }> {
      const snap = await open(connectionId, "operate");
      const { deployment } = await read(
        connectionId,
        snap,
        "operate",
        deploymentUuid,
        opts,
      );
      if (!isCancellableDeployment(deployment.status)) {
        throw new DeploymentError(
          `This deployment already ended (${deployment.status})`,
        );
      }
      opts.signal?.throwIfAborted();
      let answer: { status: string | null };
      try {
        answer = await snap.api.cancelDeployment(deploymentUuid, {
          beforeFetch: async () => {
            await holds(connectionId, snap, "operate");
            opts.signal?.throwIfAborted();
          },
        });
      } finally {
        // The resource's status changes with its deployment.
        await resources.invalidate(connectionId);
      }
      await holds(connectionId, snap, "operate");
      return { deploymentUuid, status: answer.status ?? "cancelled-by-user" };
    },
  };
}

export type Deployments = ReturnType<typeof createDeployments>;
