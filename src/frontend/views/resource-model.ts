import type { StatusTone } from "@termix-ssh/plugin-sdk/ui";
import type { Resource } from "../api";
import {
  resourceHealth,
  type ResourceHealth,
} from "../../shared/resource-health";

export type KindFilter = "all" | "application" | "service" | "database";
export type HealthFilter = "all" | ResourceHealth;

/** A top-level resource and, for a service, its Parts in Coolify's order. */
export interface ResourceGroup {
  resource: Resource;
  parts: Resource[];
}

export const HEALTH_TONE: Record<ResourceHealth, StatusTone> = {
  running: "ok",
  degraded: "warn",
  stopped: "idle",
  deploying: "info",
};

type T = (key: string, options?: Record<string, unknown>) => string;

/** Translated status word for a Coolify status. */
export function healthLabel(t: T, status: string): string {
  return t(`resources.health.${resourceHealth(status)}`);
}

export function kindLabel(t: T, kind: string): string {
  return t(`resources.kinds.${kind}`);
}

/** "Project / environment", or whichever of the two is known. */
export function placeLabel(t: T, r: Resource): string {
  if (r.projectName && r.environmentName) {
    return t("resources.place", {
      project: r.projectName,
      environment: r.environmentName,
    });
  }
  return r.projectName ?? r.environmentName ?? "";
}

export function serverLabel(r: Resource): string {
  return r.serverName ?? r.serverUuid ?? "";
}

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

/** Each service followed by its Parts. A Part whose service is missing stands alone. */
export function groupResources(rows: readonly Resource[]): ResourceGroup[] {
  const tops = new Set(rows.filter((r) => !r.parentUuid).map((r) => r.uuid));
  const parts = new Map<string, Resource[]>();
  for (const r of rows) {
    if (r.parentUuid && tops.has(r.parentUuid)) {
      const list = parts.get(r.parentUuid) ?? [];
      list.push(r);
      parts.set(r.parentUuid, list);
    }
  }
  return rows
    .filter((r) => !r.parentUuid || !tops.has(r.parentUuid))
    .map((r) => ({ resource: r, parts: parts.get(r.uuid) ?? [] }));
}

function topKind(r: Resource): KindFilter {
  if (r.kind === "service-application" || r.kind === "service-database") {
    return "service";
  }
  return r.kind;
}

function matchesText(r: Resource, needle: string): boolean {
  return [
    r.name,
    r.uuid,
    r.serverName,
    r.projectName,
    r.environmentName,
    r.engine,
    ...r.fqdns,
  ].some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
}

/**
 * Groups that pass the filters. A group passes when its resource or one of
 * its Parts matches the search and the status; the type is the top-level
 * resource's. A passing service shows all of its Parts.
 */
export function filterGroups(
  groups: readonly ResourceGroup[],
  filters: { search: string; kind: KindFilter; health: HealthFilter },
): ResourceGroup[] {
  const needle = filters.search.trim().toLowerCase();
  const matches = (r: Resource) =>
    (!needle || matchesText(r, needle)) &&
    (filters.health === "all" || resourceHealth(r.status) === filters.health);
  return groups.filter(
    (g) =>
      (filters.kind === "all" || topKind(g.resource) === filters.kind) &&
      (matches(g.resource) || g.parts.some(matches)),
  );
}
