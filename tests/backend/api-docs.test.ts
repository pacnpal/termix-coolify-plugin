import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manifest } from "./helpers/plugin.js";
import { EXTRA_TOOLS, toolName } from "../../src/backend/mcp/server.js";
import { byText } from "./helpers/order.js";

/**
 * Actions with no plugin route: they run only through Termix's operations
 * (and MCP), so core's confirm, approvals and history always apply.
 */
const NO_ROUTE = new Set(["coolify.exec"]);

const doc = readFileSync(new URL("../../docs/api.md", import.meta.url), "utf8");

/** Rows of the operations table, by operation id, as their cells. */
function rows(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of doc.split("\n")) {
    const match = /^\|\s*`(coolify\.[a-z0-9.-]+)`\s*\|/.exec(line);
    if (!match) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    out.set(match[1], cells);
  }
  return out;
}

describe("docs/api.md", () => {
  it("every operation in manifest.json has a docs/api.md row and vice versa", () => {
    const declared = manifest
      .contributes!.operations!.actions!.map((a) => a.id)
      .sort(byText);
    expect([...rows().keys()].sort(byText)).toEqual(declared);
  });

  it("each row gives the route, run path, key scope, MCP tool and a curl example", () => {
    const table = rows();
    for (const action of manifest.contributes!.operations!.actions!) {
      const [, route, runPath, scope, tool, curl] = table.get(action.id)!;
      if (NO_ROUTE.has(action.id)) {
        expect(route, action.id).toBe("none");
      } else {
        expect(route, action.id).toMatch(
          /`(GET|POST|PATCH|PUT|DELETE) \/plugin-api\/coolify\/[^`]*`/,
        );
      }
      expect(runPath, action.id).toBe(`\`/operations/${action.id}/run\``);
      expect(scope, action.id).toContain(
        action.risk === "read" ? "`operations:read`" : "`operations:run`",
      );
      if (action.risk !== "read") {
        expect(scope, action.id).not.toContain("`operations:read`");
      }
      expect(tool, action.id).toBe(`\`${toolName(action.id)}\``);
      expect(curl, action.id).toContain(`/operations/${action.id}/run`);
      expect(curl, action.id).toMatch(/^`curl /);
      expect(curl, action.id).toContain("$TERMIX_API_KEY");
    }
  });

  it("each curl example is runnable: a POST with a JSON body holding every required input", () => {
    const table = rows();
    for (const action of manifest.contributes!.operations!.actions!) {
      const curl = table.get(action.id)![5];
      expect(curl, action.id).toContain("-X POST");
      expect(curl, action.id).toContain('-H "Content-Type: application/json"');
      const body = /-d '([^']*)'/.exec(curl);
      expect(body, action.id).not.toBeNull();
      const json = JSON.parse(body![1]) as {
        input?: Record<string, unknown>;
        confirmed?: unknown;
      };
      for (const field of action.inputs ?? []) {
        if (field.required) {
          expect(json.input, action.id).toHaveProperty(field.key);
        }
      }
      if (action.scope !== "server") {
        expect(json, action.id).toHaveProperty("hostId");
      }
      if (action.scope === "resource") {
        expect(json, action.id).toHaveProperty("resourceKey");
      }
      if (action.risk === "destructive") {
        expect(json.confirmed, action.id).toBe(true);
      }
    }
  });

  it("names the MCP endpoint and every extra MCP tool", () => {
    expect(doc).toContain("/plugin-api/coolify/mcp");
    for (const tool of EXTRA_TOOLS) expect(doc).toContain(`\`${tool.name}\``);
  });
});
