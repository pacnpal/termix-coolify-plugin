import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { REDACTED_VALUE } from "@termix-ssh/plugin-sdk/operations";
import type { Abilities } from "../connections/probe.js";
import { MIN_COOLIFY_VERSION } from "../connections/probe.js";
import {
  ConnectionError,
  type AccessLevel,
  type ConnectionView,
  type Connections,
} from "../connections/service.js";
import {
  EXCLUDED_OPERATIONS,
  OPERATIONS,
  type CoolifyOperation,
} from "../coolify/generated/operations.js";
import {
  OPERATION_SCHEMAS,
  type OperationSchema,
} from "../coolify/generated/schemas.js";
import { CoolifyError } from "../coolify/http.js";
import { meetsMinVersion } from "../coolify/version.js";
import { redact } from "../redact.js";
import { connectionIdInput } from "./connections.js";

export type CoolifyPermission =
  | "coolify.view"
  | "coolify.operate"
  | "coolify.configure"
  | "coolify.administer";

/** Grants stop at configure; the permissions table has a fifth tier. */
export type GrantLevel = "view" | "operate" | "configure";

export interface RequiredAccess {
  permission: CoolifyPermission;
  grant: GrantLevel;
}

/**
 * The two multipart upload operations. ctx.fetch only sends string bodies, so
 * they can't work through the plugin; imports use a server path or S3.
 */
export const UNSUPPORTED_UPLOADS: ReadonlySet<string> = new Set([
  "upload-database-import",
  "upload-service-database-import",
]);

export type ApiCallErrorCode =
  | "excluded"
  | "upload-unsupported"
  | "unknown-operation"
  | "not-a-read"
  | "forbidden"
  | "invalid-input"
  | "confirm-required"
  | "not-masked"
  | "secrets-unreadable";

const ERROR_STATUS: Record<ApiCallErrorCode, 400 | 403 | 404> = {
  excluded: 403,
  "upload-unsupported": 400,
  "unknown-operation": 404,
  "not-a-read": 400,
  forbidden: 403,
  "invalid-input": 400,
  "confirm-required": 400,
  "not-masked": 400,
  "secrets-unreadable": 403,
};

/** A refusal by the plugin itself, before asking Coolify. */
export class ApiCallError extends Error {
  readonly code: ApiCallErrorCode;
  readonly status: 400 | 403 | 404;

  constructor(code: ApiCallErrorCode, message: string) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]));

const SEGMENT = "\\{[^}]+\\}";
const CLOUD =
  /^\/(cloud-tokens|cloud-init-scripts|hetzner|digitalocean|vultr|hostinger)(\/|$)/;
const CLOUD_SERVER = /^\/servers\/(hetzner|digitalocean|vultr|hostinger)$/;
const SERVER_TRANSFER_START = new RegExp(
  `^/servers/${SEGMENT}/(migrate|transfer/complete)$`,
);
const SERVER_TRANSFER_STATUS = new RegExp(`^/servers/${SEGMENT}/transfer$`);
const INSTANCE_SETTINGS = /^\/(settings|mcp)(\/|$)|^\/(enable|disable)$/;
const DEPLOYMENT_CANCEL = new RegExp(`^/deployments/${SEGMENT}/cancel$`);
const TASK_RUN = new RegExp(`/scheduled-tasks/${SEGMENT}/execute$`);
const IMPORT_STATUS = new RegExp(`/imports/${SEGMENT}$`);
const ROLLBACK = new RegExp(`^/applications/${SEGMENT}/rollback$`);

/**
 * Deletes; starting a server create, transfer, migration or import; cloud
 * provisioning and cloud tokens; instance settings, the API and MCP switches.
 */
function isAdminister(op: CoolifyOperation): boolean {
  const { method, path } = op;
  if (method === "DELETE") return true;
  if (
    method === "POST" &&
    (path === "/servers" || path === "/servers/import")
  ) {
    return true;
  }
  if (method !== "GET" && SERVER_TRANSFER_START.test(path)) return true;
  if (CLOUD.test(path) || CLOUD_SERVER.test(path)) return true;
  return INSTANCE_SETTINGS.test(path);
}

/**
 * Lifecycle, deploys, cancels, running a task or a backup, and reads whose
 * answer carries log or command output.
 */
function isOperate(op: CoolifyOperation): boolean {
  const { method, path } = op;
  if (path.endsWith("/logs")) return true;
  if (method === "GET") {
    return (
      path === "/deployments" ||
      path.startsWith("/deployments/") ||
      path.endsWith("/executions") ||
      SERVER_TRANSFER_STATUS.test(path) ||
      // Judgement: an import's status holds the import command's output.
      IMPORT_STATUS.test(path)
    );
  }
  if (method !== "POST") return false;
  return (
    /\/(start|stop|restart)$/.test(path) ||
    path === "/deploy" ||
    DEPLOYMENT_CANCEL.test(path) ||
    TASK_RUN.test(path) ||
    path.endsWith("/backups/run") ||
    // Judgement: a rollback queues a deployment of an earlier image.
    ROLLBACK.test(path)
  );
}

function classify(op: CoolifyOperation): RequiredAccess {
  if (isAdminister(op)) {
    return { permission: "coolify.administer", grant: "configure" };
  }
  if (isOperate(op)) return { permission: "coolify.operate", grant: "operate" };
  if (op.method === "GET") return { permission: "coolify.view", grant: "view" };
  return { permission: "coolify.configure", grant: "configure" };
}

function refuseExcluded(operationId: string): void {
  if (EXCLUDED_OPERATIONS.has(operationId)) {
    throw new ApiCallError(
      "excluded",
      `${operationId} is never run through Termix: it would lock the plugin out of Coolify`,
    );
  }
}

function known(operationId: string): CoolifyOperation {
  const op = BY_ID.get(operationId);
  if (!op) {
    throw new ApiCallError(
      "unknown-operation",
      `${operationId} is not a Coolify operation the plugin knows`,
    );
  }
  return op;
}

/**
 * The Termix permission and the grant level a Coolify operation needs, by the
 * design's Permissions table. Checked in order, first match wins: excluded
 * (throws), administer, operate (including reads that carry log or command
 * output), any other GET (view), and everything left (configure). An
 * administer operation needs a configure grant, or ownership.
 */
export function requiredAccess(operationId: string): RequiredAccess {
  refuseExcluded(operationId);
  return classify(known(operationId));
}

const RANK: Record<GrantLevel, number> = { view: 1, operate: 2, configure: 3 };

/** Whether the actor's access to a connection reaches a grant level. */
export function grantMeets(access: AccessLevel, need: GrantLevel): boolean {
  return access === "owner" || RANK[access] >= RANK[need];
}

/**
 * What can be told of the token's ability before asking: it answered the
 * probe, and Coolify's log endpoints need read:sensitive. Coolify checks
 * everything else itself, and a refusal comes back as forbidden-ability.
 */
export function tokenAllows(op: CoolifyOperation, abilities: Abilities) {
  if (!abilities.read) return false;
  if (op.path.endsWith("/logs")) return abilities.sensitive || abilities.root;
  return true;
}

/** The connection's Coolify version; one never read counts as the floor. */
function versionOf(connection: ConnectionView): string {
  return connection.version ?? MIN_COOLIFY_VERSION;
}

/** The oldest Coolify whose spec documents the operation. */
function documentedFrom(op: CoolifyOperation): string {
  return op.source === "4.7.5" ? "4.7.5" : op.minVersion;
}

export interface ApiOperationView extends OperationSchema {
  id: string;
  method: CoolifyOperation["method"];
  path: string;
  minVersion: string;
  permission: CoolifyPermission;
}

export interface ApiCallInput {
  connectionId: number;
  operationId: string;
  /** Path and query parameters: an object, or its JSON text. */
  params?: unknown;
  /** The JSON body: a value, or its JSON text. */
  body?: unknown;
}

/** What a generic call records and answers. Never holds a secret. */
export interface ApiCallResult {
  method: CoolifyOperation["method"];
  operationId: string;
  path: string;
  /** The parameters and body sent, redacted. */
  request: { params: unknown; body?: unknown };
  /** Coolify's answer, redacted. */
  data: unknown;
}

function invalid(message: string): ApiCallError {
  return new ApiCallError("invalid-input", message);
}

function parseJson(value: unknown, field: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw invalid(`${field} must be JSON`);
  }
}

function parseParams(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value, "params");
  if (parsed === undefined) return {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid("params must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

type Scalar = string | number | boolean;

function scalar(value: unknown, name: string): Scalar {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw invalid(`${name} must be a string, number or boolean`);
}

/** The filled-in path and the query, from the operation's own parameters. */
function buildRequest(
  op: CoolifyOperation,
  params: Record<string, unknown>,
): { path: string; query: Record<string, Scalar> } {
  const declared = OPERATION_SCHEMAS[op.id]?.params ?? [];
  const pathNames = new Set(
    declared.filter((p) => p.in === "path").map((p) => p.name),
  );
  const queryNames = new Set(
    declared.filter((p) => p.in === "query").map((p) => p.name),
  );
  for (const key of Object.keys(params)) {
    if (!pathNames.has(key) && !queryNames.has(key)) {
      throw invalid(`${key} is not a parameter of ${op.id}`);
    }
  }
  const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw invalid(`${name} is required`);
    }
    return encodeURIComponent(String(scalar(value, name)));
  });
  const query: Record<string, Scalar> = {};
  for (const name of queryNames) {
    const value = params[name];
    if (value !== undefined && value !== null && value !== "") {
      query[name] = scalar(value, name);
    }
  }
  for (const param of declared) {
    if (
      param.in === "query" &&
      param.required &&
      query[param.name] === undefined
    ) {
      throw invalid(`${param.name} is required`);
    }
  }
  return { path, query };
}

/** Follows a path of keys and indexes; undefined when it leads nowhere. */
function at(value: unknown, pointer: readonly (string | number)[]): unknown {
  let current = value;
  for (const step of pointer) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[String(step)];
  }
  return current;
}

/** The paths of every masked value in a redacted answer. */
export function maskedPaths(
  value: unknown,
  prefix: (string | number)[] = [],
  out: (string | number)[][] = [],
): (string | number)[][] {
  if (value === REDACTED_VALUE) {
    out.push(prefix);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => maskedPaths(item, [...prefix, i], out));
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      maskedPaths(inner, [...prefix, key], out);
    }
  }
  return out;
}

/**
 * The generic Coolify API: any vendored operation, with the three-way
 * minimum applied before Coolify is asked (the operation's own Termix
 * permission, the grant level or ownership, and what is known of the token;
 * Coolify checks the rest of the token's abilities itself).
 */
export function createGenericApi(ctx: PluginContext, connections: Connections) {
  async function holds(permission: CoolifyPermission): Promise<boolean> {
    return ctx.rbac.has(permission);
  }

  async function authorize(
    connectionId: number,
    operationId: string,
    opts: { readOnly?: boolean } = {},
  ): Promise<{ op: CoolifyOperation; connection: ConnectionView }> {
    refuseExcluded(operationId);
    if (UNSUPPORTED_UPLOADS.has(operationId)) {
      throw new ApiCallError(
        "upload-unsupported",
        "File uploads can't go through the plugin. Import from a path on the server or from S3 instead (create-database-import).",
      );
    }
    const op = known(operationId);
    if (opts.readOnly && op.method !== "GET") {
      throw new ApiCallError(
        "not-a-read",
        `${operationId} is not a read; use coolify.api-call`,
      );
    }
    const access = classify(op);
    if (!(await holds(access.permission))) {
      throw new ApiCallError(
        "forbidden",
        `${operationId} needs the ${access.permission} permission`,
      );
    }
    const connection = await connections.get(connectionId);
    if (!connection) {
      throw new ConnectionError("not-found", "Coolify connection not found");
    }
    if (!grantMeets(connection.access, access.grant)) {
      throw new ApiCallError(
        "forbidden",
        `${operationId} needs ${access.grant} access to this connection`,
      );
    }
    if (!meetsMinVersion(versionOf(connection), op.minVersion)) {
      throw new CoolifyError("unsupported-by-instance", 0);
    }
    return { op, connection };
  }

  async function send(
    op: CoolifyOperation,
    connection: ConnectionView,
    params: Record<string, unknown>,
    body: unknown,
  ): Promise<unknown> {
    const { path, query } = buildRequest(op, params);
    const http = await connections.http(connection.id);
    try {
      return await http.request<unknown>(op.method, path, {
        query,
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      // Feature detection: an instance older than the spec that documents the
      // operation answers 404 when it doesn't have the endpoint (405 is mapped
      // by the request layer already).
      if (
        err instanceof CoolifyError &&
        err.cause === "not-found" &&
        !meetsMinVersion(versionOf(connection), documentedFrom(op))
      ) {
        throw new CoolifyError("unsupported-by-instance", err.status);
      }
      throw err;
    }
  }

  return {
    /** The connection as the actor reaches it, or a 404. */
    async connection(connectionId: number): Promise<ConnectionView> {
      const connection = await connections.get(connectionId);
      if (!connection) {
        throw new ConnectionError("not-found", "Coolify connection not found");
      }
      return connection;
    },

    /** Calls one operation. `readOnly` refuses anything but GET. */
    async dispatch(
      input: ApiCallInput,
      opts: { readOnly?: boolean } = {},
    ): Promise<ApiCallResult> {
      const { op, connection } = await authorize(
        input.connectionId,
        input.operationId,
        opts,
      );
      const params = parseParams(input.params);
      const body = parseJson(input.body, "body");
      if (op.method === "GET" && body !== undefined) {
        throw invalid(`${op.id} takes no body`);
      }
      const answer = await send(op, connection, params, body);
      return {
        method: op.method,
        operationId: op.id,
        path: op.path,
        request: redact({
          params,
          ...(body !== undefined ? { body } : {}),
        }) as ApiCallResult["request"],
        data: redact(answer ?? null),
      };
    },

    /**
     * The operations the actor may call: on one connection, or on any they
     * reach when none is given. Hides excluded and upload operations, those
     * newer than the connection's Coolify, and those above the actor's
     * permission, grant or token.
     */
    async list(
      connectionId: number | null,
      opts: { readsOnly?: boolean } = {},
    ): Promise<ApiOperationView[]> {
      const reachable =
        connectionId === null
          ? await connections.list()
          : [await connections.get(connectionId)].filter(
              (c): c is ConnectionView => c !== null,
            );
      if (!reachable.length) return [];
      const held = new Map<CoolifyPermission, boolean>();
      const out: ApiOperationView[] = [];
      for (const op of OPERATIONS) {
        if (EXCLUDED_OPERATIONS.has(op.id) || UNSUPPORTED_UPLOADS.has(op.id)) {
          continue;
        }
        if (opts.readsOnly && op.method !== "GET") continue;
        const access = classify(op);
        if (!held.has(access.permission)) {
          held.set(access.permission, await holds(access.permission));
        }
        if (!held.get(access.permission)) continue;
        const usable = reachable.some(
          (c) =>
            grantMeets(c.access, access.grant) &&
            meetsMinVersion(versionOf(c), op.minVersion) &&
            tokenAllows(op, c.abilities),
        );
        if (!usable) continue;
        out.push({
          id: op.id,
          method: op.method,
          path: op.path,
          minVersion: op.minVersion,
          permission: access.permission,
          ...OPERATION_SCHEMAS[op.id],
        });
      }
      return out;
    },

    /**
     * Reads one masked value of a GET operation's answer, fresh from Coolify.
     * Needs coolify.configure, configure access (or ownership) and a token
     * that reads secrets. Audited; nothing is kept.
     */
    async reveal(
      input: ApiCallInput & { pointer: (string | number)[] },
    ): Promise<string> {
      const { op, connection } = await authorize(
        input.connectionId,
        input.operationId,
        { readOnly: true },
      );
      if (
        !(await holds("coolify.configure")) ||
        !grantMeets(connection.access, "configure")
      ) {
        throw new ApiCallError(
          "forbidden",
          "Revealing a value needs the coolify.configure permission and configure access",
        );
      }
      if (!connection.abilities.sensitive && !connection.abilities.root) {
        throw new ApiCallError(
          "secrets-unreadable",
          "This connection's token can't read secrets (read:sensitive)",
        );
      }
      const params = parseParams(input.params);
      const details = `${op.id} ${input.pointer.join("/")}`;
      let answer: unknown;
      try {
        answer = await send(op, connection, params, undefined);
      } catch (err) {
        await ctx.audit.record({
          action: "coolify.api.reveal",
          resourceType: "coolify-connection",
          resourceId: String(connection.id),
          resourceName: connection.name,
          details,
          success: false,
        });
        throw err;
      }
      const value = at(answer, input.pointer);
      if (
        value === undefined ||
        value === null ||
        at(redact(answer), input.pointer) !== REDACTED_VALUE
      ) {
        throw new ApiCallError("not-masked", "That value is not a masked one");
      }
      await ctx.audit.record({
        action: "coolify.api.reveal",
        resourceType: "coolify-connection",
        resourceId: String(connection.id),
        resourceName: connection.name,
        details,
        success: true,
      });
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

export type GenericApi = ReturnType<typeof createGenericApi>;

/** The optional connectionId of a list action: null lists every connection. */
function optionalConnection(input: Record<string, unknown>): number | null {
  const raw = input.connectionId;
  if (raw === undefined || raw === null || raw === "") return null;
  return connectionIdInput(input);
}

function listResult(rows: ApiOperationView[]) {
  return {
    summary: `${rows.length} Coolify API operation${rows.length === 1 ? "" : "s"}`,
    data: {
      options: rows.map((op) => ({
        value: op.id,
        label: `${op.method} ${op.path}${op.summary ? ` (${op.summary})` : ""}`,
      })),
      rows: rows.map(({ id, method, path, minVersion, permission }) => ({
        id,
        method,
        path,
        minVersion,
        permission,
      })),
    },
  };
}

function operationIdInput(input: Record<string, unknown>): string {
  const id = input.operationId;
  if (typeof id !== "string" || !id) throw invalid("operationId is required");
  return id;
}

/**
 * coolify.api-read, coolify.api-call and their pickers. params and body are
 * declared `secret`, so core never stores them; summaries and data hold only
 * the method, operation, path and the redacted request.
 */
export function registerGenericApiOperations(
  ctx: PluginContext,
  api: GenericApi,
): void {
  ctx.operations.register("coolify.list-api-reads", {
    run: async (input) =>
      listResult(
        await api.list(optionalConnection(input), { readsOnly: true }),
      ),
  });

  ctx.operations.register("coolify.list-api-operations", {
    run: async (input) => listResult(await api.list(optionalConnection(input))),
  });

  ctx.operations.register("coolify.api-read", {
    run: async (input) => {
      const operationId = operationIdInput(input);
      refuseExcluded(operationId);
      const result = await api.dispatch(
        {
          connectionId: connectionIdInput(input),
          operationId,
          params: input.params,
        },
        { readOnly: true },
      );
      return {
        summary: `Read ${result.operationId} (${result.method} ${result.path})`,
        data: result,
      };
    },
  });

  ctx.operations.register("coolify.api-call", {
    run: async (input) => {
      const operationId = operationIdInput(input);
      refuseExcluded(operationId);
      const result = await api.dispatch({
        connectionId: connectionIdInput(input),
        operationId,
        params: input.params,
        body: input.body,
      });
      return {
        summary: `Called ${result.operationId} (${result.method} ${result.path})`,
        changed: result.method !== "GET",
        data: result,
      };
    },
  });
}
