import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type {
  ConnectionView,
  Connections,
} from "../../../src/backend/connections/service.js";
import { OPERATIONS } from "../../../src/backend/coolify/generated/operations.js";
import {
  createGenericApi,
  isSensitive,
  type GenericApiDeps,
} from "../../../src/backend/ops/api-generic.js";

const TOKEN = "fake-token-generic-safety";

function view(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: 1,
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    teamName: null,
    version: "4.7.5",
    scoped: false,
    abilities: {
      read: true,
      sensitive: true,
      keys: true,
      root: false,
      mcp: false,
    },
    lastError: null,
    autoSync: false,
    access: "owner",
    allowPrivate: false,
    caCert: null,
    cfAccess: false,
    lastCheckedAt: null,
    steps: [],
    revision: "rev-1",
    ...over,
  };
}

/** A generic API over stub services; `answer` is what Coolify sends back. */
function setup(opts: { revisionNow?: string; answer?: unknown } = {}) {
  const request = vi.fn(async () => opts.answer ?? { ok: true });
  const snapshot = vi.fn(async () => ({
    view: view(),
    api: {},
    http: { request },
    cfAccess: async () => null,
  }));
  const connections = {
    snapshot,
    revision: vi.fn(async () => opts.revisionNow ?? "rev-1"),
    get: vi.fn(async () => view()),
    list: vi.fn(async () => [view()]),
  } as unknown as Connections;
  const resources = { invalidate: vi.fn(async () => {}) };
  const servers = { invalidate: vi.fn(async () => {}) };
  const ctx = {
    rbac: { has: async () => true },
    audit: { record: vi.fn(async () => {}) },
  } as unknown as PluginContext;
  const deps: GenericApiDeps = { connections, resources, servers };
  return {
    api: createGenericApi(ctx, deps),
    request,
    snapshot,
    resources,
    servers,
  };
}

describe("generic API: sensitive operations", () => {
  it.each([
    "delete-application-by-uuid",
    "list-envs-by-application-uuid",
    "update-env-by-application-uuid",
    "list-team-shared-envs",
    "get-private-key-by-uuid",
    "list-private-keys",
    "list-cloud-tokens",
    "list-integration-tokens",
    "get-application-logs-by-uuid",
    "get-s3-storage-by-uuid",
    "get-current-team-email-notifications",
  ])("%s is sensitive", (id) => {
    expect(isSensitive(id)).toBe(true);
  });

  it.each(["list-servers", "get-application-by-uuid", "deploy-by-tag-or-uuid"])(
    "%s is not sensitive",
    (id) => {
      expect(isSensitive(id)).toBe(false);
    },
  );

  it("every DELETE is sensitive", () => {
    for (const op of OPERATIONS.filter((o) => o.method === "DELETE")) {
      expect(isSensitive(op.id), op.id).toBe(true);
    }
  });

  it("refuses a sensitive read unless confirmed, before asking Coolify", async () => {
    const { api, request } = setup();
    const input = {
      connectionId: 1,
      operationId: "list-envs-by-application-uuid",
      params: { uuid: "app-1" },
    };
    await expect(api.dispatch(input, { readOnly: true })).rejects.toMatchObject(
      { code: "confirm-required" },
    );
    await expect(api.dispatch(input)).rejects.toMatchObject({
      code: "confirm-required",
    });
    expect(request).not.toHaveBeenCalled();
    await api.dispatch(input, { confirmed: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses any change unless confirmed", async () => {
    const { api, request } = setup();
    await expect(
      api.dispatch({
        connectionId: 1,
        operationId: "deploy-by-tag-or-uuid",
        params: { uuid: "app-1" },
      }),
    ).rejects.toMatchObject({ code: "confirm-required" });
    expect(request).not.toHaveBeenCalled();
  });

  it("the read pickers leave sensitive reads out, and the list marks them", async () => {
    const { api } = setup();
    const reads = (await api.list(1, { readsOnly: true })).map((o) => o.id);
    expect(reads).toContain("list-servers");
    expect(reads).not.toContain("list-envs-by-application-uuid");
    expect(reads).not.toContain("get-private-key-by-uuid");
    const all = await api.list(1);
    expect(
      all.find((o) => o.id === "list-envs-by-application-uuid")?.sensitive,
    ).toBe(true);
    expect(all.find((o) => o.id === "list-servers")?.sensitive).toBe(false);
  });
});

describe("generic API: one snapshot per call", () => {
  it("reads the connection once, through its snapshot", async () => {
    const { api, snapshot } = setup();
    await api.dispatch({ connectionId: 1, operationId: "list-servers" });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("ends with target-changed when the connection changed before the call", async () => {
    const { api, request } = setup({ revisionNow: "rev-2" });
    await expect(
      api.dispatch({ connectionId: 1, operationId: "list-servers" }),
    ).rejects.toMatchObject({ code: "target-changed", status: 409 });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("generic API: request shape", () => {
  it("sends only the body fields the operation declares", async () => {
    const { api, request } = setup();
    await api.dispatch(
      {
        connectionId: 1,
        operationId: "update-application-by-uuid",
        params: { uuid: "app-1" },
        body: { name: "web", not_a_field: "x", __proto__x: 1 },
      },
      { confirmed: true },
    );
    const [, , sentOpts] = request.mock.calls[0] as unknown as [
      string,
      string,
      { body?: Record<string, unknown> },
    ];
    expect(sentOpts.body).toEqual({ name: "web" });
  });

  it("sends no body to an operation that takes none", async () => {
    const { api, request } = setup();
    await api.dispatch(
      {
        connectionId: 1,
        operationId: "deploy-by-tag-or-uuid",
        params: { uuid: "app-1" },
        body: { anything: true },
      },
      { confirmed: true },
    );
    const [, , sentOpts] = request.mock.calls[0] as unknown as [
      string,
      string,
      { body?: unknown },
    ];
    expect(sentOpts.body).toBeUndefined();
  });

  it("asks the request layer to scrub the connection's own secrets from the answer", async () => {
    const { api, request } = setup({ answer: { token: TOKEN } });
    const result = await api.dispatch({
      connectionId: 1,
      operationId: "list-servers",
    });
    const [, , sentOpts] = request.mock.calls[0] as unknown as [
      string,
      string,
      { scrubSecrets?: boolean },
    ];
    expect(sentOpts.scrubSecrets).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("generic API: caches", () => {
  it("a write drops the resources and server-status caches", async () => {
    const { api, resources, servers } = setup();
    await api.dispatch(
      {
        connectionId: 1,
        operationId: "deploy-by-tag-or-uuid",
        params: { uuid: "app-1" },
      },
      { confirmed: true },
    );
    expect(resources.invalidate).toHaveBeenCalledWith(1);
    expect(servers.invalidate).toHaveBeenCalledWith(1);
  });

  it("a failed write drops them too; a read drops nothing", async () => {
    const { api, request, resources, servers } = setup();
    await api.dispatch({ connectionId: 1, operationId: "list-servers" });
    expect(resources.invalidate).not.toHaveBeenCalled();
    expect(servers.invalidate).not.toHaveBeenCalled();
    request.mockRejectedValueOnce(new Error("boom"));
    await expect(
      api.dispatch(
        {
          connectionId: 1,
          operationId: "deploy-by-tag-or-uuid",
          params: { uuid: "app-1" },
        },
        { confirmed: true },
      ),
    ).rejects.toThrow();
    expect(resources.invalidate).toHaveBeenCalledWith(1);
    expect(servers.invalidate).toHaveBeenCalledWith(1);
  });
});
