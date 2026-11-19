import type { CoolifyApi } from "../coolify/api.js";
import type { ResourceKind } from "../coolify/dto.js";
import {
  CoolifyError,
  type CoolifyCause,
  type CoolifyHttp,
} from "../coolify/http.js";
import { meetsMinVersion } from "../coolify/version.js";

/** The oldest Coolify the plugin supports. */
export const MIN_COOLIFY_VERSION = "4.4.0";

/** What the token may do, as far as can be told without changing anything. */
export interface Abilities {
  read: boolean;
  /** read:sensitive: key material, logs, env values. */
  sensitive: boolean;
  /** Private keys are readable (needs an unscoped token with read:sensitive). */
  keys: boolean;
  root: boolean;
  /** Coolify's own MCP endpoint answers (set by the MCP client, later). */
  mcp: boolean;
}

export interface ProbeStep {
  id: string;
  ok: boolean;
  cause?: CoolifyCause;
}

export interface ProbeResult {
  ok: boolean;
  version: string | null;
  teamName: string | null;
  teamId: string | null;
  scoped: boolean;
  abilities: Abilities;
  steps: ProbeStep[];
}

function causeOf(err: unknown): CoolifyCause {
  return err instanceof CoolifyError ? err.cause : "upstream";
}

/** Causes that mean the address isn't a usable Coolify API at all: nothing after them can work. */
const FATAL: ReadonlySet<CoolifyCause> = new Set([
  "unreachable",
  "access-redirect",
  "not-coolify",
  "unauthorized",
  "api-disabled",
]);

/**
 * Runs the checks in the design's "Connection setup and ability probe", in
 * order, without changing anything in Coolify. Key material read on the way
 * is dropped by the DTO layer before it reaches here.
 */
export async function runProbe(
  api: CoolifyApi,
  http: CoolifyHttp,
): Promise<ProbeResult> {
  const steps: ProbeStep[] = [];
  const result: ProbeResult = {
    ok: false,
    version: null,
    teamName: null,
    teamId: null,
    scoped: false,
    abilities: {
      read: false,
      sensitive: false,
      keys: false,
      root: false,
      mcp: false,
    },
    steps,
  };
  const fail = (id: string, cause: CoolifyCause) => {
    steps.push({ id, ok: false, cause });
  };

  // 1. Health and version, both allowed for every token.
  try {
    await http.request<string>("GET", "/health", { text: true });
    steps.push({ id: "health", ok: true });
  } catch (err) {
    fail("health", causeOf(err));
    if (FATAL.has(causeOf(err))) return result;
  }
  try {
    result.version = await api.version();
  } catch (err) {
    fail("version", causeOf(err));
    return result;
  }
  if (!meetsMinVersion(result.version, MIN_COOLIFY_VERSION)) {
    fail("version", "unsupported-version");
    return result;
  }
  steps.push({ id: "version", ok: true });

  // 2 and 3. Scope first, then the team id for instanceKey.
  try {
    const team = await api.team();
    result.teamId = team.id || null;
    result.teamName = team.name || null;
    steps.push({ id: "team", ok: true });
  } catch (err) {
    if (causeOf(err) !== "forbidden-ability") {
      fail("team", causeOf(err));
      return result;
    }
    result.scoped = true;
    steps.push({ id: "team", ok: true });
    try {
      const projects = await api.projects();
      result.teamId = projects.find((p) => p.teamId)?.teamId ?? null;
      steps.push({ id: "projects", ok: true });
    } catch (projectErr) {
      fail("projects", causeOf(projectErr));
      return result;
    }
  }
  result.abilities.read = true;
  result.ok = true;

  // 4. Abilities that can be read without side effects.
  if (result.scoped) {
    fail("keys", "forbidden-ability");
  } else {
    try {
      const [first] = await api.keys();
      result.abilities.keys = first
        ? (await api.key(first.uuid)).privateKeyReadable
        : false;
      steps.push({ id: "keys", ok: result.abilities.keys });
    } catch (err) {
      fail("keys", causeOf(err));
    }
  }

  let logsReadable = false;
  try {
    const target = await firstResource(api);
    if (target) {
      await api.logs(target.kind, target.uuid, { lines: 1 });
      logsReadable = true;
    }
    steps.push({ id: "logs", ok: logsReadable });
  } catch (err) {
    fail("logs", causeOf(err));
  }
  // Key material and logs both need read:sensitive (or root).
  result.abilities.sensitive = logsReadable || result.abilities.keys;

  if (result.scoped) {
    fail("root", "forbidden-ability");
  } else {
    try {
      result.abilities.root = await api.rootCheck();
      steps.push({ id: "root", ok: true });
    } catch (err) {
      fail("root", causeOf(err));
    }
  }
  if (result.abilities.root) result.abilities.sensitive = true;
  return result;
}

async function firstResource(
  api: CoolifyApi,
): Promise<{ kind: ResourceKind; uuid: string } | null> {
  const [app] = await api.applications();
  if (app) return { kind: "application", uuid: app.uuid };
  const [db] = await api.databases();
  if (db) return { kind: "database", uuid: db.uuid };
  return null;
}
