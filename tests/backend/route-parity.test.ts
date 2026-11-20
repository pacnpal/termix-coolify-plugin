import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manifest } from "./helpers/plugin.js";
import { served } from "./helpers/served.js";

const doc = readFileSync(new URL("../../docs/api.md", import.meta.url), "utf8");
const declared = new Set(
  manifest.contributes!.operations!.actions!.map((a) => a.id),
);

const ROUTE =
  /`((?:GET|POST|PATCH|PUT|DELETE) \/plugin-api\/coolify\/[^`?\s]*|WS \/plugin-ws\/coolify\/[^`?\s]*)/;

/** The "Route map" table of docs/api.md: each route or socket and its cell. */
function routeMap(): Map<string, string> {
  const start = doc.indexOf("\n## Route map\n");
  if (start < 0) return new Map();
  const end = doc.indexOf("\n## ", start + 1);
  const out = new Map<string, string>();
  for (const line of doc.slice(start, end < 0 ? undefined : end).split("\n")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const match = cells.length >= 2 ? ROUTE.exec(cells[0]) : null;
    if (match) out.set(match[1], cells[1]);
  }
  return out;
}

/** Routes the operations table names, from each action's own row. */
function routesOfActionRows(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of doc.split("\n")) {
    const row = /^\|\s*`(coolify\.[a-z0-9.-]+)`\s*\|([^|]*)\|/.exec(line);
    const route = row ? ROUTE.exec(row[2]) : null;
    if (row && route) out.set(row[1], route[1]);
  }
  return out;
}

describe("route parity", () => {
  it("every served route and socket is in docs/api.md's route map, and nothing else is", async () => {
    const { routes, sockets } = await served();
    expect([...routeMap().keys()].sort()).toEqual(
      [...routes, ...sockets].sort(),
    );
  });

  it("every route maps to a declared action, or says why it is not one", () => {
    for (const [route, cell] of routeMap()) {
      const ids = [...cell.matchAll(/`(coolify\.[a-z0-9.-]+)`/g)].map(
        (m) => m[1],
      );
      if (ids.length === 0) {
        expect(cell, route).toMatch(/^none: \S.{10,}/);
        continue;
      }
      for (const id of ids)
        expect(declared.has(id), `${route}: ${id}`).toBe(true);
    }
  });

  it("each action's own row names a route that is served", async () => {
    const { routes, sockets } = await served();
    const live = new Set([...routes, ...sockets]);
    for (const [id, route] of routesOfActionRows()) {
      expect(live.has(route), `${id}: ${route}`).toBe(true);
    }
  });

  it("each route an action's row names maps back to that action", () => {
    const map = routeMap();
    for (const [id, route] of routesOfActionRows()) {
      expect(map.get(route) ?? "", `${id}: ${route}`).toContain(`\`${id}\``);
    }
  });
});
