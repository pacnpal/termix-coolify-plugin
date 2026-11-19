import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";

/** One canned answer: a JSON body, or a full Response for anything else. */
export type FakeAnswer =
  | { status?: number; json?: unknown; text?: string; contentType?: string }
  | (() => Response);

export interface FakeCall {
  method: string;
  path: string;
  url: string;
  init: PluginFetchInit | undefined;
}

/**
 * A fake Coolify API for ctx.fetch. Routes are "METHOD /path" under /api/v1,
 * without the query. Anything unrouted answers 404, so a test never reaches a
 * real instance.
 */
export function fakeCoolify(
  routes: Record<string, FakeAnswer> = {},
  base = "https://coolify.example.test",
) {
  const calls: FakeCall[] = [];
  const table = { ...routes };
  const fetch = async (url: string, init?: PluginFetchInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const prefix = `${base}/api/v1`;
    const path = url.startsWith(prefix)
      ? url.slice(prefix.length).split("?")[0]
      : url;
    calls.push({ method, path, url, init });
    const answer = table[`${method} ${path}`];
    if (!answer) {
      return new Response(JSON.stringify({ message: "Not found." }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (typeof answer === "function") return answer();
    if (answer.text !== undefined) {
      return new Response(answer.text, {
        status: answer.status ?? 200,
        headers: { "content-type": answer.contentType ?? "text/html" },
      });
    }
    return new Response(JSON.stringify(answer.json ?? null), {
      status: answer.status ?? 200,
      headers: { "content-type": answer.contentType ?? "application/json" },
    });
  };
  return {
    fetch,
    calls,
    set(route: string, answer: FakeAnswer) {
      table[route] = answer;
    },
  };
}

/** The answers a healthy, unscoped Coolify 4.7.5 gives the probe. */
export function healthyCoolify(overrides: Record<string, FakeAnswer> = {}) {
  return fakeCoolify({
    "GET /health": { text: "OK" },
    "GET /version": { text: "v4.7.5" },
    "GET /team": { json: { id: 7, name: "Ops team" } },
    "GET /projects": {
      json: [{ id: 2, uuid: "proj-uuid", name: "Shop", team_id: 7 }],
    },
    "GET /security/keys": {
      json: [{ id: 3, uuid: "key-uuid", name: "deploy key" }],
    },
    "GET /security/keys/key-uuid": {
      json: {
        id: 3,
        uuid: "key-uuid",
        name: "deploy key",
        private_key:
          "-----BEGIN FAKE PRIVATE KEY-----\nnot-a-real-key\n-----END FAKE PRIVATE KEY-----",
        fingerprint: "SHA256:fake",
      },
    },
    "GET /applications": {
      json: [{ id: 11, uuid: "app-web-uuid", name: "web", status: "running" }],
    },
    "GET /databases": { json: [] },
    "GET /applications/app-web-uuid/logs": { json: { logs: "a line" } },
    "GET /settings/email": { status: 403, json: { message: "Forbidden." } },
    ...overrides,
  });
}
