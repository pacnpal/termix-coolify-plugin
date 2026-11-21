import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import {
  redactFields,
  type OperationAction,
} from "@termix-ssh/plugin-sdk/operations";
import { redact } from "./redact.js";
import { takeLogText } from "./ops/containers.js";

export const CLIENT_SERVICE = "coolify.client";

/** What every method answers: plain data, never a token, client or key. */
export interface ClientResult {
  runId: string | null;
  status: string;
  summary?: string;
  changed?: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  approvalId?: string;
}

export type LifecycleVerb = "start" | "stop" | "restart";

/**
 * The `coolify.client` service other plugins get with
 * `ctx.services.get("coolify.client")`. Each method is one Termix operation
 * run as the calling user through `ctx.operations.run`, so their permission,
 * approvals, confirms and run history apply; nothing here reaches Coolify
 * itself.
 */
export interface CoolifyClient {
  listConnections(): Promise<ClientResult>;
  listResources(connectionId: string): Promise<ClientResult>;
  deploy(
    connectionId: string,
    uuid: string,
    opts?: { force?: boolean },
  ): Promise<ClientResult>;
  /** start and stop are destructive: they need `{ confirmed: true }`. */
  lifecycle(
    connectionId: string,
    uuid: string,
    action: LifecycleVerb,
    opts?: { confirmed?: boolean },
  ): Promise<ClientResult>;
  apiRead(
    connectionId: string,
    operationId: string,
    params?: Record<string, unknown>,
  ): Promise<ClientResult>;
  /** Log output is a read of private text: it needs `{ confirmed: true }`. */
  logsTail(
    connectionId: string,
    uuid: string,
    lines?: number,
    opts?: { confirmed?: boolean },
  ): Promise<ClientResult>;
}

export class ClientError extends Error {
  constructor(
    readonly code: "forbidden" | "confirm-required" | "invalid-input",
    message: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

const VERBS: Record<LifecycleVerb, string> = {
  start: "coolify.resource-action",
  stop: "coolify.resource-action",
  restart: "coolify.resource-restart",
};

/** A JSON copy: only plain data crosses to the calling plugin. */
function plain(outcome: ClientResult): ClientResult {
  return JSON.parse(JSON.stringify(outcome)) as ClientResult;
}

export function createClient(ctx: PluginContext): CoolifyClient {
  const actions = new Map(
    (
      (ctx.manifest.contributes?.operations?.actions ?? []) as OperationAction[]
    ).map((a) => [a.id, a]),
  );

  async function run(
    id: string,
    input: Record<string, unknown>,
    confirmed = false,
  ): Promise<ClientResult> {
    const action = actions.get(id)!;
    // Core's gate checks this too; checking here first means a caller
    // without it never starts a run, whatever runs the service.
    if (!ctx.currentActor() || !(await ctx.rbac.has(action.permission))) {
      throw new ClientError(
        "forbidden",
        `This needs the coolify.${action.permission} permission`,
      );
    }
    if (action.risk === "destructive" && !confirmed) {
      throw new ClientError(
        "confirm-required",
        `${id} is destructive: pass { confirmed: true } once a person agreed`,
      );
    }
    const options: PluginOperationInvokeOptions = {
      input,
      dryRun: false,
      via: "service",
      ...(action.risk === "destructive" ? { confirmed: true } : {}),
    };
    const outcome: PluginOperationOutcome = await ctx.operations.run(
      id,
      options,
    );
    let data = redactFields(action.outputs, outcome.data);
    if (id === "coolify.logs-tail" && data && typeof data === "object") {
      // The redacted text is a sensitive output, dropped from run history;
      // the caller who ran it gets it here, once, as MCP does.
      const text = takeLogText(
        ctx.currentActor() ?? "",
        (outcome.data as { handoffId?: unknown }).handoffId,
      );
      if (text !== null) data = { ...(data as object), text };
    }
    return plain({
      ...outcome,
      ...(outcome.data === undefined ? {} : { data: redact(data) }),
    });
  }

  return {
    listConnections: () => run("coolify.list-connections", {}),
    listResources: (connectionId) =>
      run("coolify.list-resources-all", { connectionId }),
    deploy: (connectionId, uuid, opts = {}) =>
      run("coolify.resource-deploy", {
        connectionId,
        uuid,
        force: opts.force === true,
        wait: false,
      }),
    lifecycle: (connectionId, uuid, action, opts = {}) => {
      const id = VERBS[action];
      if (!id) {
        return Promise.reject(
          new ClientError("invalid-input", "action is start, stop or restart"),
        );
      }
      return run(
        id,
        id === "coolify.resource-action"
          ? { connectionId, uuid, action }
          : { connectionId, uuid },
        opts.confirmed === true,
      );
    },
    apiRead: (connectionId, operationId, params = {}) =>
      run("coolify.api-read", {
        connectionId,
        operationId,
        params: JSON.stringify(params),
      }),
    logsTail: (connectionId, uuid, lines = 100, opts = {}) =>
      run("coolify.logs-tail", {
        connectionId,
        uuid,
        lines,
        confirm: opts.confirmed === true,
      }),
  };
}

/** Offers `coolify.client` to other plugins (manifest `provides`). */
export function provideClient(ctx: PluginContext): void {
  ctx.services.provide(CLIENT_SERVICE, createClient(ctx));
}
