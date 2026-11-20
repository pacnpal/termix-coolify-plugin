import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginContext,
  PluginOperationInvokeOptions,
  PluginOperationOutcome,
} from "@termix-ssh/plugin-sdk/backend";
import { healthyCoolify } from "../helpers/fake-coolify.js";
import {
  OTHER,
  OWNER,
  startPlugin,
  type PluginHarness,
} from "../helpers/plugin.js";
import { resourceLists } from "../helpers/resources.js";
import { withRunHistory } from "../helpers/run-history.js";
import { handleMcp } from "../../../src/backend/mcp/server.js";
import { takeOnceUrl } from "../../../src/backend/status/service.js";

const CHOSEN = ["app-web-uuid", "app-api-uuid"];
const SHOWN_ONCE = "Status page URL (shown once, not stored): ";
const URL_PATTERN =
  /https:\/\/termix\.test\/plugin-api\/coolify\/status\/[A-Za-z0-9_-]{43}/;

type Run = (
  actionId: string,
  options?: PluginOperationInvokeOptions,
) => Promise<PluginOperationOutcome>;

let harness: PluginHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start() {
  const fake = healthyCoolify(resourceLists());
  harness = await startPlugin({
    fetch: fake.fetch,
    settings: { allowMcpChanges: true },
  });
  const created = await harness.request("POST", "/connections", {
    name: "Prod",
    baseUrl: "https://coolify.example.test",
    token: "fake-token-mcp-status",
  });
  const runs = withRunHistory(harness.mock);
  return { harness, runs, id: created.body.id as number };
}

/** The plugin's ctx with ctx.operations.run answered by `run`, as core's gate would. */
function withRun(ctx: PluginContext, run: Run): PluginContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "operations") return { ...target.operations, run };
      return Reflect.get(target, prop);
    },
  });
}

/** Core's run path, with history kept the way core stores it. */
function recorded(runs: ReturnType<typeof withRunHistory>): Run {
  return (id, options) => runs.run(id, options?.input ?? {});
}

function call(id: number, name: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

type Answer = Record<string, unknown> | null;

function texts(answer: Answer): string[] {
  const result = answer?.result as { content: { text: string }[] };
  return result.content.map((c) => c.text);
}

function isError(answer: Answer): boolean {
  return (answer?.result as { isError: boolean }).isError;
}

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

describe("status page URLs over MCP", () => {
  it("status-page create and rotate over tools/call return the URL once", async () => {
    const { harness, runs, id } = await start();
    const ctx = withRun(harness.mock.ctx, recorded(runs));
    harness.mock.setActor(OWNER);

    const created = await handleMcp(
      ctx,
      call(1, "coolify__status_page_create", {
        connectionId: String(id),
        title: "Shop status",
        resources: CHOSEN,
      }),
    );
    expect(isError(created)).toBe(false);
    const [body, shown] = texts(created);
    expect(shown.startsWith(SHOWN_ONCE)).toBe(true);
    const url = shown.slice(SHOWN_ONCE.length);
    expect(url).toMatch(URL_PATTERN);
    expect(body).not.toContain(tokenOf(url));
    const data = JSON.parse(body).data as { id: number; handoffId: string };
    expect(takeOnceUrl(OWNER, data.handoffId)).toBeNull();
    expect(takeOnceUrl(OTHER, data.handoffId)).toBeNull();
    expect(
      (await harness.raw("GET", `/status/${tokenOf(url)}`, "anon")).status,
    ).toBe(200);

    const rotated = await handleMcp(
      ctx,
      call(2, "coolify__status_page_rotate", {
        id: String(data.id),
        confirmed: true,
      }),
    );
    expect(isError(rotated)).toBe(false);
    const [rotBody, rotShown] = texts(rotated);
    const next = rotShown.slice(SHOWN_ONCE.length);
    expect(rotShown.startsWith(SHOWN_ONCE)).toBe(true);
    expect(next).toMatch(URL_PATTERN);
    expect(next).not.toBe(url);
    expect(rotBody).not.toContain(tokenOf(next));
    const rotData = JSON.parse(rotBody).data as { handoffId: string };
    expect(takeOnceUrl(OWNER, rotData.handoffId)).toBeNull();

    const history = JSON.stringify(runs.history);
    for (const leaked of [url, next]) {
      expect(history).not.toContain(tokenOf(leaked));
    }
  });

  it("take_status_page_url returns the URL of a run that was approved after its tools/call had already answered with the run id", async () => {
    const { harness, runs, id } = await start();
    harness.mock.setActor(OWNER);
    const page = await runs.run("coolify.status-page-create", {
      connectionId: String(id),
      title: "Shop status",
      resources: CHOSEN,
    });
    takeOnceUrl(OWNER, (page.data as { handoffId: string }).handoffId);
    const pageId = String((page.data as { id: number }).id);

    const waiting: Run = async () => ({
      runId: "run-mcp-approval-1",
      status: "awaiting_approval",
      approvalId: "approval-1",
    });
    const pending = await handleMcp(
      withRun(harness.mock.ctx, waiting),
      call(3, "coolify__status_page_rotate", { id: pageId, confirmed: true }),
    );
    expect(texts(pending)).toHaveLength(1);
    expect(texts(pending)[0]).toContain("run-mcp-approval-1");

    // Approved: core runs the handler with that run id, as the same actor.
    await harness.mock.actAs(OWNER, () =>
      runs.run(
        "coolify.status-page-rotate",
        { id: pageId },
        { runId: "run-mcp-approval-1" },
      ),
    );
    const taken = await handleMcp(
      harness.mock.ctx,
      call(4, "take_status_page_url", { handoffId: "run-mcp-approval-1" }),
    );
    expect(isError(taken)).toBe(false);
    expect(texts(taken).join("\n")).toMatch(URL_PATTERN);
    const again = await handleMcp(
      harness.mock.ctx,
      call(5, "take_status_page_url", { handoffId: "run-mcp-approval-1" }),
    );
    expect(isError(again)).toBe(true);
    expect(texts(again).join("\n")).not.toMatch(URL_PATTERN);
  });

  it("a REST operations:run caller takes the URL over MCP, for create and rotate", async () => {
    const { harness, runs, id } = await start();
    harness.mock.setActor(OWNER);
    const created = await runs.run("coolify.status-page-create", {
      connectionId: String(id),
      title: "Shop status",
      resources: CHOSEN,
    });
    const pageId = String((created.data as { id: number }).id);
    const rotated = await runs.run("coolify.status-page-rotate", {
      id: pageId,
    });
    const urls: string[] = [];
    for (const outcome of [created, rotated]) {
      const { handoffId } = outcome.data as { handoffId: string };
      const take = () =>
        handleMcp(
          harness.mock.ctx,
          call(6, "take_status_page_url", { handoffId }),
        );
      harness.mock.setActor(OTHER);
      const asOther = await take();
      expect(isError(asOther)).toBe(true);
      expect(texts(asOther).join("\n")).not.toMatch(URL_PATTERN);
      harness.mock.setActor(OWNER);
      const asOwner = await take();
      expect(isError(asOwner)).toBe(false);
      const url = texts(asOwner).join("\n").match(URL_PATTERN)![0];
      urls.push(url);
      const second = await take();
      expect(isError(second)).toBe(true);
      expect(texts(second).join("\n")).not.toMatch(URL_PATTERN);
    }
    expect(urls[0]).not.toBe(urls[1]);
    const history = JSON.stringify(runs.history);
    for (const url of urls) expect(history).not.toContain(tokenOf(url));
  });

  it("take_status_page_url needs a handoff id", async () => {
    const { harness } = await start();
    const answer = await handleMcp(
      harness.mock.ctx,
      call(7, "take_status_page_url", {}),
    );
    expect(isError(answer)).toBe(true);
  });
});
