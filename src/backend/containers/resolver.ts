import { shellQuote } from "@termix-ssh/plugin-sdk/host-scripts";
import type { ResourceDto } from "../coolify/dto.js";
import type { SshRunner } from "../ssh.js";
import { assertContainerName, dockerPrefix } from "./commands.js";

/** One container of a resource, as a choice when there are several. */
export interface ContainerChoice {
  name: string;
  running: boolean;
  /** The service Part it runs: its uuid, or its compose service name. */
  part: string | null;
}

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerError";
  }
}

type LabelType = "application" | "service" | "database";

function labelType(kind: ResourceDto["kind"]): LabelType {
  if (kind === "application") return "application";
  if (kind === "database") return "database";
  return "service";
}

const SUB_UUID = "coolify.service.subUuid";
const COMPOSE_SERVICE = "com.docker.compose.service";
const FORMAT = `{{.Names}}|{{.State}}|{{.Label "${SUB_UUID}"}}|{{.Label "${COMPOSE_SERVICE}"}}`;

/**
 * The `--filter` sets to try, in order, as Coolify v4.7.5 finds a resource's
 * containers: the uuid label first, then the labels from before Coolify
 * 4.4, which carry the numeric id. A service Part is matched by its
 * sub-uuid, then by its compose service name.
 */
export function filterSets(res: ResourceDto): string[][] {
  if (!res.uuid) return [];
  const type = labelType(res.kind);
  const isPart =
    res.kind === "service-application" || res.kind === "service-database";
  if (isPart) {
    const sets: string[][] = [
      [
        `label=${SUB_UUID}=${res.uuid}`,
        ...(res.parentUuid
          ? [`label=coolify.serviceUuid=${res.parentUuid}`]
          : []),
      ],
    ];
    if (res.parentUuid && res.name) {
      sets.push([
        `label=com.docker.compose.project=${res.parentUuid}`,
        `label=${COMPOSE_SERVICE}=${res.name}`,
      ]);
    }
    return sets;
  }
  // Without an id, Coolify's own fallback: the label is present at all.
  const idLabel =
    res.id !== null && Number.isSafeInteger(res.id)
      ? `label=coolify.${type}Id=${res.id}`
      : `label=coolify.${type}Id`;
  const sets: string[][] = [
    [`label=coolify.${type}Uuid=${res.uuid}`],
    [idLabel, `label=com.docker.compose.project=${res.uuid}`],
  ];
  if (type === "application") sets.push([idLabel, `name=${res.uuid}`]);
  return sets;
}

/** Reads `docker ps` lines; anything unexpected is left out. */
function parse(stdout: string, res: ResourceDto): ContainerChoice[] {
  const isPart =
    res.kind === "service-application" || res.kind === "service-database";
  const out: ContainerChoice[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("|");
    if (fields.length !== 4) continue;
    const [name, state, subUuid, composeService] = fields.map((f) => f.trim());
    try {
      assertContainerName(name);
    } catch {
      continue;
    }
    if (out.some((c) => c.name === name)) continue;
    out.push({
      name,
      running: state === "running",
      part: isPart ? res.uuid : subUuid || composeService || null,
    });
  }
  return out;
}

/**
 * The containers of a resource or Part on a Linked host, running or not.
 * The first filter set that finds any wins. Every value is quoted.
 */
export async function resolveContainers(
  run: SshRunner,
  hostId: number,
  res: ResourceDto,
  opts: { sudo?: boolean } = {},
): Promise<ContainerChoice[]> {
  const docker = dockerPrefix(opts.sudo === true);
  for (const filters of filterSets(res)) {
    const command = [
      `${docker} ps -a`,
      ...filters.map((f) => `--filter ${shellQuote(f)}`),
      `--format ${shellQuote(FORMAT)}`,
    ].join(" ");
    const result = await run(hostId, command);
    if (result.code !== 0) {
      throw new DockerError("docker ps failed on the Linked host");
    }
    const found = parse(result.stdout, res);
    if (found.length) return found;
  }
  return [];
}
