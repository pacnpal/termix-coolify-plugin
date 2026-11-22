import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
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
  LOG_FIELDS,
  LOG_PURPOSE,
  TEXT_ANSWERS,
  type OperationSchema,
} from "../coolify/generated/schemas.js";
import { CoolifyError } from "../coolify/http.js";
import { fillPath, pathRules } from "../coolify/path.js";
import { meetsMinVersion } from "../coolify/version.js";
import { isMasked, maskKeys, redact } from "../redact.js";
import type { Resources } from "../resources/service.js";
import type { ServerStatuses } from "./signals.js";
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
  | "secrets-unreadable"
  | "token-ability";

const ERROR_STATUS: Record<ApiCallErrorCode, 400 | 403 | 404 | 409> = {
  excluded: 403,
  "upload-unsupported": 400,
  "unknown-operation": 404,
  "not-a-read": 400,
  forbidden: 403,
  "invalid-input": 400,
  "confirm-required": 400,
  "not-masked": 400,
  // The token's ability, not the user's access: like Coolify refusing it.
  "secrets-unreadable": 409,
  "token-ability": 409,
};

/** A refusal by the plugin itself, before asking Coolify. */
export class ApiCallError extends Error {
  readonly code: ApiCallErrorCode;
  readonly status: 400 | 403 | 404 | 409;

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
  // Reads for logs or command output, from the response schemas:
  // deployments, executions and import status among them.
  if (LOG_PURPOSE.has(op.id)) return true;
  if (method === "GET") {
    // Judgement: a transfer's status holds the migration log and error.
    return SERVER_TRANSFER_STATUS.test(path);
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

/**
 * Paths whose requests or answers carry secrets: env values, private keys,
 * cloud and integration tokens, secret-manager references, logs (which need
 * read:sensitive), notification and SMTP settings, S3 and registry
 * credentials, and GitHub and GitLab app secrets.
 */
const SECRET_PATH =
  /\/envs(\/|$)|^\/security\/|^\/cloud-tokens(\/|$)|\/secret-manager(\/|$)|\/logs$|^\/notifications\/|^\/settings\/email$|^\/s3-storages(\/|$)|\/registries(\/|$)|^\/(github|gitlab)-apps(\/|$)/;

function sensitiveOp(op: CoolifyOperation): boolean {
  return (
    op.method === "DELETE" ||
    SECRET_PATH.test(op.path) ||
    // A read for logs or command output (the generator's rule).
    LOG_PURPOSE.has(op.id)
  );
}

/**
 * Deletes and operations that read or write secrets. They run only when the
 * caller explicitly allowed it (`confirmed`), never through coolify.api-read,
 * which MCP runs as a read without "Allow changes over MCP".
 */
export function isSensitive(operationId: string): boolean {
  return sensitiveOp(known(operationId));
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
export function versionOf(connection: ConnectionView): string {
  return connection.version ?? MIN_COOLIFY_VERSION;
}

/** The oldest Coolify whose spec documents the operation. */
export function documentedFrom(op: CoolifyOperation): string {
  return op.source === "4.7.5" ? "4.7.5" : op.minVersion;
}

export interface ApiOperationView extends OperationSchema {
  id: string;
  method: CoolifyOperation["method"];
  path: string;
  minVersion: string;
  permission: CoolifyPermission;
  /** A delete, or an operation that reads or writes secrets. */
  sensitive: boolean;
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

/** An array query parameter: a list of scalars (or one scalar). */
function listOf(value: unknown, name: string): Scalar[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => scalar(item, `${name} items`));
}

/** The filled-in path and the query, from the operation's own parameters. */
function buildRequest(
  op: CoolifyOperation,
  params: Record<string, unknown>,
): { path: string; query: Record<string, Scalar | Scalar[]> } {
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
  // Each value must stay one segment, or the request would reach another
  // operation than the one whose access was checked.
  const path = fillPath(op.path, params, pathRules(op.id), invalid);
  const query: Record<string, Scalar | Scalar[]> = {};
  const arrays = new Set(
    declared
      .filter((p) => p.in === "query" && p.type === "array")
      .map((p) => p.name),
  );
  for (const name of queryNames) {
    const value = params[name];
    if (value !== undefined && value !== null && value !== "") {
      // The spec's arrays are form style, exploded: one name=value per item.
      query[name] = arrays.has(name)
        ? listOf(value, name)
        : scalar(value, name);
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

/**
 * The body as sent: only the top-level fields the operation declares, so
 * nothing the spec doesn't list reaches Coolify. An operation without a JSON
 * body gets none.
 */
function shapeBody(op: CoolifyOperation, body: unknown): unknown {
  const fields = OPERATION_SCHEMAS[op.id]?.body;
  if (body === undefined || !fields) return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("body must be a JSON object");
  }
  const given = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(given, field.name)) out[field.name] = given[field.name];
  }
  return out;
}

/** An operation's log and output fields, by its response schema. */
function logFieldsOf(op: CoolifyOperation): readonly string[] {
  return LOG_FIELDS[op.id] ?? [];
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
  if (isMasked(value)) {
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
export interface GenericApiDeps {
  connections: Connections;
  resources: Pick<Resources, "invalidate">;
  servers: Pick<ServerStatuses, "invalidate">;
}

export function createGenericApi(ctx: PluginContext, deps: GenericApiDeps) {
  const { connections } = deps;
  async function holds(permission: CoolifyPermission): Promise<boolean> {
    return ctx.rbac.has(permission);
  }

  type Snapshot = Awaited<ReturnType<Connections["snapshot"]>>;

  /**
   * The operation-level checks, then one read of the connection: everything
   * after is about that snapshot's target.
   */
  async function authorize(
    connectionId: number,
    operationId: string,
    opts: { readOnly?: boolean } = {},
  ): Promise<{ op: CoolifyOperation; snap: Snapshot }> {
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
    const snap = await connections.snapshot(connectionId);
    if (!grantMeets(snap.view.access, access.grant)) {
      throw new ApiCallError(
        "forbidden",
        `${operationId} needs ${access.grant} access to this connection`,
      );
    }
    if (!meetsMinVersion(versionOf(snap.view), op.minVersion)) {
      throw new CoolifyError("unsupported-by-instance", 0);
    }
    if (!tokenAllows(op, snap.view.abilities)) {
      throw new ApiCallError(
        "token-ability",
        `This connection's token can't run ${operationId} (it needs read, and read:sensitive for logs)`,
      );
    }
    return { op, snap };
  }

  /** Fails closed unless the connection still points at the snapshot's target. */
  async function assertSnapshotHolds(snap: Snapshot): Promise<void> {
    if ((await connections.revision(snap.view.id)) !== snap.view.revision) {
      throw new ConnectionError(
        "target-changed",
        "The connection's address, token or Access settings changed. Run it again.",
      );
    }
  }

  async function send(
    op: CoolifyOperation,
    snap: Snapshot,
    params: Record<string, unknown>,
    body: unknown,
  ): Promise<unknown> {
    const { path, query } = buildRequest(op, params);
    await assertSnapshotHolds(snap);
    try {
      return await snap.http.request<unknown>(op.method, path, {
        query,
        scrubSecrets: true,
        // The spec lists only a text type for these (Coolify's /version and
        // /health answer text/html).
        text: TEXT_ANSWERS.has(op.id),
        // Again right before each fetch, after the budget's and retries'
        // waits, so a target changed meanwhile is never reached.
        beforeFetch: () => assertSnapshotHolds(snap),
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      // Feature detection: an instance older than the spec that documents the
      // operation answers 404 when it doesn't have the endpoint (405 is mapped
      // by the request layer already).
      if (
        err instanceof CoolifyError &&
        err.cause === "not-found" &&
        !meetsMinVersion(versionOf(snap.view), documentedFrom(op))
      ) {
        throw new CoolifyError("unsupported-by-instance", err.status);
      }
      throw err;
    } finally {
      // A write may change resources or servers, whether or not it worked.
      if (op.method !== "GET") {
        await Promise.all([
          deps.resources.invalidate(snap.view.id),
          deps.servers.invalidate(snap.view.id),
        ]);
      }
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

    /**
     * Calls one operation. `readOnly` refuses anything but GET. A change or
     * a sensitive operation needs `confirmed`: the caller explicitly allowed
     * it (a confirm in the console, or core's confirm of coolify.api-call).
     */
    async dispatch(
      input: ApiCallInput,
      opts: { readOnly?: boolean; confirmed?: boolean } = {},
    ): Promise<ApiCallResult> {
      const { op, snap } = await authorize(
        input.connectionId,
        input.operationId,
        opts,
      );
      const sensitive = sensitiveOp(op);
      if (opts.readOnly && sensitive) {
        throw new ApiCallError(
          "confirm-required",
          `${op.id} reads secrets or logs; use coolify.api-call, which asks first`,
        );
      }
      if ((op.method !== "GET" || sensitive) && opts.confirmed !== true) {
        throw new ApiCallError(
          "confirm-required",
          `${op.id} ${op.method === "GET" ? "reads secrets or logs" : "changes Coolify"}; confirm it first`,
        );
      }
      const params = parseParams(input.params);
      const parsed = parseJson(input.body, "body");
      if (op.method === "GET" && parsed !== undefined) {
        throw invalid(`${op.id} takes no body`);
      }
      const body = shapeBody(op, parsed);
      const answer = await send(op, snap, params, body);
      // Log and output fields come back only to an operator who confirmed.
      const logsAllowed =
        opts.confirmed === true &&
        grantMeets(snap.view.access, "operate") &&
        (await holds("coolify.operate"));
      return {
        method: op.method,
        operationId: op.id,
        path: op.path,
        request: redact({
          params,
          ...(body !== undefined ? { body } : {}),
        }) as ApiCallResult["request"],
        data: logsAllowed
          ? redact(answer ?? null)
          : maskKeys(redact(answer ?? null), logFieldsOf(op)),
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
        if (opts.readsOnly && (op.method !== "GET" || sensitiveOp(op))) {
          continue;
        }
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
          sensitive: sensitiveOp(op),
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
      const { op, snap } = await authorize(
        input.connectionId,
        input.operationId,
        { readOnly: true },
      );
      const connection = snap.view;
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
        answer = await send(op, snap, params, undefined);
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
      const shown = maskKeys(redact(answer), logFieldsOf(op));
      if (
        value === undefined ||
        value === null ||
        !isMasked(at(shown, input.pointer))
      ) {
        throw new ApiCallError("not-masked", "That value is not a masked one");
      }
      if (
        input.pointer.some((step) => logFieldsOf(op).includes(String(step))) &&
        !(
          grantMeets(connection.access, "operate") &&
          (await holds("coolify.operate"))
        )
      ) {
        throw new ApiCallError(
          "forbidden",
          "Revealing logs or command output needs the coolify.operate permission",
        );
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
      // coolify.api-call is destructive: core runs it only after a confirm,
      // and MCP passes confirmed only when the client set it (and "Allow
      // changes over MCP" is on), so reaching the handler is that consent.
      const result = await api.dispatch(
        {
          connectionId: connectionIdInput(input),
          operationId,
          params: input.params,
          body: input.body,
        },
        { confirmed: true },
      );
      return {
        summary: `Called ${result.operationId} (${result.method} ${result.path})`,
        changed: result.method !== "GET",
        data: result,
      };
    },
  });
}
