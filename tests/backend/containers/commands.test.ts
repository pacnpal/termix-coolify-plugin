import { describe, expect, it } from "vitest";
import {
  assertContainerName,
  DB_CONSOLES,
  engineOf,
  shellCommand,
} from "../../../src/backend/containers/commands.js";

/** Values a container's environment could hold; none may reach a command. */
const FIXTURE_ENV = {
  POSTGRES_USER: "fake-pg-user",
  POSTGRES_PASSWORD: "FAKE-PG-SECRET",
  POSTGRES_DB: "fake-pg-db",
  MYSQL_ROOT_PASSWORD: "FAKE-MYSQL-SECRET",
  MARIADB_ROOT_PASSWORD: "FAKE-MARIADB-SECRET",
  MONGO_INITDB_ROOT_USERNAME: "fake-mongo-user",
  MONGO_INITDB_ROOT_PASSWORD: "FAKE-MONGO-SECRET",
  REDIS_PASSWORD: "FAKE-REDIS-SECRET",
  CLICKHOUSE_PASSWORD: "FAKE-CLICKHOUSE-SECRET",
};

/** The command with every single-quoted part removed: what the host shell expands. */
function unquoted(command: string): string {
  return command.replace(/'[^']*'/g, "");
}

describe("container shell commands", () => {
  it("bad container name throws", () => {
    for (const bad of [
      "web;rm -rf /",
      "web$(id)",
      "web`id`",
      "web name",
      "web|cat",
      "web&",
      "web\nid",
      "-it",
      "--privileged",
      "",
      "web'",
      'web"',
    ]) {
      expect(() => assertContainerName(bad), JSON.stringify(bad)).toThrow();
      expect(
        () => shellCommand(bad, { sudo: false, shell: "sh", mode: "shell" }),
        JSON.stringify(bad),
      ).toThrow();
    }
    expect(assertContainerName("web-app_1.2")).toBe("web-app_1.2");
  });

  it("a container name with ; or $( is refused", () => {
    expect(() => assertContainerName("abc;id")).toThrow();
    expect(() => assertContainerName("abc$(id)")).toThrow();
  });

  it("builds a shell with bash or sh, and sudo when asked", () => {
    expect(
      shellCommand("web-1", { sudo: false, shell: "bash", mode: "shell" }),
    ).toBe("docker exec -it web-1 bash");
    expect(
      shellCommand("web-1", { sudo: true, shell: "sh", mode: "shell" }),
    ).toBe("sudo docker exec -it web-1 sh");
  });

  it("no database console command contains a password, for any engine", () => {
    const engines = Object.keys(DB_CONSOLES);
    expect(engines.sort()).toEqual(
      [
        "clickhouse",
        "dragonfly",
        "keydb",
        "mariadb",
        "mongodb",
        "mysql",
        "postgresql",
        "redis",
        "sqlite",
      ].sort(),
    );
    for (const engine of engines) {
      for (const sudo of [false, true]) {
        const command = shellCommand("db-1", {
          sudo,
          shell: "sh",
          mode: "db",
          engine,
        });
        expect(command, engine).toContain(DB_CONSOLES[engine].client);
        expect(command, engine).not.toContain("REDACTED");
        for (const value of Object.values(FIXTURE_ENV)) {
          expect(command, engine).not.toContain(value);
        }
        // Every variable expands inside the container, never on the host.
        expect(unquoted(command), engine).not.toContain("$");
        expect(command, engine).toMatch(
          /^(sudo )?docker exec -it db-1 sh -c '/,
        );
      }
    }
  });

  it("reads each engine's credentials from the container's own variables", () => {
    const pg = shellCommand("db-1", {
      sudo: false,
      shell: "sh",
      mode: "db",
      engine: "postgresql",
    });
    expect(pg).toBe(
      `docker exec -it db-1 sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" "$POSTGRES_DB"'`,
    );
    expect(DB_CONSOLES.mysql.script).toContain("$MYSQL_ROOT_PASSWORD");
    expect(DB_CONSOLES.mariadb.script).toContain("$MARIADB_ROOT_PASSWORD");
    expect(DB_CONSOLES.mongodb.script).toContain("$MONGO_INITDB_ROOT_PASSWORD");
    expect(DB_CONSOLES.redis.script).toContain("$REDIS_PASSWORD");
    expect(DB_CONSOLES.keydb.script).toContain("$REDIS_PASSWORD");
    expect(DB_CONSOLES.dragonfly.script).toContain("$REDIS_PASSWORD");
    expect(DB_CONSOLES.clickhouse.script).toContain("$CLICKHOUSE_PASSWORD");
  });

  it("refuses a database console for an engine it doesn't know", () => {
    expect(() =>
      shellCommand("db-1", {
        sudo: false,
        shell: "sh",
        mode: "db",
        engine: "oracle",
      }),
    ).toThrow();
  });

  it("maps Coolify database types and part images to an engine", () => {
    expect(engineOf("standalone-postgresql")).toBe("postgresql");
    expect(engineOf("postgres:16-alpine")).toBe("postgresql");
    expect(engineOf("standalone-mysql")).toBe("mysql");
    expect(engineOf("standalone-mariadb")).toBe("mariadb");
    expect(engineOf("mariadb:11")).toBe("mariadb");
    expect(engineOf("standalone-mongodb")).toBe("mongodb");
    expect(engineOf("standalone-redis")).toBe("redis");
    expect(engineOf("redis:7-alpine")).toBe("redis");
    expect(engineOf("standalone-keydb")).toBe("keydb");
    expect(engineOf("standalone-dragonfly")).toBe("dragonfly");
    expect(engineOf("standalone-clickhouse")).toBe("clickhouse");
    expect(engineOf("n8nio/n8n:1.0")).toBeNull();
    expect(engineOf(null)).toBeNull();
  });
});
