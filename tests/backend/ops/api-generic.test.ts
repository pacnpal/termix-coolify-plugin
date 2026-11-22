import { afterEach, describe, expect, it } from "vitest";
import {
  EXCLUDED_OPERATIONS,
  OPERATIONS,
} from "../../../src/backend/coolify/generated/operations.js";
import { OPERATION_SCHEMAS } from "../../../src/backend/coolify/generated/schemas.js";
import { toRouteError } from "../../../src/backend/coolify/http.js";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import {
  UNSUPPORTED_UPLOADS,
  requiredAccess,
} from "../../../src/backend/ops/api-generic.js";
import { healthyCoolify, type FakeAnswer } from "../helpers/fake-coolify.js";
import {
  manifest,
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { withRunHistory } from "../helpers/run-history.js";
import { expectKeyTailMasked, KEY_TAIL } from "../helpers/key-tail.js";

const TOKEN = "fake-token-api-generic";
const PRIVATE_KEY =
  "-----BEGIN FAKE PRIVATE KEY-----\nfake-key-material-api-test\n-----END FAKE PRIVATE KEY-----";
const ENV_VALUE = "fake-env-value-api-test";
const DB_PASSWORD = "fake-db-password-api-test";
const VALIDATION_LOG = "fake-validation-log-api-test";
const ALL = ["view", "operate", "configure", "administer", "mcp"];

/** Coolify answers the tests need, besides the probe's. */
const ROUTES: Record<string, FakeAnswer> = {
  "POST /deploy": { json: { deployments: [] } },
  "PATCH /applications/app-web-uuid": { json: { uuid: "app-web-uuid" } },
  "DELETE /applications/app-web-uuid": { json: { message: "deleted" } },
  "POST /servers": { status: 201, json: { uuid: "srv-new" } },
  "POST /servers/srv-1/migrate": { json: { message: "started" } },
  "GET /servers/srv-1/transfer": { json: { migration: { status: "done" } } },
  "GET /deployments/dep-1": { json: { uuid: "dep-1", logs: "build" } },
  "GET /applications/app-web-uuid/scheduled-tasks/task-1/executions": {
    json: [],
  },
  "POST /security/keys": { status: 201, json: { uuid: "key-new" } },
  "PATCH /applications/app-web-uuid/envs": {
    status: 201,
    json: { uuid: "env-1", key: "API_SECRET", value: ENV_VALUE },
  },
  "GET /projects": { json: [{ uuid: "proj-1", name: "one" }] },
  "GET /servers": {
    json: [{ uuid: "srv-1", name: "one", validation_logs: VALIDATION_LOG }],
  },
  "POST /databases/db-1/imports": { status: 201, json: { activity_id: "a1" } },
  "GET /projects/proj-uuid/production": { json: { name: "production" } },
  "GET /applications/app-web-uuid/secret-manager": { json: {} },
  "GET /applications/app-web-uuid/previews/42": { json: { id: 42 } },
  "GET /databases/db-1": {
    json: {
      uuid: "db-1",
      internal_db_url: `postgres://postgres:${DB_PASSWORD}@db-1:5432/postgres`,
      external_db_url: `postgres://postgres:${DB_PASSWORD}@203.0.113.5:5433/postgres`,
      postgres_password: DB_PASSWORD,
    },
  },
  "GET /servers/import/check": { json: { missing: [] } },
  "GET /servers/srv-1/proxy": {
    json: {
      type: "TRAEFIK",
      configuration: `services:\n  traefik:\n    environment:\n      - CF_DNS_API_TOKEN=${DB_PASSWORD}`,
    },
  },
  "PUT /servers/srv-1/proxy/configuration": {
    json: {
      configuration: `services:\n  traefik:\n    environment:\n      - CF_DNS_API_TOKEN=${DB_PASSWORD}`,
    },
  },
};

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(
  options: {
    permissions?: string[];
    version?: string;
    settings?: Record<string, unknown>;
  } = {},
) {
  await harness?.close();
  const fake = healthyCoolify({
    ...ROUTES,
    ...(options.version ? { "GET /version": { text: options.version } } : {}),
  });
  harness = await startPlugin({
    fetch: fake.fetch,
    serve: false,
    permissions: options.permissions ?? ALL,
    settings: options.settings,
  });
  const runs = withRunHistory(harness.mock);
  const created = await harness.mock.ctx.operations.run(
    "coolify.connection-create",
    {
      input: {
        name: "Prod",
        baseUrl: "https://coolify.example.test",
        token: TOKEN,
      },
    },
  );
  const connectionId = String((created.data as { id: number }).id);
  fake.calls.length = 0;
  current = { runs, connectionId };
  return { harness, fake, runs, connectionId };
}

/** The runs and connection of the last start(), for apiRead and apiCall. */
let current: {
  runs: ReturnType<typeof withRunHistory>;
  connectionId: string;
} | null = null;

function apiInput(operationId: string, params?: unknown, body?: unknown) {
  return {
    connectionId: current!.connectionId,
    operationId,
    ...(params === undefined ? {} : { params: JSON.stringify(params) }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** coolify.api-read on the last start()'s connection. */
function apiRead(operationId: string, params?: unknown) {
  return current!.runs.run("coolify.api-read", apiInput(operationId, params));
}

/** Each set of params is refused as invalid input before Coolify is asked. */
async function expectInvalidReads(
  operationId: string,
  cases: Record<string, unknown>[],
) {
  for (const params of cases) {
    await expect(
      apiRead(operationId, params),
      JSON.stringify(params),
    ).rejects.toMatchObject({ code: "invalid-input" });
  }
}

/** coolify.api-call on the last start()'s connection. */
function apiCall(operationId: string, params?: unknown, body?: unknown) {
  return current!.runs.run(
    "coolify.api-call",
    apiInput(operationId, params, body),
  );
}

function grant(h: PluginHarness, connectionId: string, level: string) {
  h.db.sqlite
    .prepare(
      "INSERT INTO p_coolify_grants (connection_id, user_id, level) VALUES (?, ?, ?)",
    )
    .run(Number(connectionId), OTHER, level);
  h.mock.setActor(OTHER);
}

function sent(
  fake: ReturnType<typeof healthyCoolify>,
  method: string,
  path: string,
) {
  return fake.calls.filter((c) => c.method === method && c.path === path);
}

async function listed(
  h: PluginHarness,
  action: "coolify.list-api-operations" | "coolify.list-api-reads",
  connectionId: string,
): Promise<string[]> {
  const outcome = await h.mock.ctx.operations.run(action, {
    input: { connectionId },
  });
  return (outcome.data as { options: { value: string }[] }).options.map(
    (o) => o.value,
  );
}

const BASELINE = OPERATIONS.filter((o) => o.source === "4.7.5").map(
  (o) => o.id,
);

describe("requiredAccess", () => {
  it("pins one operation from each branch, in the plan's order", () => {
    expect(() => requiredAccess("disable-api")).toThrow(/never/i);
    const expectations: Record<string, [string, string]> = {
      "delete-application-by-uuid": ["coolify.administer", "configure"],
      "create-server": ["coolify.administer", "configure"],
      "migrate-server-between-instances": ["coolify.administer", "configure"],
      "complete-server-transfer": ["coolify.administer", "configure"],
      "import-server-transfer-bundle": ["coolify.administer", "configure"],
      "create-hetzner-server": ["coolify.administer", "configure"],
      "get-hetzner-images": ["coolify.administer", "configure"],
      "create-cloud-token": ["coolify.administer", "configure"],
      "list-cloud-tokens": ["coolify.administer", "configure"],
      "update-instance-email-settings": ["coolify.administer", "configure"],
      "get-instance-email-settings": ["coolify.administer", "configure"],
      "enable-mcp": ["coolify.administer", "configure"],
      "disable-mcp": ["coolify.administer", "configure"],
      "start-application-by-uuid": ["coolify.operate", "operate"],
      "stop-service-by-uuid": ["coolify.operate", "operate"],
      "restart-database-by-uuid": ["coolify.operate", "operate"],
      "deploy-by-tag-or-uuid": ["coolify.operate", "operate"],
      "cancel-deployment-by-uuid": ["coolify.operate", "operate"],
      "execute-scheduled-task-by-application-uuid": [
        "coolify.operate",
        "operate",
      ],
      "run-database-storage-backup": ["coolify.operate", "operate"],
      "get-application-logs-by-uuid": ["coolify.operate", "operate"],
      "post-service-application-logs-by-service-and-app-uuid": [
        "coolify.operate",
        "operate",
      ],
      "get-deployment-by-uuid": ["coolify.operate", "operate"],
      "list-deployments": ["coolify.operate", "operate"],
      "list-scheduled-task-executions-by-application-uuid": [
        "coolify.operate",
        "operate",
      ],
      "list-backup-executions": ["coolify.operate", "operate"],
      "get-server-transfer-status": ["coolify.operate", "operate"],
      "list-applications": ["coolify.view", "view"],
      "get-server-by-uuid": ["coolify.view", "view"],
      "check-server-import": ["coolify.view", "view"],
      "update-application-by-uuid": ["coolify.configure", "configure"],
      "create-private-key": ["coolify.configure", "configure"],
      "update-env-by-application-uuid": ["coolify.configure", "configure"],
    };
    for (const [id, [permission, grantLevel]] of Object.entries(expectations)) {
      expect(requiredAccess(id), id).toEqual({
        permission,
        grant: grantLevel,
      });
    }
  });

  it("classifies every operation, and every DELETE is administer", () => {
    for (const op of OPERATIONS) {
      if (EXCLUDED_OPERATIONS.has(op.id)) continue;
      const access = requiredAccess(op.id);
      if (op.method === "DELETE") {
        expect(access.permission, op.id).toBe("coolify.administer");
      }
      if (op.method !== "GET") {
        expect(access.permission, op.id).not.toBe("coolify.view");
      }
    }
  });

  it("every operation has a generated schema", () => {
    for (const op of OPERATIONS) {
      expect(OPERATION_SCHEMAS[op.id], op.id).toBeTruthy();
    }
  });
});

describe("generic Coolify API operations", () => {
  it("are declared as the plan says", () => {
    const actions = manifest.contributes!.operations!.actions!;
    const read = actions.find((a) => a.id === "coolify.api-read")!;
    const call = actions.find((a) => a.id === "coolify.api-call")!;
    expect(read.risk).toBe("read");
    expect(read.surfaces).toMatchObject({ assistant: true, mcp: true });
    expect(call.risk).toBe("destructive");
    expect(call.surfaces).toMatchObject({ assistant: false, mcp: false });
    const fields = (id: string) =>
      Object.fromEntries(
        actions
          .find((a) => a.id === id)!
          .inputs!.map((f) => [f.key, f] as const),
      );
    const readFields = fields("coolify.api-read");
    const callFields = fields("coolify.api-call");
    expect(readFields.connectionId.optionsFrom).toBe(
      "coolify.list-connections",
    );
    expect(readFields.operationId.optionsFrom).toBe("coolify.list-api-reads");
    expect(callFields.operationId.optionsFrom).toBe(
      "coolify.list-api-operations",
    );
    expect(readFields.params.type).toBe("secret");
    expect(callFields.params.type).toBe("secret");
    expect(callFields.body.type).toBe("secret");
    expect(readFields.body).toBeUndefined();
  });

  it("api-read refuses non-GET operation ids", async () => {
    const { runs, fake, connectionId } = await start();
    for (const operationId of [
      "deploy-by-tag-or-uuid",
      "update-application-by-uuid",
      "delete-application-by-uuid",
    ]) {
      await expect(
        runs.run("coolify.api-read", { connectionId, operationId }),
        operationId,
      ).rejects.toMatchObject({ code: "not-a-read" });
    }
    expect(fake.calls).toEqual([]);
    const reads = await listed(
      harness!,
      "coolify.list-api-reads",
      connectionId,
    );
    for (const id of reads) {
      expect(OPERATIONS.find((o) => o.id === id)!.method, id).toBe("GET");
    }
  });

  it("api-call requires confirmed: it is destructive, so core asks, and MCP passes it only when set", async () => {
    const action = manifest.contributes!.operations!.actions!.find(
      (a) => a.id === "coolify.api-call",
    )!;
    expect(action.risk).toBe("destructive");
    const { harness: h } = await start({
      settings: { allowMcpChanges: true },
    });
    const seen: unknown[] = [];
    const ctx = new Proxy(h.mock.ctx, {
      get(target, prop) {
        if (prop === "operations") {
          return {
            run: async (id: string, options: unknown) => {
              seen.push({ id, options });
              return { runId: "r1", status: "success" };
            },
          };
        }
        return Reflect.get(target, prop);
      },
    });
    await handleMcp(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__api_call",
        arguments: { connectionId: "1", operationId: "list-projects" },
      },
    });
    expect(seen[0]).toMatchObject({ id: "coolify.api-call" });
    expect(
      (seen[0] as { options: { confirmed?: boolean } }).options.confirmed,
    ).toBeUndefined();
  });

  it("api-call refuses the disable-API operation even when its id is supplied directly", async () => {
    const { runs, fake, connectionId } = await start();
    for (const action of ["coolify.api-call", "coolify.api-read"]) {
      await expect(
        runs.run(action, { connectionId, operationId: "disable-api" }),
      ).rejects.toMatchObject({ code: "excluded" });
    }
    // Excluded comes before any other check: even an unknown connection.
    await expect(
      runs.run("coolify.api-call", {
        connectionId: "999",
        operationId: "disable-api",
      }),
    ).rejects.toMatchObject({ code: "excluded" });
    expect(sent(fake, "POST", "/disable")).toEqual([]);
  });

  it("list-api-operations never lists the disable-API operation", async () => {
    const { harness: h, connectionId } = await start();
    const ops = await listed(h, "coolify.list-api-operations", connectionId);
    expect(ops.length).toBeGreaterThan(100);
    expect(ops).not.toContain("disable-api");
    expect(
      await listed(h, "coolify.list-api-reads", connectionId),
    ).not.toContain("disable-api");
  });

  it("api-call checks the operation's own access: an operate actor deploys but can't update", async () => {
    const { fake } = await start({
      permissions: ["view", "operate"],
    });
    const deployed = await apiCall("deploy-by-tag-or-uuid", {
      uuid: "app-web-uuid",
    });
    expect(deployed.summary).toContain("deploy-by-tag-or-uuid");
    expect(sent(fake, "POST", "/deploy")).toHaveLength(1);
    await expect(
      apiCall(
        "update-application-by-uuid",
        { uuid: "app-web-uuid" },
        { name: "renamed" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(sent(fake, "PATCH", "/applications/app-web-uuid")).toEqual([]);
  });

  it("api-call checks the grant: an operate grant deploys but can't update", async () => {
    const { harness: h, fake, connectionId } = await start();
    grant(h, connectionId, "operate");
    await apiCall("deploy-by-tag-or-uuid", { uuid: "app-web-uuid" });
    expect(sent(fake, "POST", "/deploy")).toHaveLength(1);
    await expect(
      apiCall("update-application-by-uuid", { uuid: "app-web-uuid" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(sent(fake, "PATCH", "/applications/app-web-uuid")).toEqual([]);
  });

  it("a view grant is refused every non-GET operation", async () => {
    const { harness: h, fake, connectionId } = await start();
    grant(h, connectionId, "view");
    for (const op of OPERATIONS) {
      if (op.method === "GET") continue;
      await expect(apiCall(op.id), op.id).rejects.toMatchObject({
        code: expect.stringMatching(
          /^(forbidden|excluded|upload-unsupported)$/,
        ),
      });
    }
    expect(fake.calls).toEqual([]);
    const ops = await listed(h, "coolify.list-api-operations", connectionId);
    for (const id of ops) {
      expect(OPERATIONS.find((o) => o.id === id)!.method, id).toBe("GET");
    }
  });

  it("api-read of a logs endpoint needs coolify.operate", async () => {
    const LOG_READS = {
      "get-application-logs-by-uuid": { uuid: "app-web-uuid" },
      "get-deployment-by-uuid": { uuid: "dep-1" },
      "list-scheduled-task-executions-by-application-uuid": {
        uuid: "app-web-uuid",
        task_uuid: "task-1",
      },
    };
    const {
      harness: h,
      runs,
      fake,
      connectionId,
    } = await start({
      permissions: ["view"],
    });
    // The fake token reads logs, so the probe found read:sensitive.
    const connection = (await h.mock.ctx.operations.run(
      "coolify.list-connections",
    )) as { data: { rows: { abilities: { sensitive: boolean } }[] } };
    expect(connection.data.rows[0].abilities.sensitive).toBe(true);
    for (const [operationId, params] of Object.entries(LOG_READS)) {
      await expect(
        runs.run("coolify.api-read", {
          connectionId,
          operationId,
          params: JSON.stringify(params),
        }),
        operationId,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(fake.calls).toEqual([]);
    const reads = await listed(h, "coolify.list-api-reads", connectionId);
    for (const id of Object.keys(LOG_READS)) expect(reads).not.toContain(id);
    expect(reads).toContain("list-applications");
  });

  it("api-read of a logs endpoint is refused to a view grant, too", async () => {
    const { harness: h, fake, connectionId } = await start();
    grant(h, connectionId, "view");
    await expect(
      apiRead("get-application-logs-by-uuid", { uuid: "app-web-uuid" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fake.calls).toEqual([]);
    const read = await apiRead("list-projects");
    expect(read.data).toMatchObject({ operationId: "list-projects" });
  });

  it("transfer status carries the migration log, so it needs operate; starting a transfer is administer", async () => {
    {
      const { fake } = await start({
        permissions: ["view"],
      });
      await expect(
        apiRead("get-server-transfer-status", { uuid: "srv-1" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(fake.calls).toEqual([]);
    }
    {
      const { fake } = await start({
        permissions: ["view", "operate"],
      });
      const read = await apiRead("get-server-transfer-status", {
        uuid: "srv-1",
      });
      expect(read.data).toMatchObject({
        data: { migration: { status: "done" } },
      });
      expect(sent(fake, "GET", "/servers/srv-1/transfer")).toHaveLength(1);
    }
    const { fake } = await start({
      permissions: ["view", "operate", "configure"],
    });
    await expect(
      apiCall(
        "migrate-server-between-instances",
        { uuid: "srv-1" },
        {
          target_url: "https://coolify-b.example.test",
          target_token: "fake-target-token",
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(sent(fake, "POST", "/servers/srv-1/migrate")).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("administer operations need coolify.administer", async () => {
    const {
      harness: h,
      fake,
      connectionId,
    } = await start({
      permissions: ["view", "operate", "configure"],
    });
    await expect(
      apiCall("delete-application-by-uuid", { uuid: "app-web-uuid" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      apiCall("create-server", undefined, { name: "new", ip: "192.0.2.10" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fake.calls).toEqual([]);
    const ops = await listed(h, "coolify.list-api-operations", connectionId);
    expect(ops).not.toContain("delete-application-by-uuid");
    expect(ops).not.toContain("create-server");
    expect(ops).toContain("update-application-by-uuid");
  });

  it("an administer actor with a configure grant can delete; ownership counts too", async () => {
    const { harness: h, fake, connectionId } = await start();
    const ops = await listed(h, "coolify.list-api-operations", connectionId);
    expect(ops).toContain("delete-application-by-uuid");
    grant(h, connectionId, "configure");
    await apiCall("delete-application-by-uuid", { uuid: "app-web-uuid" });
    expect(sent(fake, "DELETE", "/applications/app-web-uuid")).toHaveLength(1);
  });

  it("api-call creating a private key or setting env values leaves no secret in run history", async () => {
    const { runs, fake } = await start();
    const key = await apiCall("create-private-key", undefined, {
      name: "deploy",
      private_key: PRIVATE_KEY,
    });
    const env = await apiCall(
      "update-env-by-application-uuid",
      { uuid: "app-web-uuid" },
      { key: "API_SECRET", value: ENV_VALUE },
    );
    // The secrets did reach Coolify.
    expect(
      String(sent(fake, "POST", "/security/keys")[0].init?.body),
    ).toContain("fake-key-material-api-test");
    expect(
      String(
        sent(fake, "PATCH", "/applications/app-web-uuid/envs")[0].init?.body,
      ),
    ).toContain(ENV_VALUE);
    expect(runs.history).toHaveLength(2);
    const stored = JSON.stringify(runs.history);
    expect(stored).not.toContain("fake-key-material-api-test");
    expect(stored).not.toContain(ENV_VALUE);
    expect(runs.history[0].summary).toContain("create-private-key");
    expect(runs.history[1].summary).toContain("update-env-by-application-uuid");
    expect(runs.history[0].input).toMatchObject({
      body: "[redacted]",
      operationId: "create-private-key",
    });
    expect(key.data).toMatchObject({
      method: "POST",
      operationId: "create-private-key",
      path: "/security/keys",
      request: { body: { name: "deploy", private_key: "[redacted]" } },
    });
    expect(env.data).toMatchObject({
      method: "PATCH",
      path: "/applications/{uuid}/envs",
      request: {
        params: { uuid: "app-web-uuid" },
        body: { key: "API_SECRET", value: "[redacted]" },
      },
      data: { value: "[redacted]" },
    });
  });

  it("api operations newer than the connection version are hidden", async () => {
    const {
      harness: h,
      runs,
      fake,
      connectionId,
    } = await start({
      version: "v4.7.5",
    });
    const ops = await listed(h, "coolify.list-api-operations", connectionId);
    expect(ops).not.toContain("create-database-influxdb");
    await expect(
      apiCall("create-database-influxdb", undefined, { server_uuid: "srv-1" }),
    ).rejects.toMatchObject({ cause: "unsupported-by-instance" });
    expect(fake.calls).toEqual([]);
    const nightly = await start({ version: "v4.8.0-nightly" });
    expect(
      await listed(
        nightly.harness,
        "coolify.list-api-operations",
        nightly.connectionId,
      ),
    ).toContain("create-database-influxdb");
  });

  it("a 4.4.0 connection lists every baseline operation", async () => {
    const { harness: h, connectionId } = await start({ version: "v4.4.0" });
    const ops = await listed(h, "coolify.list-api-operations", connectionId);
    const expected = BASELINE.filter(
      (id) => !EXCLUDED_OPERATIONS.has(id) && !UNSUPPORTED_UPLOADS.has(id),
    );
    expect([...ops].sort()).toEqual([...expected].sort());
  });

  it("a 404 from a 4.4.0 connection maps to unsupported-by-instance", async () => {
    await start({ version: "v4.4.0" });
    let caught: unknown = null;
    try {
      await apiRead("get-server-sentinel", { uuid: "srv-1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ cause: "unsupported-by-instance" });
    expect(toRouteError(caught).status).toBe(409);
  });

  it("a 404 from an instance that has the operation stays not-found", async () => {
    await start({ version: "v4.7.5" });
    await expect(
      apiRead("get-server-sentinel", { uuid: "srv-1" }),
    ).rejects.toMatchObject({ cause: "not-found" });
  });

  it("refuses the upload import operations with a clear message", async () => {
    expect([...UNSUPPORTED_UPLOADS].sort()).toEqual([
      "upload-database-import",
      "upload-service-database-import",
    ]);
    const { harness: h, runs, fake, connectionId } = await start();
    for (const operationId of UNSUPPORTED_UPLOADS) {
      await expect(
        runs.run("coolify.api-call", { connectionId, operationId }),
      ).rejects.toMatchObject({
        code: "upload-unsupported",
        message: expect.stringMatching(/upload/i),
      });
    }
    expect(fake.calls).toEqual([]);
    const ops = await listed(h, "coolify.list-api-operations", connectionId);
    for (const id of UNSUPPORTED_UPLOADS) expect(ops).not.toContain(id);
  });

  it("api-read records method, operation, path and the redacted request", async () => {
    await start();
    const read = await apiRead("list-projects");
    expect(read.summary).toContain("list-projects");
    expect(read.summary).toContain("GET /projects");
    expect(read.data).toMatchObject({
      method: "GET",
      operationId: "list-projects",
      path: "/projects",
      data: [{ uuid: "proj-1" }],
    });
  });

  it("dot-segment path params are refused before any request", async () => {
    const { fake } = await start();
    const bad = [
      "..",
      ".",
      "...",
      "a/b",
      "a\\b",
      "%2e%2e",
      "%2F",
      "a\nb",
      "a b",
      "",
    ];
    await expectInvalidReads(
      "get-environment-by-name-or-uuid",
      bad.flatMap((value) => [
        { uuid: value, environment_name_or_uuid: "deployments" },
        { uuid: "proj-uuid", environment_name_or_uuid: value },
      ]),
    );
    expect(fake.calls).toEqual([]);
    // Real Coolify shapes still pass.
    await apiRead("get-environment-by-name-or-uuid", {
      uuid: "proj-uuid",
      environment_name_or_uuid: "production",
    });
    await apiRead("get-preview-deployment-by-pull-request-id", {
      uuid: "app-web-uuid",
      pull_request_id: 42,
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("integer path params take digits only", async () => {
    const { fake } = await start();
    await expectInvalidReads(
      "get-preview-deployment-by-pull-request-id",
      ["4x", "-1", "1.5", "..", 1.5].map((value) => ({
        uuid: "app-web-uuid",
        pull_request_id: value,
      })),
    );
    expect(fake.calls).toEqual([]);
  });

  it("enum path param outside its enum is refused", async () => {
    expect(
      OPERATION_SCHEMAS["get-secret-manager-source"].params.find(
        (p) => p.name === "resource_type",
      )?.enum,
    ).toEqual(["applications", "services", "databases"]);
    const { fake } = await start();
    // It reads secret-manager settings, so it runs only through api-call.
    for (const resource_type of ["servers", "settings", "deployments", ".."]) {
      await expect(
        apiCall("get-secret-manager-source", {
          resource_type,
          uuid: "app-web-uuid",
        }),
        resource_type,
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(fake.calls).toEqual([]);
    await apiCall("get-secret-manager-source", {
      resource_type: "applications",
      uuid: "app-web-uuid",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses unknown parameters and missing path parameters before calling Coolify", async () => {
    const { runs, fake, connectionId } = await start();
    await expect(apiRead("get-project-by-uuid")).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(apiRead("list-projects", { nope: 1 })).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(
      runs.run("coolify.api-read", {
        connectionId,
        operationId: "list-projects",
        params: "{not json",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fake.calls).toEqual([]);
  });

  it("another user's connection reads as missing", async () => {
    const { harness: h, fake, connectionId } = await start();
    h.mock.setActor(OTHER);
    await expect(apiRead("list-projects")).rejects.toMatchObject({
      code: "not-found",
    });
    expect(
      await listed(h, "coolify.list-api-operations", connectionId),
    ).toEqual([]);
    h.mock.setActor(OWNER);
    expect(fake.calls).toEqual([]);
  });
});

describe("generic API: log and output fields", () => {
  it("a view-level list-servers needs no confirm and answers validation_logs masked", async () => {
    await start({ permissions: ["view"] });
    const read = await apiRead("list-servers");
    expect(JSON.stringify(read.data)).not.toContain(VALIDATION_LOG);
    expect(read.data).toMatchObject({
      data: [{ uuid: "srv-1", validation_logs: "[redacted]" }],
    });
  });

  it("a view-level get-deployment is refused, even confirmed", async () => {
    const { fake } = await start({ permissions: ["view"] });
    await expect(
      apiRead("get-deployment-by-uuid", { uuid: "dep-1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      apiCall("get-deployment-by-uuid", { uuid: "dep-1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fake.calls).toEqual([]);
  });

  it("an operate-level, confirmed get-deployment answers the logs", async () => {
    await start({ permissions: ["view", "operate"] });
    await expect(
      apiRead("get-deployment-by-uuid", { uuid: "dep-1" }),
    ).rejects.toMatchObject({ code: "confirm-required" });
    const read = await apiCall("get-deployment-by-uuid", { uuid: "dep-1" });
    expect(read.data).toMatchObject({ data: { uuid: "dep-1", logs: "build" } });
  });

  it.each([
    [
      "get-application-logs-by-uuid",
      "GET /applications/app-web-uuid/logs",
      // A tail cut inside one key, then a whole key.
      `${KEY_TAIL.text}-----BEGIN RSA PRIVATE KEY-----\nfake-key-tail-body-whole\n-----END RSA PRIVATE KEY-----\nlast line`,
      { uuid: "app-web-uuid" },
      "last line",
    ],
    [
      "get-deployment-by-uuid",
      "GET /deployments/dep-1",
      // A build log, as Coolify keeps it: a JSON list of entries.
      JSON.stringify(
        KEY_TAIL.lines.map((output, i) => ({ output, order: i + 1 })),
      ),
      { uuid: "dep-1" },
      KEY_TAIL.after,
    ],
  ])(
    "a confirmed %s masks private keys, and a log that starts inside one",
    async (operationId, route, logs, params, kept) => {
      const { fake } = await start({ permissions: ["view", "operate"] });
      fake.set(route, { json: { uuid: "x", logs } });
      const read = await apiCall(operationId, params);
      const shown = (read.data as { data: { logs: string } }).data.logs;
      expectKeyTailMasked(shown);
      expect(shown).toContain(kept);
    },
  );

  it("an operate-level, confirmed list-servers answers validation_logs", async () => {
    await start({ permissions: ["view", "operate"] });
    const read = await apiCall("list-servers");
    expect(read.data).toMatchObject({
      data: [{ validation_logs: VALIDATION_LOG }],
    });
  });

  it("create-database-import sends the fields its oneOf branches declare", async () => {
    const { fake } = await start();
    await apiCall(
      "create-database-import",
      { uuid: "db-1" },
      { source: "s3", s3_storage_uuid: "s3-1", path: "/b.dump", extra: 1 },
    );
    const [call] = sent(fake, "POST", "/databases/db-1/imports");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      source: "s3",
      s3_storage_uuid: "s3-1",
      path: "/b.dump",
    });
  });
});

describe("generic API answers and requests", () => {
  it("a database GET answers its connection URLs with the password masked", async () => {
    await start();
    // Its answer carries validation_logs, so it runs only through api-call.
    const read = await apiCall("get-database-by-uuid", { uuid: "db-1" });
    expect(JSON.stringify(read.data)).not.toContain(DB_PASSWORD);
    expect(read.data).toMatchObject({
      data: {
        uuid: "db-1",
        internal_db_url: "postgres://postgres:[redacted]@db-1:5432/postgres",
        external_db_url:
          "postgres://postgres:[redacted]@203.0.113.5:5433/postgres",
        postgres_password: "[redacted]",
      },
    });
  });

  it("a proxy's raw Compose configuration is masked, in the answer and in the recorded request", async () => {
    await start();
    const compose = `services:\n  traefik:\n    environment:\n      - CF_DNS_API_TOKEN=${DB_PASSWORD}`;
    const read = await apiRead("get-server-proxy", { uuid: "srv-1" });
    expect(JSON.stringify(read.data)).not.toContain(DB_PASSWORD);
    expect(read.data).toMatchObject({
      data: { type: "TRAEFIK", configuration: "[redacted]" },
    });
    const saved = await apiCall(
      "save-server-proxy-configuration",
      { uuid: "srv-1" },
      { configuration: compose },
    );
    expect(JSON.stringify(saved.data)).not.toContain(DB_PASSWORD);
  });

  it("version and healthcheck answer text/html and still succeed", async () => {
    await start();
    expect((await apiRead("version")).data).toMatchObject({ data: "v4.7.5" });
    expect((await apiRead("healthcheck")).data).toMatchObject({ data: "OK" });
  });

  it("check-server-import sends both array query parameters, one pair per item", async () => {
    const { fake } = await start();
    await apiRead("check-server-import", {
      server_uuid: "srv-1",
      ip: "203.0.113.9",
      "system_github_apps[]": ["gh-1", "gh-2"],
      "system_gitlab_apps[]": ["gl-1"],
    });
    const [call] = sent(fake, "GET", "/servers/import/check");
    const query = new URL(call.url).searchParams;
    expect(query.getAll("system_github_apps[]")).toEqual(["gh-1", "gh-2"]);
    expect(query.getAll("system_gitlab_apps[]")).toEqual(["gl-1"]);
    expect(query.get("server_uuid")).toBe("srv-1");
  });

  it("an array query parameter takes only a list of scalars", async () => {
    const { fake } = await start();
    for (const bad of [{ a: 1 }, [["x"]], [{ a: 1 }]]) {
      await expect(
        apiRead("check-server-import", {
          server_uuid: "srv-1",
          ip: "203.0.113.9",
          "system_github_apps[]": bad,
        }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("generic API over MCP", () => {
  it("api-read refuses env, key and log reads, so MCP can't read secrets without Allow changes", async () => {
    const { harness: h, fake, connectionId } = await start();
    for (const [operationId, params] of [
      ["list-envs-by-application-uuid", { uuid: "app-web-uuid" }],
      ["get-private-key-by-uuid", { uuid: "key-1" }],
      ["get-application-logs-by-uuid", { uuid: "app-web-uuid" }],
    ] as const) {
      const reply = await handleMcp(h.mock.ctx, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "coolify__api_read",
          arguments: {
            connectionId,
            operationId,
            params: JSON.stringify(params),
          },
        },
      });
      const result = reply?.result as {
        isError: boolean;
        content: { text: string }[];
      };
      expect(result.isError, operationId).toBe(true);
      expect(result.content[0].text, operationId).toContain("api-call");
    }
    expect(fake.calls).toEqual([]);
  });

  it("api-call is refused without allowMcpChanges; api-read is a read tool", async () => {
    const { harness: h, fake, connectionId } = await start();
    const refused = await handleMcp(h.mock.ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "coolify__api_call",
        arguments: {
          connectionId,
          operationId: "deploy-by-tag-or-uuid",
          params: JSON.stringify({ uuid: "app-web-uuid" }),
          confirmed: true,
        },
      },
    });
    const result = refused?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mcp-changes-off");
    expect(fake.calls).toEqual([]);

    const read = await handleMcp(h.mock.ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "coolify__api_read",
        arguments: { connectionId, operationId: "list-projects" },
      },
    });
    const readResult = read?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(readResult.isError).toBe(false);
    expect(readResult.content[0].text).toContain("proj-1");
    const tools = (await handleMcp(h.mock.ctx, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    }))!.result as {
      tools: { name: string; annotations: { readOnlyHint: boolean } }[];
    };
    expect(
      tools.tools.find((t) => t.name === "coolify__api_read")!.annotations
        .readOnlyHint,
    ).toBe(true);
  });
});
