import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";

/**
 * Docker container names this plugin puts in a command. Docker's own names
 * fit; anything else (spaces, quotes, `;`, `$(`) is refused, never quoted
 * around. A leading `-` is refused too, so a name can't read as an option.
 */
export const CONTAINER_NAME = /^[A-Za-z0-9_.-]+$/;

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export function assertContainerName(name: unknown): string {
  if (
    typeof name !== "string" ||
    name.length > 255 ||
    !CONTAINER_NAME.test(name) ||
    name.startsWith("-")
  ) {
    throw new CommandError("Not a container name");
  }
  return name;
}

export type ConsoleEngine =
  | "postgresql"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "keydb"
  | "dragonfly"
  | "clickhouse"
  | "sqlite";

/**
 * The native client per engine and the script that starts it inside the
 * container. Each script only names the container's own variables (the ones
 * Coolify's Start* actions set in v4.7.5), so `$` expands in the container's
 * shell: no password is in the command, a route answer or a log.
 */
export const DB_CONSOLES: Record<string, { client: string; script: string }> = {
  postgresql: {
    client: "psql",
    script: `PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" "$POSTGRES_DB"`,
  },
  mysql: {
    client: "mysql",
    script: `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root "$MYSQL_DATABASE"`,
  },
  mariadb: {
    client: "mariadb",
    // Older MariaDB images ship only the mysql client name.
    script: `MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec "$(command -v mariadb || echo mysql)" -u root "$MARIADB_DATABASE"`,
  },
  mongodb: {
    client: "mongosh",
    script: `exec mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin "\${MONGO_INITDB_DATABASE:-admin}"`,
  },
  redis: {
    client: "redis-cli",
    script: `REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli \${REDIS_USERNAME:+--user "$REDIS_USERNAME"}`,
  },
  keydb: {
    client: "keydb-cli",
    script: `REDISCLI_AUTH="$REDIS_PASSWORD" exec keydb-cli`,
  },
  dragonfly: {
    // Coolify's Dragonfly health check uses the redis-cli in the image.
    client: "redis-cli",
    script: `REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli`,
  },
  clickhouse: {
    client: "clickhouse-client",
    script: `exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"`,
  },
  sqlite: {
    client: "sqlite3",
    script: `exec sqlite3 "$SQLITE_DATABASE"`,
  },
};

/** Most specific first: "mariadb" before "mysql", "keydb" before "redis". */
const ENGINE_WORDS: Array<[ConsoleEngine, RegExp]> = [
  ["postgresql", /postgres|postgis|timescale|pgvector/],
  ["mariadb", /mariadb/],
  ["mysql", /mysql/],
  ["mongodb", /mongo/],
  ["keydb", /keydb/],
  ["dragonfly", /dragonfly/],
  ["redis", /redis|valkey/],
  ["clickhouse", /clickhouse/],
  ["sqlite", /sqlite/],
];

/**
 * The console for a resource's engine: a Coolify database type like
 * "standalone-postgresql", or a service database Part's image. Null when
 * there is no known console for it.
 */
export function engineOf(
  engine: string | null | undefined,
): ConsoleEngine | null {
  if (typeof engine !== "string" || !engine) return null;
  const text = engine.toLowerCase();
  for (const [name, pattern] of ENGINE_WORDS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

export interface ShellOptions {
  sudo: boolean;
  shell: "bash" | "sh";
  mode: "shell" | "db";
  engine?: string;
}

/**
 * The `docker exec` line a terminal runs on the Linked host. The container
 * name is checked, not quoted; the console script is one quoted argument.
 */
export function shellCommand(container: string, opts: ShellOptions): string {
  const name = assertContainerName(container);
  const docker = `${opts.sudo ? "sudo " : ""}docker exec -it ${name}`;
  if (opts.mode === "shell") {
    if (opts.shell !== "bash" && opts.shell !== "sh") {
      throw new CommandError("Unknown shell");
    }
    return `${docker} ${opts.shell}`;
  }
  const console =
    opts.engine &&
    Object.prototype.hasOwnProperty.call(DB_CONSOLES, opts.engine)
      ? DB_CONSOLES[opts.engine]
      : null;
  if (!console) throw new CommandError("No console for this engine");
  return `${docker} sh -c ${shellQuote(console.script)}`;
}

/** A docker command for a probe over SSH; `sudo -n` never waits for a password. */
export function dockerPrefix(sudo: boolean): string {
  return sudo ? "sudo -n docker" : "docker";
}
