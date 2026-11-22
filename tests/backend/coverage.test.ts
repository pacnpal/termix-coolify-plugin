import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXCLUDED_OPERATIONS,
  OPERATIONS,
} from "../../src/backend/coolify/generated/operations.js";
import { meetsMinVersion } from "../../src/backend/coolify/version.js";
import { byText } from "./helpers/order.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SPEC_FILES = [
  "vendor/coolify/openapi-v4.7.5.json",
  "vendor/coolify/openapi-main.json",
  "vendor/coolify/openapi-next.json",
];
const METHODS = ["get", "post", "put", "patch", "delete"];

interface SpecOperation {
  id: string;
  method: string;
  path: string;
}

// Read the vendored specs directly, never through the generated code.
function specOperations(file: string): SpecOperation[] {
  const spec = JSON.parse(readFileSync(root + file, "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const operations: SpecOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      if (!operation.operationId) {
        throw new Error(`${file}: ${method} ${path} has no operationId`);
      }
      operations.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path,
      });
    }
  }
  return operations;
}

const specUnion = new Map<string, SpecOperation>();
for (const file of SPEC_FILES) {
  for (const operation of specOperations(file)) {
    if (!specUnion.has(operation.id)) specUnion.set(operation.id, operation);
  }
}
const unionIds = [...specUnion.keys()].sort(byText);

interface CoverageRow {
  id: string;
  status: "used" | "skipped";
  note: string;
}

function coverageRows(): CoverageRow[] {
  const text = readFileSync(root + "docs/coverage.md", "utf8");
  const rows: CoverageRow[] = [];
  for (const line of text.split("\n")) {
    const match =
      /^\|\s*`?([A-Za-z0-9_-]+)`?\s*\|\s*(used|skipped)\s*\|(.*)\|\s*$/.exec(
        line,
      );
    if (match) {
      rows.push({
        id: match[1],
        status: match[2] as CoverageRow["status"],
        note: match[3].trim(),
      });
    }
  }
  return rows;
}

describe("Coolify coverage contract", () => {
  it("every spec operation is listed in docs/coverage.md", () => {
    const ids = coverageRows().map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort(byText)).toEqual(unionIds);
  });

  it("generated operations match the vendored specs", () => {
    expect(OPERATIONS.map((o) => o.id).sort(byText)).toEqual(unionIds);
    for (const operation of OPERATIONS) {
      const fromSpec = specUnion.get(operation.id)!;
      expect({ method: operation.method, path: operation.path }).toEqual({
        method: fromSpec.method,
        path: fromSpec.path,
      });
    }
  });

  it("no row is blank", () => {
    const blank = coverageRows().filter((row) => row.note === "");
    expect(blank).toEqual([]);
  });

  it("excluded operations are the disable-API call and are skipped", () => {
    const disable = [...specUnion.values()].find(
      (o) => o.method === "POST" && o.path === "/disable",
    );
    expect(disable).toBeDefined();
    expect(EXCLUDED_OPERATIONS.has(disable!.id)).toBe(true);
    const rows = new Map(coverageRows().map((row) => [row.id, row]));
    for (const id of EXCLUDED_OPERATIONS) {
      expect(rows.get(id)?.status).toBe("skipped");
    }
  });

  it("influxdb create is tagged next", () => {
    const influx = OPERATIONS.find((o) => o.id === "create-database-influxdb");
    expect(influx).toMatchObject({ source: "next", minVersion: "4.8.0" });
  });

  it("baseline operations are available from 4.4.0", () => {
    const baseline = OPERATIONS.filter((o) => o.source === "4.7.5");
    expect(baseline.length).toBeGreaterThan(0);
    for (const operation of baseline) {
      expect(operation.minVersion).toBe("4.4.0");
    }
  });

  it("a nightly counts as its release", () => {
    expect(meetsMinVersion("4.8.0-alpha.2", "4.8.0")).toBe(true);
    expect(meetsMinVersion("4.8.0-nightly", "4.8.0")).toBe(true);
    expect(meetsMinVersion("4.7.5", "4.8.0")).toBe(false);
  });

  it("compares versions numerically, part by part", () => {
    expect(meetsMinVersion("4.10.0", "4.8.0")).toBe(true);
    expect(meetsMinVersion("v4.7.6", "4.7.6")).toBe(true);
    expect(meetsMinVersion("4.4.0", "4.4.0")).toBe(true);
    expect(meetsMinVersion("4.3.9", "4.4.0")).toBe(false);
    expect(meetsMinVersion("5.0.0-beta.1", "4.8.0")).toBe(true);
    expect(meetsMinVersion("not a version", "4.4.0")).toBe(false);
  });
});
