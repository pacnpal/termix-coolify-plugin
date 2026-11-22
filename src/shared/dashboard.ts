// What the dashboard cards and homepage widgets share with the backend: the
// card kinds, a card's saved settings, the answers of the two reads made for
// them, and how often each card reads again.

import type { ResourceCounts } from "./resource-health.js";

/** Coolify's vulnerability summary is kept this long, per connection. */
export const VULNERABILITIES_TTL_MS = 5 * 60_000;

export const CARD_KINDS = [
  "overview",
  "resource",
  "deployments",
  "vulnerabilities",
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/**
 * How often a shown card reads again: never faster than the backend cache
 * it reads turns over (resources 20 s, server statuses a minute, the
 * deployment queue 10 s, vulnerabilities five minutes), so a card never
 * costs Coolify a request the tab wouldn't make.
 */
export const CARD_POLL_MS: Record<CardKind, number> = {
  overview: 60_000,
  resource: 20_000,
  deployments: 10_000,
  vulnerabilities: VULNERABILITIES_TTL_MS,
};

/** A card's own settings, as the dashboard or homepage stores them. */
export interface CardConfig {
  card: CardKind;
  connectionId: number | null;
  /** The resource of a single resource card. */
  uuid: string | null;
}

const UUID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Reads saved settings, keeping only what is well formed: a stored value is
 * whatever the dashboard kept, so anything else reads as not chosen yet.
 */
export function readCardConfig(raw: unknown, fallback: CardKind): CardConfig {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const card = CARD_KINDS.includes(value.card as CardKind)
    ? (value.card as CardKind)
    : fallback;
  const id = value.connectionId;
  const connectionId =
    typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  const uuid =
    typeof value.uuid === "string" && UUID.test(value.uuid) ? value.uuid : null;
  return { card, connectionId, uuid };
}

/** GET /connections/:id/overview: resource counts and servers. */
export interface ConnectionOverview {
  connectionId: number;
  /** By health, Parts left out (exited is stopped). */
  counts: ResourceCounts;
  /** Resources counted, Parts left out. */
  total: number;
  /** Null when the token can't read servers. */
  servers: { total: number; unreachable: number; unusable: number } | null;
  fetchedAt: string;
}

/** Coolify's security statuses, as the summary counts them. */
export interface VulnerabilityStatuses {
  updateNow: number;
  updateAvailable: number;
  noFix: number;
  checkNeeded: number;
  ok: number;
  notChecked: number;
}

/** GET /connections/:id/vulnerabilities: counts only, no names. */
export interface VulnerabilitySummary {
  connectionId: number;
  /** Resources Coolify listed. */
  resources: number;
  /** Resources with known problems: update now, update available or no fix. */
  affected: number;
  statuses: VulnerabilityStatuses;
  problems: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    exploited: number;
  };
  fetchedAt: string;
}
