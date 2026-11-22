import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { tables } from "../../src/backend/tables.js";
import { byText } from "./helpers/order.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

const TABLES = [
  "p_coolify_connections",
  "p_coolify_grants",
  "p_coolify_webhooks",
  "p_coolify_servers",
  "p_coolify_cache",
  "p_coolify_events",
  "p_coolify_onboardings",
  "p_coolify_status_pages",
  "p_coolify_dns_records",
  "p_coolify_recent",
];

let db: TestDb | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function names(test: TestDb, type: "table" | "index"): string[] {
  const rows = test.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'p\\_coolify\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all(type) as { name: string }[];
  return rows.map((row) => row.name);
}

describe("plugin tables", () => {
  it("migrations create every table", async () => {
    db = await createTestDb(pluginDir);
    expect(names(db, "table")).toEqual([...TABLES].sort(byText));
  });

  it("every index carries the plugin prefix", async () => {
    db = await createTestDb(pluginDir);
    const indexes = db.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'p\\_coolify\\_%' ESCAPE '\\' AND sql IS NOT NULL",
      )
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThan(0);
    for (const { name } of indexes) {
      expect(name.startsWith("idx_p_coolify_")).toBe(true);
    }
  });

  it("deleting a host keeps its server row and address override", async () => {
    db = await createTestDb(pluginDir);
    db.sqlite.prepare("INSERT INTO ssh_data (id) VALUES (?)").run(7);
    db.sqlite
      .prepare(
        "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id, address_override) VALUES (?, ?, ?, ?)",
      )
      .run(1, "server-uuid-1", 7, "10.0.0.5");
    db.sqlite.prepare("DELETE FROM ssh_data WHERE id = ?").run(7);
    const row = db.sqlite
      .prepare(
        "SELECT server_uuid, address_override FROM p_coolify_servers WHERE connection_id = ?",
      )
      .get(1);
    expect(row).toEqual({
      server_uuid: "server-uuid-1",
      address_override: "10.0.0.5",
    });
  });

  it("every table can be defined through ctx.db", async () => {
    db = await createTestDb(pluginDir);
    const mock = createMockCtx({
      pluginId: manifest.id,
      manifest,
      sandbox: true,
      capabilities: manifest.capabilities,
      db: db.database,
    });
    for (const table of tables) {
      await expect(mock.ctx.db.define(table)).resolves.toBeTruthy();
    }
    expect(tables).toHaveLength(TABLES.length);
  });
});

describe("migration 0002 (tunnelApplied)", () => {
  it("marks every row linked before it as possibly tunnelled", async () => {
    db = await createTestDb(pluginDir, { skipMigrations: true });
    const sql = (name: string) =>
      readFileSync(`${pluginDir}/migrations/sqlite/${name}`, "utf8");
    db.sqlite.exec(sql("0001_create_tables.sql"));
    const insert = db.sqlite.prepare(
      "INSERT INTO p_coolify_servers (connection_id, server_uuid, host_id) VALUES (?, ?, ?)",
    );
    insert.run(1, "linked-before", 7);
    insert.run(1, "never-linked", null);

    db.sqlite.exec(sql("0002_update.sql"));
    const rows = db.sqlite
      .prepare(
        "SELECT server_uuid, tunnel_applied FROM p_coolify_servers ORDER BY server_uuid",
      )
      .all();
    // Unknown is treated as tunnelled: the next sync of a plain server
    // clears the tunnel, or waits for SSH Terminal to do so.
    expect(rows).toEqual([
      { server_uuid: "linked-before", tunnel_applied: 1 },
      { server_uuid: "never-linked", tunnel_applied: 0 },
    ]);
  });
});
