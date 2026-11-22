import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import {
  redactFields,
  type OperationAction,
  type OperationField,
} from "@termix-ssh/plugin-sdk/operations";
import en from "../../../locales/en.json";
import { redact } from "../redact.js";
import { handoffIdOf, takeOnceUrl } from "../status/service.js";
import { takeExecOutput, takeLogText } from "../ops/containers.js";
import { takeBuildLogText } from "../ops/deployments.js";
import { takeWebUiUrl } from "../ops/container-companions.js";

/** The MCP protocol version this endpoint speaks when a client asks for another. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
export const MCP_SERVER_NAME = "termix-coolify";

/** Tool output `data` is cut at this many characters, with a note. */
export const MAX_DATA_CHARS = 8000;

/**
 * Change actions that MCP may run without "Allow changes over MCP"
 * (`allowMcpChanges`). The design allows deploy and restart, through both
 * their resource-scope and server-scope actions. Add each id here once its
 * action is declared in manifest.json; a test checks every id is a declared
 * change action.
 */
export const MCP_CHANGES_EXEMPT: readonly string[] = [
  "coolify.deploy",
  "coolify.restart",
  "coolify.resource-deploy",
  "coolify.resource-restart",
];

/**
 * Actions MCP refuses without `confirmed: true`, before core is asked:
 * coolify.exec runs any command in a container; coolify.enable-metrics
 * changes a server's Sentinel settings.
 */
export const MCP_CONFIRM_REQUIRED: readonly string[] = [
  "coolify.exec",
  "coolify.enable-metrics",
];

/**
 * Kinds of an action that MCP refuses without `confirmed: true`, like
 * MCP_CONFIRM_REQUIRED: tunnel-open reaches a container port from the Termix
 * server, web-ui hands out a signed-in link to a container.
 */
export const MCP_CONFIRM_REQUIRED_KINDS: Readonly<
  Record<string, readonly string[]>
> = {
  "coolify.companion": ["tunnel-open", "web-ui"],
};

/** Whether MCP needs `confirmed: true` for this action and its kind. */
export function mcpConfirmRequired(
  actionId: string,
  args: Record<string, unknown>,
): boolean {
  if (MCP_CONFIRM_REQUIRED.includes(actionId)) return true;
  const kinds = MCP_CONFIRM_REQUIRED_KINDS[actionId];
  return !!kinds && typeof args.kind === "string" && kinds.includes(args.kind);
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint?: boolean;
}

/**
 * A tool that is not one declared action (`list_connections`, `list_hosts`,
 * `list_resources`, `take_status_page_url`): one entry in EXTRA_TOOLS each.
 */
export interface McpExtraTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  call: (
    ctx: PluginContext,
    args: Record<string, unknown>,
  ) => Promise<McpToolResult>;
}

const PREFIX = "coolify.";

/** `coolify.connection-probe` → `coolify__connection_probe`. */
export function toolName(actionId: string): string {
  const action = actionId.startsWith(PREFIX)
    ? actionId.slice(PREFIX.length)
    : actionId;
  return `coolify__${action.replace(/[.-]/g, "_")}`;
}

/** A locale string by dotted key, or "" when there is none. */
function text(key: string | undefined): string {
  if (!key) return "";
  const found = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
  return typeof found === "string" ? found : "";
}

function fieldSchema(field: OperationField): Record<string, unknown> {
  const description = [
    text(field.descriptionKey) || text(field.labelKey),
    field.optionsFrom ? `Values come from ${toolName(field.optionsFrom)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const schema: Record<string, unknown> = {};
  switch (field.type) {
    case "boolean":
      schema.type = "boolean";
      break;
    case "number":
      schema.type = "number";
      if (field.min !== undefined) schema.minimum = field.min;
      if (field.max !== undefined) schema.maximum = field.max;
      break;
    case "multiselect":
      schema.type = "array";
      schema.items = { type: "string" };
      break;
    case "json":
      break;
    default:
      schema.type = "string";
      if (field.pattern) schema.pattern = field.pattern;
      if (field.type === "secret") schema.writeOnly = true;
      if (field.type === "select" && field.options?.length) {
        schema.enum = field.options.map((o) => o.value);
      }
  }
  if (field.default !== undefined) schema.default = field.default;
  if (description) schema.description = description;
  return schema;
}

function inputSchema(action: OperationAction): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (action.scope === "host" || action.scope === "resource") {
    properties.hostId = {
      type: "number",
      description: "The Termix host to run on.",
    };
    required.push("hostId");
  }
  if (action.scope === "resource") {
    properties.resourceKey = {
      type: "string",
      description: "The row this action targets.",
    };
    required.push("resourceKey");
  }
  for (const field of action.inputs ?? []) {
    properties[field.key] = fieldSchema(field);
    if (field.required) required.push(field.key);
  }
  if (action.dryRun) {
    properties.dryRun = {
      type: "boolean",
      description: "Describe what would happen without changing anything.",
    };
  }
  if (action.risk === "destructive") {
    properties.confirmed = {
      type: "boolean",
      description: "Set true to confirm this destructive action.",
    };
  } else if (MCP_CONFIRM_REQUIRED.includes(action.id)) {
    properties.confirmed = {
      type: "boolean",
      description: "Required: set true to confirm this action.",
    };
  } else if (MCP_CONFIRM_REQUIRED_KINDS[action.id]) {
    properties.confirmed = {
      type: "boolean",
      description: `Required for the kinds ${MCP_CONFIRM_REQUIRED_KINDS[action.id]!.join(", ")}: set true to confirm.`,
    };
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function annotationsFor(
  risk: OperationAction["risk"],
  title?: string,
): McpToolAnnotations {
  return {
    ...(title ? { title } : {}),
    readOnlyHint: risk === "read",
    destructiveHint: risk === "destructive",
    openWorldHint: true,
  };
}

function actionTool(action: OperationAction) {
  const title = text(action.titleKey) || action.id;
  const description = text(action.descriptionKey);
  return {
    name: toolName(action.id),
    description: description ? `${title}. ${description}` : title,
    inputSchema: inputSchema(action),
    annotations: annotationsFor(action.risk, title),
  };
}

function declaredActions(ctx: PluginContext): OperationAction[] {
  return (ctx.manifest.contributes?.operations?.actions ??
    []) as OperationAction[];
}

/**
 * True when "Allow changes over MCP" keeps this action from running over MCP:
 * every change or destructive action unless the setting is on or the action is
 * exempt. Reads always run. REST API-key calls never pass through here.
 */
export function mcpChangesRefused(
  action: Pick<OperationAction, "id" | "risk">,
  allowMcpChanges: boolean,
  exempt: readonly string[] = MCP_CHANGES_EXEMPT,
): boolean {
  if (action.risk === "read") return false;
  if (allowMcpChanges) return false;
  return !exempt.includes(action.id);
}

function textResult(body: unknown, isError: boolean): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError,
  };
}

const FAILED = /fail|error|denied|refused|reject|forbid|cancel|timeout|timed/i;
const WAITING = /approval|pending|waiting|queued/i;

/**
 * An operation outcome as a tool result: `{ status, summary, data }` with data
 * redacted and cut at MAX_DATA_CHARS, a waiting approval as text with the run
 * id, and a refusal or failure as isError.
 */
export function toolResult(outcome: PluginOperationOutcome): McpToolResult {
  const status = String(outcome.status ?? "unknown");
  if (outcome.approvalId || WAITING.test(status)) {
    return {
      content: [
        {
          type: "text",
          text: `Waiting for approval. Run id: ${outcome.runId ?? "unknown"}. The action runs once a person approves it in Termix.`,
        },
      ],
      isError: false,
    };
  }
  const failed =
    Boolean(outcome.error || outcome.errorCode) || FAILED.test(status);
  const body: Record<string, unknown> = { status };
  if (outcome.summary !== undefined) body.summary = outcome.summary;
  if (failed) {
    if (outcome.error !== undefined) body.error = outcome.error;
    if (outcome.errorCode !== undefined) body.errorCode = outcome.errorCode;
  }
  if (outcome.data !== undefined) {
    const data = redact(outcome.data);
    const serialized = JSON.stringify(data) ?? "null";
    if (serialized.length > MAX_DATA_CHARS) {
      body.data = serialized.slice(0, MAX_DATA_CHARS);
      body.note = `data was cut at 8,000 characters (it had ${serialized.length}); it is the start of the JSON text`;
    } else {
      body.data = data;
    }
  }
  return textResult(body, failed);
}

function errorResult(err: unknown): McpToolResult {
  const e = err as { message?: unknown; code?: unknown };
  return textResult(
    {
      status: "error",
      error: typeof e?.message === "string" ? e.message : "The action failed",
      ...(typeof e?.code === "string" ? { errorCode: e.code } : {}),
    },
    true,
  );
}

/** The fields list_hosts reads from a coolify.sync-preview row. */
interface LinkedRow {
  server?: { uuid?: string; name?: string };
  hostId: number | null;
  status?: string;
  tunnel?: boolean;
}

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** The tools that are not one declared action. */
export const EXTRA_TOOLS: McpExtraTool[] = [
  {
    name: "list_connections",
    description:
      "List the Coolify connections you own or were granted, without any token.",
    inputSchema: EMPTY_INPUT,
    annotations: annotationsFor("read", "List Coolify connections"),
    async call(ctx) {
      const outcome = await ctx.operations.run("coolify.list-connections", {
        input: {},
        dryRun: false,
        via: "mcp",
      });
      const rows = (outcome.data as { rows?: unknown } | undefined)?.rows;
      return toolResult(
        rows === undefined ? outcome : { ...outcome, data: { rows } },
      );
    },
  },
  {
    // Runs coolify.sync-preview, so its permission, history and checks
    // apply, and answers only the rows that have a Linked host.
    name: "list_hosts",
    description:
      "List the Termix hosts linked to the Coolify servers of a connection.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: `One of your Coolify connections. Values come from ${toolName("coolify.list-connections")}.`,
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    annotations: annotationsFor("read", "List Linked hosts"),
    async call(ctx, args) {
      const outcome = await ctx.operations.run("coolify.sync-preview", {
        input: { connectionId: args.connectionId },
        dryRun: false,
        via: "mcp",
      });
      const rows = (outcome.data as { rows?: unknown } | undefined)?.rows;
      if (!Array.isArray(rows)) return toolResult(outcome);
      const linked = (rows as LinkedRow[])
        .filter((r) => typeof r.hostId === "number")
        .map((r) => ({
          hostId: r.hostId,
          serverUuid: r.server?.uuid ?? null,
          name: r.server?.name ?? null,
          status: r.status,
          tunnel: r.tunnel === true,
        }));
      return toolResult({
        ...outcome,
        summary: `${linked.length} Linked host${linked.length === 1 ? "" : "s"}`,
        data: { rows: linked },
      });
    },
  },
  {
    // Runs coolify.list-resources-all, so its permission, history and
    // stripped DTOs apply.
    name: "list_resources",
    description:
      "List the applications, services and databases of a Coolify connection.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: `One of your Coolify connections. Values come from ${toolName("coolify.list-connections")}.`,
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    annotations: annotationsFor("read", "List Coolify resources"),
    async call(ctx, args) {
      return toolResult(
        await ctx.operations.run("coolify.list-resources-all", {
          input: { connectionId: args.connectionId },
          dryRun: false,
          via: "mcp",
        }),
      );
    },
  },
  {
    name: "take_status_page_url",
    description:
      "Take, once, the URL of a status page you published or gave a new link with an action whose answer had a handoffId (after an approval, or through Termix's operations API). Only you can take it, only once, and only within 5 minutes; it is never stored.",
    inputSchema: {
      type: "object",
      properties: {
        handoffId: {
          type: "string",
          description:
            "The handoffId from coolify.status-page-create or coolify.status-page-rotate (the run id).",
        },
      },
      required: ["handoffId"],
      additionalProperties: false,
    },
    annotations: {
      title: "Take a status page URL",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    async call(ctx, args) {
      const handoffId = handoffIdOf(args.handoffId);
      const userId = ctx.currentActor() ?? "";
      const allowed = userId ? await ctx.rbac.has("configure") : false;
      const url = handoffId && allowed ? takeOnceUrl(userId, handoffId) : null;
      if (!url) {
        return textResult(
          {
            status: "not-found",
            error:
              "Nothing to hand over: the URL was taken already, expired after 5 minutes, or belongs to another run or user. Give the page a new link to get one.",
            errorCode: "not-found",
          },
          true,
        );
      }
      return {
        content: [{ type: "text", text: shownOnce(url) }],
        isError: false,
      };
    },
  },
];

/** The text that carries a status page URL in one MCP answer, never stored. */
function shownOnce(url: string): string {
  return `Status page URL (shown once, not stored): ${url}`;
}

/** Actions whose run hands a status page URL over once (Task 18's handoff). */
const URL_HANDOFF_ACTIONS = new Set([
  "coolify.status-page-create",
  "coolify.status-page-rotate",
]);

/**
 * An action's result: sensitive outputs replaced, as core does before a run
 * is stored or shown, and for a status page create or rotate that finished
 * here, its URL added once as a second item.
 */
function actionResult(
  ctx: PluginContext,
  action: OperationAction,
  outcome: PluginOperationOutcome,
): McpToolResult {
  let data = redactFields(action.outputs, outcome.data);
  if (action.id === "coolify.logs-tail" && data && typeof data === "object") {
    // The text was redacted by redactLog and dropped from run history; the
    // caller who ran it gets it here, once.
    const text = takeLogText(
      ctx.currentActor() ?? "",
      (outcome.data as { handoffId?: unknown }).handoffId,
    );
    if (text !== null) data = { ...(data as object), text };
  }
  if (
    action.id === "coolify.deployment-get" &&
    data &&
    typeof data === "object"
  ) {
    // The build log was redacted and dropped from run history; the caller
    // who ran it gets it here, once.
    const text = takeBuildLogText(
      ctx.currentActor() ?? "",
      (outcome.data as { handoffId?: unknown }).handoffId,
    );
    if (text !== null) data = { ...(data as object), text };
  }
  if (action.id === "coolify.exec" && data && typeof data === "object") {
    // stdout and stderr were redacted and dropped from run history; the
    // caller who ran it gets them here, once.
    const output = takeExecOutput(
      ctx.currentActor() ?? "",
      (outcome.data as { handoffId?: unknown }).handoffId,
    );
    if (output !== null) data = { ...(data as object), ...output };
  }
  if (action.id === "coolify.companion" && data && typeof data === "object") {
    // A web-ui run's one-time URL was dropped from run history; the caller
    // who ran it gets it here, once.
    const url = takeWebUiUrl(
      ctx.currentActor() ?? "",
      (outcome.data as { handoffId?: unknown }).handoffId,
    );
    if (url !== null) data = { ...(data as object), url };
  }
  const result = toolResult(
    outcome.data === undefined ? outcome : { ...outcome, data },
  );
  if (result.isError || !URL_HANDOFF_ACTIONS.has(action.id)) return result;
  const handoffId = handoffIdOf(
    (outcome.data as { handoffId?: unknown } | undefined)?.handoffId,
  );
  const url = handoffId
    ? takeOnceUrl(ctx.currentActor() ?? "", handoffId)
    : null;
  if (!url) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: shownOnce(url) }],
  };
}

const RESERVED = new Set(["hostId", "resourceKey", "dryRun", "confirmed"]);

async function callAction(
  ctx: PluginContext,
  action: OperationAction,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const allow = (await ctx.settings.get("allowMcpChanges")) === true;
  if (mcpChangesRefused(action, allow)) {
    return textResult(
      {
        status: "refused",
        error:
          'Changes over MCP are turned off. An admin can turn on "Allow changes over MCP" in the Coolify plugin settings.',
        errorCode: "mcp-changes-off",
      },
      true,
    );
  }
  if (mcpConfirmRequired(action.id, args) && args.confirmed !== true) {
    return textResult(
      {
        status: "refused",
        error: "This action needs confirmed: true.",
        errorCode: "confirm-required",
      },
      true,
    );
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!RESERVED.has(key)) input[key] = value;
  }
  const options: PluginOperationInvokeOptions = {};
  if (
    (action.scope === "host" || action.scope === "resource") &&
    typeof args.hostId === "number"
  ) {
    options.hostId = args.hostId;
  }
  if (action.scope === "resource" && typeof args.resourceKey === "string") {
    options.resourceKey = args.resourceKey;
  }
  options.input = input;
  options.dryRun = args.dryRun === true;
  if (action.risk === "destructive" && args.confirmed === true) {
    options.confirmed = true;
  }
  options.via = "mcp";
  try {
    return actionResult(
      ctx,
      action,
      await ctx.operations.run(action.id, options),
    );
  } catch (err) {
    return errorResult(err);
  }
}

type Reply = Record<string, unknown>;

function ok(id: JsonRpcMessage["id"], result: unknown): Reply {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(id: JsonRpcMessage["id"], code: number, message: string): Reply {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * One JSON-RPC message from an MCP client. Answers null for a notification
 * (no id), which gets no reply and runs nothing. Never throws.
 */
export async function handleMcp(
  ctx: PluginContext,
  message: JsonRpcMessage,
): Promise<Reply | null> {
  const msg = message as unknown as Record<string, unknown> | null;
  const id =
    msg && typeof msg === "object"
      ? (msg.id as JsonRpcMessage["id"])
      : undefined;
  if (
    !msg ||
    typeof msg !== "object" ||
    Array.isArray(msg) ||
    msg.jsonrpc !== "2.0" ||
    typeof msg.method !== "string"
  ) {
    return fail(id, -32600, "Invalid request");
  }
  if (id === undefined) return null;
  const params =
    msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return ok(id, {
          protocolVersion:
            typeof asked === "string" && KNOWN_PROTOCOLS.has(asked)
              ? asked
              : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: ctx.manifest.version },
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: [
            ...declaredActions(ctx).map(actionTool),
            ...EXTRA_TOOLS.map(({ call: _call, ...tool }) => tool),
          ],
        });
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string") {
          return fail(id, -32602, "Tool name is required");
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          return fail(id, -32602, "Tool arguments must be an object");
        }
        const extra = EXTRA_TOOLS.find((t) => t.name === name);
        if (extra) {
          try {
            return ok(
              id,
              await extra.call(ctx, args as Record<string, unknown>),
            );
          } catch (err) {
            return ok(id, errorResult(err));
          }
        }
        const action = declaredActions(ctx).find(
          (a) => toolName(a.id) === name,
        );
        if (!action) return fail(id, -32602, `Unknown tool: ${name}`);
        return ok(
          id,
          await callAction(ctx, action, args as Record<string, unknown>),
        );
      }
      default:
        return fail(id, -32601, `Method not found: ${msg.method}`);
    }
  } catch {
    return fail(id, -32603, "Internal error");
  }
}

/**
 * A POST body: one message or a JSON-RPC batch. Answers null when nothing
 * needs a reply (only notifications).
 */
export async function handleMcpBody(
  ctx: PluginContext,
  body: unknown,
): Promise<Reply | Reply[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return fail(null, -32600, "Invalid request");
    const replies: Reply[] = [];
    for (const message of body) {
      const reply = await handleMcp(ctx, message as JsonRpcMessage);
      if (reply) replies.push(reply);
    }
    return replies.length ? replies : null;
  }
  return handleMcp(ctx, body as JsonRpcMessage);
}
